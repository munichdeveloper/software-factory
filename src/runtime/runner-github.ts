import type { Octokit } from '@octokit/rest';
import { runnerLabel, runnerVariable, type RunnerJob, type RunnerRepositoryPort } from './runners.js';

const status = (error: unknown) => error && typeof error === 'object' && 'status' in error ? error.status : undefined;

/**
 * The runner fallback's view of one repository. `actions` reads runs and re-runs jobs; `admin` is a token limited to
 * this repository with Administration and Variables write only (just-in-time runners, SF_RUNNER).
 */
export function runnerRepository(repositoryId: number, repository: string, actions: Octokit, admin: Octokit): RunnerRepositoryPort {
  const [owner, repo] = repository.split('/') as [string, string];
  return {
    repositoryId, repository,
    isPrivate: async () => (await actions.repos.get({ owner, repo })).data.private,
    variable: async () => {
      try {
        const data = (await admin.request('GET /repos/{owner}/{repo}/actions/variables/{name}', { owner, repo, name: runnerVariable })).data;
        return { value: data.value, updatedAt: data.updated_at };
      } catch (error) { if (status(error) === 404) return null; throw error; }
    },
    setVariable: async value => {
      if (value === null) {
        try { await admin.request('DELETE /repos/{owner}/{repo}/actions/variables/{name}', { owner, repo, name: runnerVariable }); }
        catch (error) { if (status(error) !== 404) throw error; }
        return;
      }
      try { await admin.request('PATCH /repos/{owner}/{repo}/actions/variables/{name}', { owner, repo, name: runnerVariable, value }); }
      catch (error) {
        if (status(error) !== 404) throw error;
        await admin.request('POST /repos/{owner}/{repo}/actions/variables', { owner, repo, name: runnerVariable, value });
      }
    },
    runs: async (since, runStatus) => (await actions.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 50,
      created: `>=${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}`, ...(runStatus ? { status: runStatus } : {}) })).data.workflow_runs
      .map(r => ({ id: r.id, status: r.status ?? '', conclusion: r.conclusion ?? null, createdAt: r.created_at })),
    jobs: async runId => (await actions.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, filter: 'latest', per_page: 100 })).data.jobs
      .map((j): RunnerJob => ({ id: j.id, runId, status: j.status, conclusion: j.conclusion ?? null, labels: j.labels,
        runnerId: j.runner_id ?? null, steps: j.steps?.length ?? 0, startedAt: j.started_at ?? null, completedAt: j.completed_at ?? null })),
    rerunFailedJobs: async runId => { await actions.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId }); },
    jitConfig: async name => (await admin.request('POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig', { owner, repo, name,
      runner_group_id: 1, labels: [runnerLabel], work_folder: 'work' })).data.encoded_jit_config,
  };
}
