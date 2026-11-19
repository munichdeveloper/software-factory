import { expect, it } from 'vitest';
import { blockedOnProtectedPath, protectedPathBlockReason, protectedPathRequests } from '../src/state/protected-paths.js';

it('finds the protected paths and CI jobs a task asks for', () => {
  expect(protectedPathRequests('Add a step to `.github/workflows/test.yml`.')).toEqual(['.github/workflows/test.yml']);
  expect(protectedPathRequests('- Eigenes Maven-Profil und eigener CI-Job, damit der Testlauf schnell bleibt.')).toEqual(['eigener CI-Job']);
  expect(protectedPathRequests('Update AGENTS.md and CODEOWNERS, and .claude/settings.json')).toEqual(['AGENTS.md', 'CODEOWNERS', '.claude/settings.json']);
  expect(protectedPathRequests('Add a new GitHub Actions workflow for releases')).toEqual(['new GitHub Actions workflow']);
});
it('lets ordinary files and mentions pass', () => {
  expect(protectedPathRequests('Ignore build output in `.gitignore` and `.gitattributes`.')).toEqual([]);
  expect(protectedPathRequests('Der Test läuft in CI grün. See docs/github.md and src/agents.ts.')).toEqual([]);
  expect(protectedPathRequests('n8n workflow JSON under src/workflows/test.yml')).toEqual([]);
});
it('ignores what a task explicitly leaves out', () => {
  expect(protectedPathRequests('## Umfang\n- Fix\n\n## Nicht enthalten\n- Ein neuer CI-Job in `.github/workflows`\n\n## Acceptance criteria\n- ok')).toEqual([]);
  expect(protectedPathRequests('Nicht enthalten: Änderungen an `.github/`.')).toEqual([]);
  // Wording of real tasks (Backofficer#62, controla#124).
  expect(protectedPathRequests('- `AGENTS.md` beachten: vor dem Schreiben von Code die Anleitungen lesen.')).toEqual([]);
  expect(protectedPathRequests('- Keine Änderungen an `.github/`, Secrets, Abhängigkeiten oder produktiven Daten.')).toEqual([]);
  expect(protectedPathRequests('- **Nicht ändern:** `AGENTS.md`, `.github/` (Workflows), `.claude/`. Einen CI-Job ergänzen wir danach von Hand.')).toEqual([]);
  expect(protectedPathRequests('Do not touch .github/workflows.')).toEqual([]);
  expect(protectedPathRequests('Den Job in `.github/workflows/test.yml` ändern wir selbst.')).toEqual([]);
  expect(protectedPathRequests('## Out of scope\n- .github\n## Scope\n- edit .github/dependabot.yml')).toEqual(['.github/dependabot.yml']);
});
it('names the requests in the block reason', () => {
  expect(protectedPathBlockReason('CI', 'Add `.github/workflows/ci.yml`')).toBe('Task requires changes to protected paths the coding worker may not edit (`.github/workflows/ci.yml`)');
  expect(protectedPathBlockReason('Fix login', 'Fix the bug.')).toBeUndefined();
});
it('recognises a worker that stopped at a protected path, but not an offline-only block', () => {
  const blocked = (summary: string, error: string | null = null) => ({ status: 'blocked', summary, error });
  expect(blockedOnProtectedPath(blocked('Blocker: the job must go in .github/workflows/test.yml, and I\'m not allowed to edit .github/.'))).toBe(true);
  expect(blockedOnProtectedPath(blocked('Done.', 'PROTECTED_PATH_REQUIRED'))).toBe(true);
  expect(blockedOnProtectedPath(blocked('Could not run the tests offline; CI in .github/workflows runs them.'))).toBe(false);
  expect(blockedOnProtectedPath({ status: 'success', summary: 'not allowed .github', error: null })).toBe(false);
});
