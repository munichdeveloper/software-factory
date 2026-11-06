import { expect, it } from 'vitest';
import { summary } from '../src/manager/report.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { proposal } from '../src/llm/provider.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';
it('renders actionable counts and escapes untrusted summary strings', () => {
  const github = new MemoryGitHub(); github.state.issues.push(issue());
  const task = reconstruct(github.state, config(), clock)[0]!;
  const text = summary({ correlationId: 'run-1', startedAt: clock.toISOString(), durationMs: 100, outcome: 'success', tasks: 1,
    decisions: [{ action: proposal(task, 'start_worker', 'ready'), decision: { actionId: 'a'.repeat(64), outcome: 'allow', reason: '<script> | x\ny' }, executed: true }],
    blockers: ['<b>blocked</b>'], errors: [], nextSteps: [] });
  expect(text).toContain('Workers started: 1'); expect(text).not.toContain('<script>'); expect(text).toContain('100ms');
});
