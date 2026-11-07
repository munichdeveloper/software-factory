import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { loadConfig } from '../src/config/index.js';
import { installFiles, renderTemplate, type InstallOptions } from '../src/install.js';

const options: InstallOptions = { ref: 'f'.repeat(40), harnessRef: 'e'.repeat(40), deploy: true, deployTrigger: 'checks',
  deployAfter: ['Application checks'], deployEnvironment: 'production', deployPath: '/opt/backofficer' };
const template = (name: string) => readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');

describe('installation templates', () => {
  it.each(['software-factory.yml', 'software-factory-coding.yml'])('%s stays a valid configuration with and without deployment', async name => {
    const disabled = loadConfig(renderTemplate(name, await template(name), { ...options, deploy: false }));
    expect(disabled.deploy.enabled).toBe(false);
    const enabled = loadConfig(renderTemplate(name, await template(name), options));
    expect(enabled.deploy).toMatchObject({ enabled: true, trigger: 'checks', workflows: ['Application checks'], path: '/opt/backofficer', environment: 'production' });
    // Existing behaviour is untouched by the new section.
    expect(enabled.merge.enabled).toBe(false);
    expect(enabled.notifications.slack.enabled).toBe(false);
  });
  it('renders the deploy wrapper for the checks trigger', async () => {
    const workflow = parseDocument(renderTemplate('factory-deploy.yml', await template('factory-deploy.yml'), options)).toJS();
    expect(workflow.on.workflow_run.workflows).toEqual(['Application checks']);
    expect(workflow.on).not.toHaveProperty('push');
    expect(workflow.jobs.deploy.environment).toBe('production');
    expect(workflow.jobs.deploy.steps[0].uses).toBe(`munichdeveloper/software-factory@${options.ref}`);
  });
  it('renders the deploy wrapper for the push trigger', async () => {
    const rendered = renderTemplate('factory-deploy.yml', await template('factory-deploy.yml'), { ...options, deployTrigger: 'push' });
    const workflow = parseDocument(rendered).toJS();
    expect(Object.keys(workflow.on)).toEqual(['push', 'workflow_dispatch']);
    expect(rendered).not.toContain('sf:trigger');
  });
  it('rejects unsafe installation values', () => {
    expect(() => renderTemplate('x', '', { ...options, ref: 'main' })).toThrow('40 character');
    expect(() => renderTemplate('x', '', { ...options, deployAfter: ['a"b'] })).toThrow('--deploy-after');
    expect(() => renderTemplate('x', '', { ...options, deployAfter: [] })).toThrow('--deploy-after');
    expect(() => renderTemplate('x', '', { ...options, deployEnvironment: 'a\nb' })).toThrow('--deploy-environment');
    expect(() => renderTemplate('x', '', { ...options, deployPath: '/opt/../etc' })).toThrow('--deploy-path');
  });
  it('selects the files to install', () => {
    expect(installFiles(false, true, false)).toEqual([['software-factory.yml', '.github/software-factory.yml'], ['factory-manager.yml', '.github/workflows/factory-manager.yml']]);
    expect(installFiles(true, false, true)).toEqual([['software-factory-coding.yml', '.github/software-factory.yml'], ['factory-deploy.yml', '.github/workflows/factory-deploy.yml']]);
  });
});

it('publishes the exact CLI renderer as data, preserving existing files', async () => {
  const { installationContract, planInstallation } = await import('../src/install.js');
  const names = ['software-factory.yml', 'software-factory-coding.yml', 'factory-manager.yml', 'factory-manager-coding.yml', 'factory-deploy.yml'];
  const templates = Object.fromEntries(await Promise.all(names.map(async n => [n, await template(n)])));
  const contract = installationContract(templates, 'test', { repository: 'munichdeveloper/dev-agent-harness', ref: options.harnessRef, contractVersion: '2.0' }, options);
  for (const [variant, selected] of Object.entries(contract.variants)) {
    const plan = planInstallation(contract, variant, options.ref, { '.github/software-factory.yml': 'custom' });
    expect(plan[0]?.disposition).toBe('preserve');
    for (const [source, path] of installFiles(selected.coding, selected.manager, selected.deploy)) {
      expect(plan.find(p => p.path === path)?.content).toBe(renderTemplate(source, templates[source]!, { ...options, deploy: selected.deploy }));
    }
  }
  expect(() => planInstallation(contract, 'manager', 'main')).toThrow();
  expect(() => planInstallation(contract, 'unknown', options.ref)).toThrow();
});
