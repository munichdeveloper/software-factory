import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import requestContract from './contracts/request.schema.json' with { type: 'json' };
import resultContract from './contracts/result.schema.json' with { type: 'json' };
import { workerInputSchema, workerResultSchema, type WorkerInput, type WorkerResult } from './contract.js';

export interface HarnessPort { execute(input: WorkerInput): Promise<WorkerResult> }
interface RuntimeResult { contractVersion: '2.0'; executionId: string; taskId: string; taskVersion: string;
  status: WorkerResult['status'] | 'timed_out'; summary: string; artifacts: string[]; error: string | null }
const ajv = new Ajv2020({ strict: false });
const validateRequest = ajv.compile(requestContract);
const validateResult = ajv.compile<RuntimeResult>(resultContract);

export class HarnessProcessClient implements HarnessPort {
  constructor(private entrypoint: string) {
    if (!isAbsolute(entrypoint)) throw new Error('HARNESS_ENTRYPOINT must be an absolute path to the pinned Harness CLI');
  }
  async execute(value: WorkerInput): Promise<WorkerResult> {
    const input = workerInputSchema.parse(value);
    const taskId = `github:${input.repository}#${input.issueNumber}`;
    const request = { contractVersion: '2.0', executionId: input.executionId, worker: 'test',
      task: { id: taskId, version: input.taskVersion, description: input.description,
        acceptanceCriteria: input.acceptanceCriteria, contextReferences: input.contextReferences },
      allowedActions: ['run_test_operation'], limits: { timeoutMs: input.limits.timeoutMinutes * 60000, maxOutputBytes: input.limits.maxOutputBytes }, operation: input.operation };
    if (!validateRequest(request)) throw new Error('Delegation cannot be represented by Harness contract 2.0');
    const raw = await new Promise<string>((resolve, reject) => {
      // No GitHub/OpenAI credentials, NODE_OPTIONS, shell or target code enters the runtime process.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
      const child = spawn(process.execPath, [this.entrypoint, 'run'], { env, windowsHide: true, shell: false });
      let output = '', exceeded = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Harness process deadline exceeded')); }, request.limits.timeoutMs + 10000);
      child.stdout.setEncoding('utf8'); child.stderr.resume(); child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > input.limits.maxOutputBytes + 1) { exceeded = true; child.kill('SIGKILL'); }
      });
      child.on('error', () => { clearTimeout(timer); reject(new Error('Harness process could not start')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 || exceeded) reject(new Error('Harness process failed or exceeded output limit'));
        else resolve(output);
      });
      child.stdin.end(JSON.stringify(request));
    });
    const result: unknown = JSON.parse(raw);
    if (!validateResult(result) || result.executionId !== input.executionId || result.taskId !== taskId || result.taskVersion !== input.taskVersion) {
      throw new Error('Harness result failed schema or correlation validation');
    }
    return workerResultSchema.parse({ contractVersion: '1.0', executionId: result.executionId, issueNumber: input.issueNumber,
      status: result.status === 'timed_out' ? 'failed' : result.status, summary: result.summary,
      artifacts: result.artifacts, error: result.error, proposedActions: [] });
  }
}
