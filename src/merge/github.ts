import { Octokit } from '@octokit/rest';
import type { MergeFacts, MergePort, ReviewInput } from './contract.js';

export class GitHubMergePort implements MergePort {
  private api: Octokit;
  private target: { owner: string; repo: string };
  constructor(readonly repository: string, token: string, private scope: string, private adoptLabel = 'sf:automerge', fetcher: typeof fetch = fetch) {
    const [owner, repo] = repository.split('/') as [string, string]; this.target = { owner, repo };
    this.api = new Octokit({ auth: token, request: { timeout: 30000, fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  async candidates() {
    const { data: prs } = await this.api.pulls.list({ ...this.target, state: 'all', sort: 'updated', direction: 'desc', per_page: 100 });
    return prs.filter(p => p.labels.some(l => l.name === this.adoptLabel) || p.head.ref.startsWith('sf/issue-'))
      .sort((a, b) => Number(b.labels.some(l => l.name === this.adoptLabel)) - Number(a.labels.some(l => l.name === this.adoptLabel)) || a.number - b.number)
      .map(p => p.number);
  }
  async facts(number: number): Promise<MergeFacts> {
    const [{ data: pr }, { data: repo }, comments] = await Promise.all([
      this.api.pulls.get({ ...this.target, pull_number: number }), this.api.repos.get(this.target),
      this.api.paginate(this.api.issues.listComments, { ...this.target, issue_number: number, per_page: 100 })
    ]);
    const [ref, rules, checks, statuses, graph] = await Promise.all([
      this.api.git.getRef({ ...this.target, ref: `heads/${repo.default_branch}` }),
      this.api.paginate(this.api.repos.getBranchRules, { ...this.target, branch: repo.default_branch, per_page: 100 }),
      this.api.paginate(this.api.checks.listForRef, { ...this.target, ref: pr.head.sha, filter: 'latest', per_page: 100 }),
      this.api.paginate(this.api.repos.listCommitStatusesForRef, { ...this.target, ref: pr.head.sha, per_page: 100 }),
      this.api.graphql<{ repository: { pullRequest: { mergeStateStatus: string; reviewDecision: string | null; mergedBy: { __typename: string } | null;
        reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { body: string }[] } }[]; pageInfo: { hasNextPage: boolean } } } } }>(`
        query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
          mergeStateStatus reviewDecision mergedBy { __typename } reviewThreads(first:100) { nodes { isResolved comments(first:10) { nodes { body } } } pageInfo { hasNextPage } }
        } } }`, { ...this.target, number })
    ]);
    const native = graph.repository.pullRequest;
    if (native.reviewThreads.pageInfo.hasNextPage) throw new Error('Too many review threads to verify');
    const required = rules.filter(r => r.type === 'required_status_checks');
    const latestStatuses = new Map<string, string>();
    for (const status of statuses) if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status.state);
    return { number, title: pr.title, body: pr.body ?? '', head: pr.head.sha, base: ref.data.object.sha,
      headBranch: pr.head.ref, baseBranch: pr.base.ref, state: pr.state, draft: pr.draft ?? false,
      sameRepository: pr.head.repo?.full_name.toLowerCase() === this.repository.toLowerCase() && pr.base.ref === repo.default_branch,
      labels: pr.labels.map(l => l.name ?? ''), mergeState: native.mergeStateStatus, reviewDecision: native.reviewDecision,
      unresolvedThreads: native.reviewThreads.nodes.filter(t => !t.isResolved).map(t => t.comments.nodes.map(c => c.body).join('\n')),
      mergeSha: pr.merged ? pr.merge_commit_sha : null, mergeActorType: native.mergedBy?.__typename ?? null,
      checks: [...checks.map(c => ({ name: c.name, state: c.status === 'completed' ? c.conclusion ?? 'unknown' : c.status })),
        ...[...latestStatuses].map(([name, state]) => ({ name, state }))],
      strictChecks: required.some(r => r.parameters?.strict_required_status_checks_policy) && rules.some(r => r.type === 'pull_request'),
      nativeRequiredChecks: required.flatMap(r => r.parameters?.required_status_checks.map(c => c.context) ?? []),
      comments: comments.map(c => ({ id: c.id, author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at })) };
  }
  async context(facts: MergeFacts, maxFiles: number, maxBytes: number): Promise<ReviewInput> {
    // Compare immutable commit IDs, not a mutable pull-request diff endpoint.
    const { data: comparison } = await this.api.repos.compareCommitsWithBasehead({ ...this.target, basehead: `${facts.base}...${facts.head}`, per_page: 1 });
    const files = comparison.files ?? [];
    if (!files.length || files.length > maxFiles) throw new Error('Change set exceeds review file limit');
    const read = async (path: string, ref: string, optional = false): Promise<string> => {
      try {
        const { data } = await this.api.repos.getContent({ ...this.target, path, ref });
        if (!('content' in data) || data.encoding !== 'base64' || data.size > maxBytes) throw new Error('File cannot be reviewed completely');
        const bytes = Buffer.from(data.content, 'base64');
        if (bytes.includes(0)) throw new Error('Binary file cannot be reviewed');
        return bytes.toString('utf8');
      } catch (error) { if (optional && error instanceof Error && 'status' in error && error.status === 404) return ''; throw error; }
    };
    const instructions = await read('AGENTS.md', facts.base, true);
    const changes: ReviewInput['changes'] = [];
    for (const file of files) {
      if (!file.patch) throw new Error('Diff is incomplete or contains binary changes');
      const content = file.status === 'removed' ? await read(file.filename, facts.base) : await read(file.filename, facts.head);
      changes.push({ path: file.filename, status: file.status, patch: file.patch, content });
      if (Buffer.byteLength(JSON.stringify({ facts: { ...facts, comments: [] }, instructions, changes })) > maxBytes) throw new Error('Review context exceeds limit; no truncated approval');
    }
    return { facts, trustedScope: this.scope, trustedInstructions: instructions, changes };
  }
  async comment(number: number, body: string) { await this.api.issues.createComment({ ...this.target, issue_number: number, body }); }
  async update(number: number, head: string) {
    await this.api.pulls.updateBranch({ ...this.target, pull_number: number, expected_head_sha: head });
    // GitHub updates asynchronously. Never dispatch tests for the previous head.
    for (let i = 0; i < 15; i++) {
      const { data } = await this.api.pulls.get({ ...this.target, pull_number: number });
      if (data.head.sha !== head) return data.head.sha;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Branch update pending; next run will recover');
  }
  async merge(number: number, head: string, method: 'squash' | 'merge' | 'rebase') {
    const { data } = await this.api.pulls.merge({ ...this.target, pull_number: number, sha: head, merge_method: method });
    if (!data.merged || !data.sha) throw new Error('GitHub did not confirm merge');
    return data.sha;
  }
  async dispatch(workflow: string, ref: string) { await this.api.actions.createWorkflowDispatch({ ...this.target, workflow_id: workflow, ref }); }
  async canApprove(login: string) {
    try { return ['admin', 'maintain', 'write'].includes((await this.api.repos.getCollaboratorPermissionLevel({ ...this.target, username: login })).data.permission); }
    catch { return false; }
  }
}
