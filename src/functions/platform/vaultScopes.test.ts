import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { checkReadablePath, checkWritableProjectPath, defaultProjectNotePath, normalizeVaultRelativePath } from './vaultScopes.js';

const minimal = appConfigSchema.parse({
  repoPrefix: 'obsidian-vault-',
  commonProjectName: 'common',
  commonConfigured: false,
  copyFromCommon: [],
  projectVaults: {},
  github: { createRemotes: false, hostname: 'github.com' },
  server: { host: '127.0.0.1', preferredPort: 57891 },
  codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' },
  cliBootstrap: {
    preferredPort: 57891,
    githubHostname: 'github.com',
    createRemotes: false
  }
});

describe('vaultScopes', () => {
  it('classifies paths under the common mount as common', () => {
    expect(checkReadablePath(minimal, 'common/Shared.md')).toMatchObject({ scope: 'common' });
    expect(checkReadablePath(minimal, 'common')).toMatchObject({ scope: 'common' });
    expect(checkReadablePath(minimal, 'Notes/a.md')).toMatchObject({ scope: 'project' });
  });

  it('rejects writes under the common mount', () => {
    expect(() => checkWritableProjectPath(minimal, 'common/x.md')).toThrow(/read-only/);
    expect(checkWritableProjectPath(minimal, 'Notes/x.md')).toBe('Notes/x.md');
  });

  it('defaultProjectNotePath returns normalized vault-relative paths', () => {
    expect(defaultProjectNotePath(minimal, 'x/a.md')).toBe('x/a.md');
  });

  it('normalizeVaultRelativePath rejects traversal', () => {
    expect(() => normalizeVaultRelativePath('../etc/passwd')).toThrow();
  });
});
