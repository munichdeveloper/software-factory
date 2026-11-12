import { Octokit } from '@octokit/rest';
import type { GitHubPort } from './port.js';
import type { BlockLabelEvent, Comment, Issue, PullRequest, Snapshot, WorkflowRun } from '../types.js';
import { authorizeReadyLabel } from '../runtime/ready-approval.js';
import type { ReadyApproval } from '../runtime/contract.js';
import { allLabels, dependencies, managedLabel } from '../state/lifecycle.js';
import { encodeEvent, type HarnessEvent } from '../state/events.js';

type RawIssue = { number: number; title: string; body?: string | null; state: string; labels: (string | { name?: string })[]; updated_at: string; created_at?: string; user?: { type?: string } | null };
const normalizeIssue = (i: RawIssue): Issue => ({ number: i.number, title: i.title, body: i.body ?? '',
  state: i.state === 'closed' ? 'closed' : 'open', labels: i.labels.map(l => typeof l === 'string' ? l : l.name ?? ''), updatedAt: i.updated_at,
  createdAt: i.created_at, authorType: i.user?.type });
type PRNode = { number: number; state: string; merged: boolean; mergedAt: string | null; body: string; title?: string;
  headRefName?: string; headRefOid?: string; mergedBy?: { login: string; __typename: string } | null;
  closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[]; pageInfo: { hasNextPage: boolean } } };

