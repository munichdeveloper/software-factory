import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { codingArtifactSchema, validateChanges, type CodingArtifact } from '../workers/coding.js';
import type { RunSnapshot } from './contract.js';
import type { EffectPort } from './effects.js';
import { hash } from '../state/identity.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const objectReceipt = z.strictObject({ sha });
const prReceipt = z.strictObject({ number: z.number().int().positive(), url: z.url(), head: sha });
const commentReceipt = z.strictObject({ id: z.number().int().positive() });
const missing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404;

/** Trusted broker only: validates artifacts and publishes API data, never executes target code. */
export class RuntimeCodingPublisher {
  constructor(private api: Octokit, private effects: EffectPort, private authorize: () => Promise<unknown>, private trustedActors: string[]) {}
  async publish(snapshot: RunSnapshot, source: unknown, createdAt: string) {
    const artifact: CodingArtifact = codingArtifactSchema.parse(source), input = snapshot.admission.input;
    if (input.worker !== 'codex' || artifact.baseSha !== snapshot.baseSha || artifact.result.executionId !== input.executionId ||
      artifact.result.taskVersion !== snapshot.specHash || artifact.result.taskId !== `github:${snapshot.repository}#${input.issueNumber}` ||
      artifact.result.status !== 'success' || !artifact.changes.length) throw new Error('UNRELATED_OR_UNSUCCESSFUL_ARTIFACT');
    validateChanges(artifact); z.iso.datetime().parse(createdAt);
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo };
    const live = (await this.api.repos.get(target)).data;
    if (live.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const branch = `sf/issue-${input.issueNumber}/${input.executionId}`, baseBranch = snapshot.baseRef ?? live.default_branch;
    const authorize = async () => {
      await this.authorize();
      if ((await this.api.git.getRef({ ...target, ref: `heads/${baseBranch}` })).data.object.sha !== snapshot.baseSha) throw new Error('BASE_MOVED');
    };
    await authorize();
    const parent = (await this.api.git.getCommit({ ...target, commit_sha: snapshot.baseSha })).data;
    const entries = (await this.api.git.getTree({ ...target, tree_sha: parent.tree.sha, recursive: '1' })).data;
    if (entries.truncated) throw new Error('BASE_TREE_TRUNCATED');
    const tree: { path: string; mode: '100644' | '100755'; type: 'blob'; sha: string | null }[] = [];
    for (const change of [...artifact.changes].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = change.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const ancestor = entries.tree.find(e => e.path === parts.slice(0, i).join('/'));
        if (ancestor && ancestor.type !== 'tree') throw new Error('NON_DIRECTORY_BASE_ANCESTOR');
      }
      const previous = entries.tree.find(e => e.path === change.path);
      if (previous && (previous.type !== 'blob' || !['100644', '100755'].includes(previous.mode ?? ''))) throw new Error('NON_REGULAR_BASE_FILE');
      let blob: string | null = null;
      if (change.content === null) { if (!previous) throw new Error('DELETE_MISSING_FILE'); }
      else {
        const bytes = Buffer.from(change.content, 'base64'), expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const receipt = await this.effects.perform({ key: `blob:${expected}`, payload: { sha: expected }, authorize,
          contentAddressed: true, validate: objectReceipt.parse,
          reconcile: async () => { try { const value = (await this.api.git.getBlob({ ...target, file_sha: expected })).data;
            if (value.sha !== expected || Buffer.from(value.content.replaceAll('\n', ''), 'base64').compare(bytes)) throw new Error('BLOB_CONFLICT'); return { sha: expected };
          } catch (error) { if (missing(error)) return null; throw error; } },
          apply: async () => { const value = (await this.api.git.createBlob({ ...target, content: change.content!, encoding: 'base64' })).data;
            if (value.sha !== expected) throw new Error('BLOB_CONFLICT'); return { sha: value.sha }; } });
        blob = receipt.sha;
      }
      tree.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob });
    }
    const newTree = await this.effects.perform({ key: 'tree', payload: { base: parent.tree.sha, tree }, authorize, contentAddressed: true,
      validate: objectReceipt.parse, reconcile: async () => null,
      apply: async () => ({ sha: (await this.api.git.createTree({ ...target, base_tree: parent.tree.sha, tree })).data.sha }) });
    if (newTree.sha === parent.tree.sha) throw new Error('NO_CHANGES');
    const fingerprint = hash(artifact), message = `Implement #${input.issueNumber} with Codex\n\nSF execution: ${input.executionId}\nBinding: ${hash(snapshot)}\nArtifact: ${fingerprint}`;
    // Explicit immutable author/committer dates make retries content-addressed, even after a lost response.
    const identity = { name: 'Software Factory', email: 'software-factory@users.noreply.github.com', date: createdAt };
    const commitInput = { message, tree: newTree.sha, parents: [snapshot.baseSha], author: identity, committer: identity };
    const commit = await this.effects.perform({ key: 'commit', payload: commitInput, authorize, contentAddressed: true,
      validate: objectReceipt.parse, reconcile: async () => null,
      apply: async () => ({ sha: (await this.api.git.createCommit({ ...target, ...commitInput })).data.sha }) });
    await this.effects.perform({ key: 'branch', payload: { branch, sha: commit.sha }, authorize, validate: objectReceipt.parse,
      reconcile: async () => { try { const existing = (await this.api.git.getRef({ ...target, ref: `heads/${branch}` })).data;
        if (existing.object.sha !== commit.sha) throw new Error('EXECUTION_BRANCH_CONFLICT'); return { sha: existing.object.sha };
      } catch (error) { if (missing(error)) return null; throw error; } },
      apply: async () => { const value = (await this.api.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha: commit.sha })).data;
        if (value.object.sha !== commit.sha) throw new Error('EXECUTION_BRANCH_CONFLICT'); return { sha: value.object.sha }; } });
    const marker = `<!-- sf-publication:${snapshot.repositoryId}:${input.executionId}:${hash(snapshot)}:${fingerprint} -->`;
    const summary = artifact.result.summary.replaceAll('@', '＠').replaceAll('<', '&lt;').replaceAll('>', '&gt;').split('\n').map(line => `> ${line}`).join('\n');
    const body = `Closes #${input.issueNumber}\n\n${summary}\n\n${marker}\n\nReview changes and required checks before merging.`;
    const title = `Implement #${input.issueNumber} with Codex`;
    const pr = await this.effects.perform({ key: 'draft-pr', payload: { baseBranch, branch, head: commit.sha, title, body, draft: true }, authorize,
      validate: prReceipt.parse, reconcile: async () => {
        const prs = await this.api.paginate(this.api.pulls.list, { ...target, state: 'all', head: `${owner}:${branch}`, base: baseBranch, per_page: 100 });
        if (prs.length > 1) throw new Error('MULTIPLE_EXECUTION_PRS');
        const value = prs[0]; if (!value) return null;
        if (value.head.sha !== commit.sha || value.body !== body || value.title !== title || !value.draft || value.state !== 'open' || value.merged_at ||
          !this.trustedActors.includes(value.user?.login ?? '')) throw new Error('EXECUTION_PR_CONFLICT');
        return { number: value.number, url: value.html_url, head: value.head.sha };
      }, apply: async () => {
        const value = (await this.api.pulls.create({ ...target, base: baseBranch, head: branch, title, body, draft: true })).data;
        if (value.head.sha !== commit.sha || !value.draft) throw new Error('EXECUTION_PR_CONFLICT');
        return { number: value.number, url: value.html_url, head: value.head.sha };
      } });
    const journal = `Draft PR: ${pr.url}\nHead: ${pr.head}\n${marker}`;
    await this.effects.perform({ key: 'publication-comment', payload: { issue: input.issueNumber, body: journal }, authorize,
      validate: commentReceipt.parse, reconcile: async () => {
        const matches = (await this.api.paginate(this.api.issues.listComments, { ...target, issue_number: input.issueNumber, per_page: 100 }))
          .filter(c => c.body?.includes(marker));
        if (matches.length > 1) throw new Error('MULTIPLE_PUBLICATION_COMMENTS');
        const value = matches[0]; if (!value) return null;
        if (value.body !== journal || !this.trustedActors.includes(value.user?.login ?? '')) throw new Error('PUBLICATION_COMMENT_CONFLICT');
        return { id: value.id };
      }, apply: async () => ({ id: (await this.api.issues.createComment({ ...target, issue_number: input.issueNumber, body: journal })).data.id }) });
    return pr;
  }
}
