import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { configSchema } from '../src/config/index.js';
import { z } from 'zod';

describe('published config schema matches accepted runtime input', () => {
  const ajv = new Ajv2020({ strict: false });
  const schema = z.toJSONSchema(configSchema, { io: 'input' });
  const validate = ajv.compile(schema);
  it.each([
    { version: 1, factory: { scope: 'minimal input' } },
    { version: 1, factory: { scope: 'partial sections' }, manager: { maxActions: 3 }, autonomy: { overrides: { start_worker: 'deny' } } },
    { version: 1, factory: { scope: 'test' }, execution: {} },
    { version: 1, factory: { scope: 'test' }, unknown: true },
    { version: 1, factory: { scope: 'test' }, manager: { maxActions: 0 } },
    { version: 1, factory: { scope: 'test' }, workers: { coding: true } },
    { version: 1, factory: {} },
    { version: 1, factory: { scope: 'test' }, llm: { provider: 'static' } },
    { version: 1, factory: { scope: 'test' }, llm: { provider: 'mock' } },
    { version: 1, factory: { scope: 'test' }, llm: { provider: 'other' } }
  ])('accepts/rejects the same input as Zod: %j', input => {
    expect(validate(input)).toBe(configSchema.safeParse(input).success);
  });
  it('publishes the accepted input shape rather than the normalized output shape', async () => {
    const published = JSON.parse(await readFile(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'));
    expect(published).toEqual(schema);
    expect(ajv.compile(published)({ version: 1, factory: { scope: 'test' } })).toBe(true);
  });
});

describe('llm.provider static (SF #200)', () => {
  const parse = (llm?: object) => configSchema.parse({ version: 1, factory: { scope: 'test' }, ...(llm ? { llm } : {}) }).llm.provider;
  it('defaults to static', () => expect(parse()).toBe('static'));
  it('reads the former name mock as static', () => expect(parse({ provider: 'mock' })).toBe('static'));
  it('keeps static and openai', () => {
    expect(parse({ provider: 'static' })).toBe('static');
    expect(parse({ provider: 'openai' })).toBe('openai');
  });
});
