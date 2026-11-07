import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { configSchema, loadConfig } from './config/index.js';
import { GitHubClient } from './github/client.js';
import { Manager } from './manager/index.js';
import { MockPlanner, OpenAIPlanner } from './llm/provider.js';
import { summary } from './manager/report.js';
import { executeDelegation } from './workers/execute-delegation.js';
import { HarnessProcessClient } from './workers/harness-client.js';
import { SlackSink, deliverNotifications } from './notifications/slack.js';
import { CodingRepository } from './github/coding.js';
import { prepareCoding, publishCoding } from './workers/coding.js';
import { GitHubMergePort } from './merge/github.js';
import { OpenAIMergeReviewer } from './merge/reviewer.js';
import { MergeManager } from './merge/manager.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repository: { type: 'string' }, 'config-path': { type: 'string', default: '.github/software-factory.yml' },
    file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    'allow-local-writes': { type: 'boolean', default: false }, issue: { type: 'string' }, execution: { type: 'string' }
  } });
  const command = positionals[0] ?? 'manager';
  if (command === 'validate') {
    if (!values.file) throw new Error('validate requires --file');
    loadConfig(await readFile(values.file, 'utf8'));
    console.log('Configuration valid'); return;
  }
  if (!['manager', 'merge', 'notify', 'check-slack', 'worker', 'bootstrap', 'prepare-coding', 'publish-coding'].includes(command)) throw new Error('Supported commands: manager, merge, notify, check-slack, worker, bootstrap, validate, prepare-coding, publish-coding');
  const repository = values.repository ?? process.env.GITHUB_REPOSITORY ?? '';
  const github = new GitHubClient(repository, process.env.GITHUB_TOKEN ?? '');
  let config = loadConfig(await github.readConfig(values['config-path']!));
  if (values['dry-run']) config = configSchema.parse({ ...config, execution: { ...config.execution, dryRun: true } });
  if (!config.factory.enabled) {
    console.log(JSON.stringify({ outcome: 'disabled' }));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Software Factory\n\nGlobally disabled. No repository changes.\n');
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true' && !values['allow-local-writes'] && !config.execution.dryRun && config.autonomy.profile !== 'advisory') {
    throw new Error('Local mutations require --allow-local-writes and an exclusive operator session; prefer the serialized GitHub workflow');
  }
  const correlationId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : randomUUID();
  const timer = setTimeout(() => { console.error(JSON.stringify({ correlationId, error: 'Hard execution time limit reached; next run will recover durable state' })); process.exit(1); }, (command === 'worker' ? config.execution.workerTimeoutMinutes : config.manager.timeoutMinutes) * 60000);
  timer.unref();
  try {
    if (command === 'merge') {
      if (!config.merge.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log(JSON.stringify({ outcome: 'merge-disabled' })); return;
      }
      const report = await new MergeManager(new GitHubMergePort(repository, process.env.GITHUB_TOKEN ?? '', config.factory.scope, config.merge.adoptLabel),
        config, new OpenAIMergeReviewer(process.env.OPENAI_API_KEY ?? '', config), correlationId, github).run(await github.snapshot(config.manager.workflow));
      console.log(JSON.stringify({ correlationId, ...report }));
      if (report.errors.length) process.exitCode = 1;
      return;
    }
    if (command === 'check-slack') {
      if (!config.notifications.slack.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log('Slack connection check skipped in mutation-free or disabled mode'); return;
      }
      await new SlackSink(process.env.SLACK_BOT_TOKEN ?? '').checkConnection();
      console.log(JSON.stringify({ correlationId, slackConnection: 'verified', configuredChannel: config.notifications.slack.channel })); return;
    }
    if (command === 'notify') {
      const errors = await deliverNotifications(github, config, await github.snapshot(config.manager.workflow),
        new SlackSink(process.env.SLACK_BOT_TOKEN ?? ''), correlationId, new Date());
      console.log(JSON.stringify({ correlationId, outcome: errors.length ? 'partial' : 'success', errors }));
      if (errors.length) process.exitCode = 1;
      return;
    }
    if (command === 'bootstrap') {
      if (config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log('Mutation-free mode: bootstrap skipped'); return;
      }
      console.log(JSON.stringify({ correlationId, createdLabels: await github.bootstrap() })); return;
    }
    if (['worker', 'prepare-coding', 'publish-coding'].includes(command)) {
      const issue = values.issue ?? process.env.HARNESS_ISSUE_NUMBER ?? '';
      const id = values.execution ?? process.env.HARNESS_EXECUTION_ID ?? '';
      if (!/^[1-9]\d*$/.test(issue) || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid worker issue or execution ID');
      if (command === 'prepare-coding') {
        const prepared = await prepareCoding(github, config, new CodingRepository(repository, process.env.GITHUB_TOKEN ?? ''), Number(issue), id, correlationId);
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, prepared
          ? `ready=true\nrequest=${JSON.stringify(prepared.request)}\nbase-sha=${prepared.base.sha}\nbase-branch=${prepared.base.branch}\n`
          : 'ready=false\n');
        console.log(JSON.stringify({ executionId: id, ready: !!prepared })); return;
      }
      if (command === 'publish-coding') {
        let artifact: unknown = null;
        if (process.env.SF_ARTIFACT) {
          const source = await readFile(process.env.SF_ARTIFACT, 'utf8').catch(() => 'null');
          if (Buffer.byteLength(source) <= 7000000) { try { artifact = JSON.parse(source); } catch { /* Persist failed result below. */ } }
        }
        const result = await publishCoding(github, config, new CodingRepository(repository, process.env.GITHUB_TOKEN ?? ''),
          Number(issue), id, correlationId, { sha: process.env.SF_BASE_SHA ?? '', branch: process.env.SF_BASE_BRANCH ?? '' }, artifact);
        console.log(JSON.stringify({ executionId: id, status: result.status, artifacts: result.artifacts }));
        if (result.status === 'failed') process.exitCode = 1;
        return;
      }
      const result = await executeDelegation(github, config, Number(issue), id, correlationId,
        new HarnessProcessClient(process.env.HARNESS_ENTRYPOINT ?? ''));
      console.log(JSON.stringify({ correlationId, executionId: result.executionId, status: result.status })); return;
    }
    const planner = config.llm.provider === 'mock' ? new MockPlanner() : new OpenAIPlanner(process.env.OPENAI_API_KEY ?? '');
    const report = await new Manager(github, config, planner, { correlationId,
      notifications: new SlackSink(process.env.SLACK_BOT_TOKEN ?? '') }).run();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(report));
    console.log(JSON.stringify({ correlationId, outcome: report.outcome, tasks: report.tasks,
      executed: report.decisions.filter(d => d.executed).length, errors: report.errors, nextSteps: report.nextSteps }));
    if (report.errors.length) process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
export async function handleError(error: unknown): Promise<void> {
  // Config errors are safe; API/request objects are deliberately never printed.
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Slack connection failed: check SLACK_BOT_TOKEN and Slack app installation$|Invalid factory configuration|Invalid YAML|Supported commands|validate requires|Local mutations|Invalid worker|OPENAI_API_KEY|GITHUB_TOKEN|Repository must|Configuration must)/.test(message)
    ? message : 'Harness failed. Check repository access, contents:read, issues:write, pull-requests:read and actions:write permissions and installed default-branch workflow.';
  const httpStatus = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : null;
  const category = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) : 'UnknownError';
  console.error(JSON.stringify({ error: safe, category, httpStatus }));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `# Software Factory failed\n\n${safe.replace(/[<>`]/g, '')}\n\nCategory: ${category}; HTTP: ${httpStatus ?? 'n/a'}\n`).catch(() => {});
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(handleError);
