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

/** Template → destination pairs for an installation. */
export function installFiles(coding: boolean, manager: boolean, deploy: boolean): [string, string][] {
  return [
    [coding ? 'software-factory-coding.yml' : 'software-factory.yml', '.github/software-factory.yml'],
    ...(manager ? [[coding ? 'factory-manager-coding.yml' : 'factory-manager.yml', '.github/workflows/factory-manager.yml'] as [string, string]] : []),
    ...(deploy ? [['factory-deploy.yml', '.github/workflows/factory-deploy.yml'] as [string, string]] : [])
  ];
}
