import process from 'node:process';
let source = '';
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source);
if (input.task.description === 'exit') process.exit(3);
if (input.task.description === 'large') { process.stdout.write('x'.repeat(20000)); process.exit(0); }
if (input.task.description === 'invalid') { process.stdout.write('{}'); process.exit(0); }
process.stdout.write(JSON.stringify({ contractVersion: '2.0', executionId: input.task.description === 'wrong' ? '0'.repeat(32) : input.executionId,
  taskId: input.task.id, taskVersion: input.task.version, status: 'success',
  summary: process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY ? 'credential-leak' : 'credential-free', artifacts: [], error: null }) + '\n');
