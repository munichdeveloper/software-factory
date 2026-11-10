import { describe, expect, it } from 'vitest';
import { authorizeReadyLabel } from '../src/runtime/ready-approval.js';
import { issue, clock } from './helpers.js';
import type { BlockLabelEvent } from '../src/types.js';
const event = (id = 1, actor = 'maintainer', kind: 'labeled' | 'unlabeled' = 'labeled'): BlockLabelEvent => ({ id, actor, event: kind, createdAt: clock.toISOString() });
const permission = async (actor: string) => actor === 'maintainer';
describe('native ready-label authorization', () => {
  it('requires a real event from a currently authorized human, not the presence of a label alone', async () => {
    await expect(authorizeReadyLabel(issue(), [], permission, [])).rejects.toThrow('READY_APPROVAL_REQUIRED');
    await expect(authorizeReadyLabel(issue(), [event(1, 'stranger')], permission, [])).rejects.toThrow('READY_ACTOR_NOT_AUTHORIZED');
    expect(await authorizeReadyLabel(issue(), [event()], permission, [])).toMatchObject({eventId:1,actor:'maintainer'});
  });
  it('preserves only the exact grant across the trusted Manager transition to running', async () => {
    const proof=await authorizeReadyLabel(issue(),[event()],permission,[]), running=issue(1,['harness:managed','harness:running']);
    expect(await authorizeReadyLabel(running,[event(),event(2,'manager[bot]','unlabeled')],permission,['manager[bot]'],proof)).toEqual(proof);
    await expect(authorizeReadyLabel(running,[event(),event(2,'maintainer','unlabeled')],permission,['manager[bot]'],proof)).rejects.toThrow('READY_APPROVAL_REVOKED');
    await expect(authorizeReadyLabel(issue(),[event(),event(3)],permission,[],proof)).rejects.toThrow('READY_APPROVAL_CHANGED');
    await expect(authorizeReadyLabel(running,[event(),event(2,'manager[bot]','unlabeled')],permission,['manager[bot]'])).rejects.toThrow('READY_APPROVAL_REVOKED');
  });
  it('fails closed after closure, permission loss or unmanaged state', async () => {
    const task=issue();task.state='closed';await expect(authorizeReadyLabel(task,[event()],permission,[])).rejects.toThrow('READY_APPROVAL_REQUIRED');
    await expect(authorizeReadyLabel(issue(),[event()],async()=>false,[])).rejects.toThrow('READY_ACTOR_NOT_AUTHORIZED');
    await expect(authorizeReadyLabel(issue(1,['harness:ready']),[event()],permission,[])).rejects.toThrow('READY_APPROVAL_REQUIRED');
  });
});
