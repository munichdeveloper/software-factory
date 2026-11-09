import type { GitHubPort } from '../github/port.js';

/** Additional broker capability boundary for canary tasks in an existing repository. */
export class IssueScopedGitHub implements GitHubPort {
  readonly repository: string;
  private allowed: Set<number>;
  constructor(private source: GitHubPort, issueNumbers: number[]) {
    if (!issueNumbers.length || issueNumbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('INVALID_ISSUE_SCOPE');
    this.allowed = new Set(issueNumbers); this.repository = source.repository;
  }
  private check(number: number) { if (!this.allowed.has(number)) throw new Error('ISSUE_OUTSIDE_RUNTIME_SCOPE'); }
  readConfig(path: string) { return this.source.readConfig(path); }
  async snapshot(workflow: string | null) {
    if (workflow !== null) throw new Error('LEGACY_DISPATCH_FORBIDDEN_IN_SCOPED_RUNTIME');
    const snapshot = await this.source.snapshot(null);
    return { ...snapshot, issues: snapshot.issues.filter(i => this.allowed.has(i.number)),
      comments: new Map([...snapshot.comments].filter(([number]) => this.allowed.has(number))) };
  }
  getIssue(number: number) { this.check(number); return this.source.getIssue(number); }
  comments(number: number) { this.check(number); return this.source.comments(number); }
  canApprove(login: string) { return this.source.canApprove(login); }
  writeEvent(number: number, event: Parameters<GitHubPort['writeEvent']>[1]) { this.check(number); return this.source.writeEvent(number, event); }
  updateIssue(number: number, update: Parameters<GitHubPort['updateIssue']>[1]) { this.check(number); return this.source.updateIssue(number, update); }
  async createIssue(): Promise<never> { throw new Error('ISSUE_CREATION_FORBIDDEN_IN_SCOPED_RUNTIME'); }
  async bootstrap(): Promise<never> { throw new Error('BOOTSTRAP_FORBIDDEN_IN_SCOPED_RUNTIME'); }
  async dispatch(): Promise<never> { throw new Error('LEGACY_DISPATCH_FORBIDDEN_IN_SCOPED_RUNTIME'); }
  async runs(): Promise<never> { throw new Error('LEGACY_DISPATCH_FORBIDDEN_IN_SCOPED_RUNTIME'); }
  async cancelRun(): Promise<never> { throw new Error('LEGACY_DISPATCH_FORBIDDEN_IN_SCOPED_RUNTIME'); }
}
