import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../src/config/index.js';
import { planSchema } from '../src/types.js';
import { workerInputSchema, workerResultSchema } from '../src/workers/contract.js';
import { eventSchema } from '../src/state/events.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({ config: configSchema, plan: planSchema, 'worker-input': workerInputSchema, 'worker-result': workerResultSchema, event: eventSchema })) {
  await writeFile(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema, { io: name === 'config' ? 'input' : 'output' }), null, 2) + '\n');
}
