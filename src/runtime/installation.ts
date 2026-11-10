import { configSchema } from '../config/index.js';
import { executorWrapper } from './coding-executor.js';
import { defaultValidationPlan } from './validation-contract.js';
import { factoryPinToken, type InstallationContract } from '../install.js';

/** Data-only opt-in variant. Runtime credentials never belong in target workflows. */
export function temporalInstallationVariant(harnessSha: string): InstallationContract['variants'][string] {
  const placeholder = 'f'.repeat(40);
  const config = configSchema.parse({ version: 1, factory: { enabled: false, scope: 'Implement explicitly authorized managed issues and publish review Draft PRs.' },
    manager: { trustedActors: ['github-actions[bot]'] },
    execution: { engine: 'temporal' }, llm: { provider: 'mock' },
    autonomy: { profile: 'autonomous', overrides: { merge_pr: 'deny', close_issue: 'deny', create_followup: 'deny', expand_scope: 'deny' } },
    workers: { test: { enabled: false }, coding: { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null } },
    merge: { enabled: false }, deploy: { enabled: false } });
  return { coding: true, manager: true, deploy: false, files: {
    '.github/software-factory.yml': JSON.stringify(config, null, 2) + '\n',
    '.github/workflows/factory-manager.yml': executorWrapper(placeholder, harnessSha, true).replaceAll(placeholder, factoryPinToken),
    '.github/software-factory.validation.json': JSON.stringify(defaultValidationPlan(), null, 2) + '\n',
  } };
}
