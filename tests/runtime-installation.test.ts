import { expect, it } from 'vitest';
import { temporalInstallationVariant } from '../src/runtime/installation.js';
import { executorWrapper } from '../src/runtime/coding-executor.js';
import { loadConfig } from '../src/config/index.js';
it('ships the exact validator-aware executor as release data and keeps fresh installations inactive', () => {
  const harness = 'a'.repeat(40), sha = 'b'.repeat(40), variant = temporalInstallationVariant(harness);
  const config = loadConfig(variant.files['.github/software-factory.yml']!);
  expect(config.execution.engine).toBe('temporal'); expect(config.factory.enabled).toBe(false);
  expect(config.deploy.enabled).toBe(false); expect(config.merge.enabled).toBe(false);
  expect(config.workers.coding && config.workers.coding.enabled).toBe(true);
  expect(variant.files['.github/workflows/factory-manager.yml']!.replaceAll('__SF_FACTORY_COMMIT__', sha)).toBe(executorWrapper(sha,harness,true));
  expect(variant.files['.github/workflows/factory-manager.yml']).not.toContain('schedule:');
  expect(variant.files['.github/workflows/factory-manager.yml']).not.toContain('FACTORY_RUNTIME_TOKEN');
});
