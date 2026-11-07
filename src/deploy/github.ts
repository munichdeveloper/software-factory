import { Octokit } from '@octokit/rest';

export type CheckRun = { name: string; event: string; status: string; conclusion: string | null; createdAt: string };
export type DeploymentState = 'in_progress' | 'success' | 'failure' | 'error';
export interface DeployPort {
  defaultBranch(): Promise<{ name: string; sha: string }>;
  workflowRuns(sha: string): Promise<CheckRun[]>;
  createDeployment(sha: string, environment: string, description: string): Promise<number>;
  setDeploymentStatus(id: number, state: DeploymentState, description: string, logUrl?: string): Promise<void>;
}

export class GitHubDeployPort implements DeployPort {
  private api: Octokit;
  private target: { owner: string; repo: string };
  constructor(repository: string, token: string, fetcher: typeof fetch = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be owner/name');
    if (!token) throw new Error('GITHUB_TOKEN is required');
    const [owner, repo] = repository.split('/') as [string, string];
    this.target = { owner, repo };
    this.api = new Octokit({ auth: token, request: { timeout: 30000, fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  async defaultBranch() {
    const { data: repo } = await this.api.repos.get(this.target);
    const { data: ref } = await this.api.git.getRef({ ...this.target, ref: `heads/${repo.default_branch}` });
    return { name: repo.default_branch, sha: ref.object.sha };
  }
  async workflowRuns(sha: string) {
    const rows = await this.api.paginate(this.api.actions.listWorkflowRunsForRepo, { ...this.target, head_sha: sha, per_page: 100 });
    return rows.map(r => ({ name: r.name ?? '', event: r.event, status: r.status ?? 'unknown', conclusion: r.conclusion, createdAt: r.created_at }));
  }
  async createDeployment(sha: string, environment: string, description: string) {
    const { data } = await this.api.repos.createDeployment({ ...this.target, ref: sha, environment, description,
      auto_merge: false, required_contexts: [], production_environment: environment === 'production' });
    if (!('id' in data)) throw new Error('Deployment record was not created');
    return data.id;
  }
  async setDeploymentStatus(id: number, state: DeploymentState, description: string, logUrl?: string) {
    await this.api.repos.createDeploymentStatus({ ...this.target, deployment_id: id, state,
      description: description.slice(0, 140), ...(logUrl ? { log_url: logUrl } : {}), auto_inactive: state === 'success' });
  }
}
