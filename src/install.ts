export type InstallOptions = {
  ref: string; harnessRef: string; deploy: boolean; deployTrigger: 'checks' | 'push';
  deployAfter: string[]; deployEnvironment: string; deployPath: string;
};

/** Removes the trigger block of the deploy wrapper that does not apply (marker comments included). */
function selectTrigger(content: string, trigger: 'checks' | 'push') {
  const drop = trigger === 'checks' ? 'push' : 'checks';
  return content
    .replace(new RegExp(`^[ \\t]*# sf:trigger-${drop}:start[\\s\\S]*?# sf:trigger-${drop}:end\\n`, 'm'), '')
    .replace(new RegExp(`^[ \\t]*# sf:trigger-${trigger}:(?:start ?|end\\n)`, 'gm'), match => match.includes(':start') ? match.replace(/sf:trigger-\w+:start ?/, '') : '');
}

/** Fills installation placeholders in a template. */
export function renderTemplate(name: string, content: string, options: InstallOptions): string {
  if (!/^[a-f0-9]{40}$/.test(options.ref)) throw new Error('Install ref must be a 40 character commit SHA');
  if (!/^[a-f0-9]{40}$/.test(options.harnessRef)) throw new Error('Harness ref must be a 40 character commit SHA');
  if (!options.deployAfter.length || options.deployAfter.some(w => !w.trim() || /["\n]/.test(w))) throw new Error('Invalid --deploy-after workflow name');
  if (!/^[A-Za-z0-9 ._-]{1,100}$/.test(options.deployEnvironment)) throw new Error('Invalid --deploy-environment');
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(options.deployPath) || options.deployPath.split('/').includes('..')) throw new Error('Invalid --deploy-path');
  const rendered = (name === 'factory-deploy.yml' ? selectTrigger(content, options.deployTrigger) : content)
    .replaceAll('FACTORY_COMMIT_SHA', options.ref).replaceAll('HARNESS_COMMIT_SHA', options.harnessRef)
    .replaceAll('DEPLOY_ENABLED', String(options.deploy)).replaceAll('DEPLOY_TRIGGER', options.deployTrigger)
    .replaceAll('DEPLOY_AFTER_WORKFLOWS', options.deployAfter.map(w => JSON.stringify(w)).join(', '))
    .replaceAll('DEPLOY_WORKFLOWS', JSON.stringify(options.deployAfter))
    .replaceAll('DEPLOY_ENVIRONMENT', options.deployEnvironment).replaceAll('DEPLOY_PATH', options.deployPath);
  return rendered;
}

export const factoryPinToken = '__SF_FACTORY_COMMIT__';
export type InstallationContract = {
  formatVersion: 1; factoryVersion: string; schemaPath: string;
  harness: { repository: string; ref: string; contractVersion: string };
  migrations: { automatic: boolean; notes: string };
  variants: Record<string, { files: Record<string, string>; coding: boolean; manager: boolean; deploy: boolean }>;
};

/** Release data only: consumers substitute one validated commit token, never execute repository code. */
export function installationContract(templates: Record<string, string>, factoryVersion: string,
  harness: InstallationContract['harness'], overrides: Partial<InstallOptions> = {}): InstallationContract {
  const variants: InstallationContract['variants'] = {};
  for (const coding of [false, true]) for (const manager of [false, true]) for (const deploy of [false, true]) {
    const name = `${manager ? (coding ? 'coding' : 'manager') : (coding ? 'coding-config' : 'config')}${deploy ? '-deploy' : ''}`;
    const options: InstallOptions = { deployTrigger: 'checks', deployAfter: ['Test'], deployEnvironment: 'production',
      deployPath: '/opt/app', ...overrides, ref: 'f'.repeat(40), harnessRef: harness.ref, deploy };
    variants[name] = { coding, manager, deploy, files: Object.fromEntries(installFiles(coding, manager, deploy).map(([source, path]) => {
      if (typeof templates[source] !== 'string') throw new Error(`Missing installation template: ${source}`);
      return [path, renderTemplate(source, templates[source], options).replaceAll(options.ref, factoryPinToken)];
    })) };
  }
  return { formatVersion: 1, factoryVersion, schemaPath: 'schemas/config.schema.json', harness,
    migrations: { automatic: false, notes: 'Compare configuration schemas and preserve local workflow edits; no implicit configuration migration.' }, variants };
}

/** The CLI and control planes share this conservative create-only plan. */
export function planInstallation(contract: InstallationContract, variant: string, ref: string, existing: Record<string, string> = {}) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('Install ref must be a 40 character commit SHA');
  const selected = contract.variants[variant];
  if (!selected) throw new Error('Unsupported installation variant');
  return Object.entries(selected.files).map(([path, template]) => ({ path,
    content: template.replaceAll(factoryPinToken, ref), disposition: path in existing ? 'preserve' as const : 'create' as const }));
}

/** Template → destination pairs for an installation. */
export function installFiles(coding: boolean, manager: boolean, deploy: boolean): [string, string][] {
  return [
    [coding ? 'software-factory-coding.yml' : 'software-factory.yml', '.github/software-factory.yml'],
    ...(manager ? [[coding ? 'factory-manager-coding.yml' : 'factory-manager.yml', '.github/workflows/factory-manager.yml'] as [string, string]] : []),
    ...(deploy ? [['factory-deploy.yml', '.github/workflows/factory-deploy.yml'] as [string, string]] : [])
  ];
}
