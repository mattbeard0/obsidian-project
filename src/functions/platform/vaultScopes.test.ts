import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { checkReadablePath, checkWritableProjectPath, defaultProjectNotePath, normalizeVaultRelativePath } from './vaultScopes.js';

const config = appConfigSchema.parse({
  folderStructure: {
    attachments: 'i0',
    noteLibrary: 'n0',
    publish: 'p0',
    projectScope: 'j0',
    sharedScope: 'k0'
  }
});

describe('vaultScopes', () => {
  it('blocks traversal and absolute paths', () => {
    expect(() => normalizeVaultRelativePath('../secret.md')).toThrow();
    expect(() => normalizeVaultRelativePath('/tmp/secret.md')).toThrow();
    expect(() => normalizeVaultRelativePath('C:\\secret.md')).toThrow();
  });

  it('allows reads from project and common scopes', () => {
    expect(checkReadablePath(config, 'n0/j0/a.md')).toMatchObject({ scope: 'project' });
    expect(checkReadablePath(config, 'n0/k0/a.md')).toMatchObject({ scope: 'common' });
    expect(checkReadablePath(config, 'n0')).toMatchObject({ scope: 'visible-root' });
  });

  it('allows writes only inside project scope', () => {
    expect(checkWritableProjectPath(config, 'n0/j0/a.md')).toBe('n0/j0/a.md');
    expect(() => checkWritableProjectPath(config, 'n0/k0/a.md')).toThrow(/read-only/);
  });

  it('defaults bare note paths into the project scope', () => {
    expect(defaultProjectNotePath(config, 'x/a.md')).toBe('n0/j0/x/a.md');
  });
});