const settledAfterMs = 48 * 60 * 60 * 1000;
export class GitHubClient implements GitHubPort {
  private api: Octokit;
  private target: { owner: string; repo: string };
  constructor(readonly repository: string, token: string, timeoutMs = 30000, fetcher: typeof fetch = fetch, api?: Octokit) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be owner/name');
    if (!token && !api) throw new Error('GITHUB_TOKEN is required');
    const [owner, repo] = repository.split('/') as [string, string];
    this.target = { owner, repo };
    this.api = api ?? new Octokit({ auth: token, request: { timeout: timeoutMs, fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  async readConfig(path: string, ref?: string): Promise<string> {
    if (!/^\.github\/[\w./-]+\.ya?ml$/.test(path) || path.includes('..')) throw new Error('Configuration must be a YAML file under .github/');
    const { data: repo } = await this.api.repos.get(this.target);
    const { data } = await this.api.repos.getContent({ ...this.target, path, ref: ref ?? repo.default_branch });
    if (!('content' in data) || data.encoding !== 'base64') throw new Error(`Cannot read config ${path}`);
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  async getIssue(number: number): Promise<Issue> {
    const { data } = await this.api.issues.get({ ...this.target, issue_number: number });
    if (data.pull_request) throw new Error(`#${number} is a pull request, not a task`);
    const issue = normalizeIssue(data);
    return issue.labels.includes(managedLabel) ? this.withTimeline(issue) : issue;
  }
  private async withTimeline(issue: Issue): Promise<Issue> {
    const timeline = await this.api.paginate(this.api.issues.listEventsForTimeline, { ...this.target, issue_number: issue.number, per_page: 100 });
    const reopenings = timeline.flatMap(e => e.event === 'reopened' && 'created_at' in e && typeof e.created_at === 'string' ? [e.created_at] : []);
    issue.reopenedAt = reopenings.sort().at(-1);
    issue.blockedLabelEvents = timeline.flatMap(e => {
      if ((e.event !== 'labeled' && e.event !== 'unlabeled') || !('label' in e) || e.label?.name !== 'harness:blocked' ||
          !('id' in e) || typeof e.id !== 'number' || !('created_at' in e) || typeof e.created_at !== 'string') return [];
      return [{ id: e.id, event: e.event as 'labeled' | 'unlabeled', actor: 'actor' in e ? e.actor?.login ?? '' : '', createdAt: e.created_at }];
    });
    return issue;
  }
  async comments(number: number): Promise<Comment[]> {
    const rows = await this.api.paginate(this.api.issues.listComments, { ...this.target, issue_number: number, per_page: 100 });
    return rows.map(c => ({ id: c.id, body: c.body ?? '', author: c.user?.login ?? '', createdAt: c.created_at }));
  }
  async canApprove(login: string): Promise<boolean> {
    try {
      const { data } = await this.api.repos.getCollaboratorPermissionLevel({ ...this.target, username: login });
      return ['admin', 'maintain', 'write'].includes(data.permission);
    } catch { return false; }
  }
  async readyApproval(number: number, trustedActors: string[], expected?: ReadyApproval, rework?: ReadyApproval): Promise<ReadyApproval> {
    const issue = await this.getIssue(number);
    const timeline = await this.api.paginate(this.api.issues.listEventsForTimeline, { ...this.target, issue_number: number, per_page: 100 });
    const events: BlockLabelEvent[] = timeline.flatMap(e => {
      if ((e.event !== 'labeled' && e.event !== 'unlabeled') || !('label' in e) || e.label?.name !== 'harness:ready' ||
        !('id' in e) || typeof e.id !== 'number' || !('created_at' in e) || typeof e.created_at !== 'string') return [];
      return [{ id: e.id, event: e.event as 'labeled' | 'unlabeled', actor: 'actor' in e ? e.actor?.login ?? '' : '', createdAt: e.created_at }];
    });
    return authorizeReadyLabel(issue, events, actor => this.canApprove(actor), trustedActors, expected, rework);
  }
  async runs(workflow: string): Promise<WorkflowRun[]> {
    const rows = await this.api.paginate(this.api.actions.listWorkflowRuns, { ...this.target, workflow_id: workflow, event: 'workflow_dispatch', per_page: 100 });
    return rows.map(r => ({ id: r.id, title: r.display_title ?? '', status: r.status ?? 'unknown', conclusion: r.conclusion,
      createdAt: r.created_at, url: r.html_url }));
  }
  private async pullRequests(): Promise<PullRequest[]> {
    const result: PullRequest[] = [];
    let cursor: string | null = null;
    do {
      const data: { repository: { pullRequests: { nodes: PRNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } } = await this.api.graphql(`
        query($owner:String!, $repo:String!, $cursor:String) {
          repository(owner:$owner, name:$repo) {
            pullRequests(first:50, after:$cursor, orderBy:{field:UPDATED_AT,direction:DESC}) {
              nodes { number state merged mergedAt body title headRefName headRefOid mergedBy { login __typename } closingIssuesReferences(first:100) {
                nodes { number repository { nameWithOwner } } pageInfo { hasNextPage }
              }} pageInfo { hasNextPage endCursor }
            }
          }
        }`, { ...this.target, cursor });
      const connection = data.repository.pullRequests;
      for (const pr of connection.nodes) {
        if (pr.closingIssuesReferences.pageInfo.hasNextPage) throw new Error(`PR #${pr.number} has over 100 closing links; refusing incomplete reconciliation`);
        result.push({ number: pr.number, state: pr.state === 'OPEN' ? 'open' : 'closed', merged: pr.merged, mergedAt: pr.mergedAt ?? undefined,
          title: pr.title, headRefName: pr.headRefName, headSha: pr.headRefOid, mergedBy: pr.mergedBy ? {
            login: pr.mergedBy.__typename === 'Bot' && !pr.mergedBy.login.endsWith('[bot]') ? `${pr.mergedBy.login}[bot]` : pr.mergedBy.login,
            type: pr.mergedBy.__typename } : undefined,
          closingIssues: pr.closingIssuesReferences.nodes.filter(i => i.repository.nameWithOwner.toLowerCase() === this.repository.toLowerCase()).map(i => i.number),
          referencedIssues: [...pr.body.matchAll(/(?<![\w/])#(\d+)\b/g)].map(m => Number(m[1])) });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return result;
  }
  async snapshot(workflow: string | null): Promise<Snapshot> {
    const [{ data: repo }, rows, prs, runs] = await Promise.all([
      this.api.repos.get(this.target),
      this.api.paginate(this.api.issues.listForRepo, { ...this.target, labels: managedLabel, state: 'all', per_page: 100 }),
      this.pullRequests(), workflow === null ? Promise.resolve([]) : this.runs(workflow)
    ]);
    if (!repo.has_issues) throw new Error('GitHub Issues must be enabled');
    // Repository push is contents-write, not issues/actions-write. A least-privilege
    // GITHUB_TOKEN intentionally has push=false; concrete APIs enforce their own scopes.
    const issues = rows.filter(i => !i.pull_request).map(normalizeIssue);
    // Native label events identify the current block; comments alone cannot prove its origin.
    // A task closed and untouched for two days is settled: its journal cannot change what the Manager does, and
    // reading the timeline and comments of every task ever closed on each reconciliation is what exhausts the
    // installation's rate limit as a repository ages. Any write to such an issue makes it current again.
    const current = issues.filter(i => i.state === 'open' || Date.now() - Date.parse(i.updatedAt) < settledAfterMs);
    // The timeline answers reopening and blocking questions, which only an open task raises.
    for (const issue of current) if (issue.state === 'open') await this.withTimeline(issue);
    const comments = new Map<number, Comment[]>(issues.map(i => [i.number, []]));
    for (const issue of current) comments.set(issue.number, await this.comments(issue.number));
    const dependencyStates = new Map<number, boolean>();
    for (const n of new Set(issues.flatMap(i => dependencies(i.body)))) {
      try { dependencyStates.set(n, (await this.getIssue(n)).state === 'closed'); }
      catch { dependencyStates.set(n, false); }
    }
    return { issues, comments, prs, runs, defaultBranch: repo.default_branch, dependencyStates };
  }
  async writeEvent(issue: number, event: HarnessEvent): Promise<void> {
    await this.api.issues.createComment({ ...this.target, issue_number: issue, body: encodeEvent(event) });
  }
  async writeComment(issue: number, body: string, id?: number): Promise<void> {
    if (id === undefined) await this.api.issues.createComment({ ...this.target, issue_number: issue, body });
    else await this.api.issues.updateComment({ ...this.target, comment_id: id, body });
  }
  async updateIssue(issue: number, update: { labels?: string[]; state?: 'open' | 'closed' }): Promise<void> {
    await this.api.issues.update({ ...this.target, issue_number: issue, ...update });
  }
  async createIssue(title: string, body: string, labels: string[]): Promise<Issue> {
    return normalizeIssue((await this.api.issues.create({ ...this.target, title, body, labels })).data);
  }
  async bootstrap(): Promise<string[]> {
    const existing = await this.api.paginate(this.api.issues.listLabelsForRepo, { ...this.target, per_page: 100 });
    const created: string[] = [];
    for (const name of allLabels) {
      if (existing.some(l => l.name === name)) continue;
      try {
        await this.api.issues.createLabel({ ...this.target, name, color: name === managedLabel ? '5319e7' : 'ededed', description: `Software Factory ${name.replace(/^(harness|sf):/, '')}` });
        created.push(name);
      } catch (error) {
        // Another bootstrap can create a label between list and create.
        if (!(error instanceof Error && 'status' in error && error.status === 422)) throw error;
        const labels = await this.api.paginate(this.api.issues.listLabelsForRepo, { ...this.target, per_page: 100 });
        if (!labels.some(l => l.name === name)) throw error;
      }
    }
    return created;
  }
  async dispatch(workflow: string, ref: string, id: string, issue: number): Promise<void> {
    // A timeout is ambiguous: callers must keep the durable intent and never blindly retry this request.
    await this.api.actions.createWorkflowDispatch({ ...this.target, workflow_id: workflow, ref,
      inputs: { mode: 'worker', execution_id: id, issue_number: String(issue) } });
  }
  async cancelRun(id: number): Promise<void> {
    await this.api.actions.cancelWorkflowRun({ ...this.target, run_id: id });
  }
}
