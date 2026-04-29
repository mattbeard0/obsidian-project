import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config/schema.js';
import { checkReadablePath, checkWritableProjectPath, defaultProjectNotePath, normalizeVaultRelativePath } from './paths.js';

const config = appConfigSchema.parse({
  vaultRoot: '/tmp/knowledge'
});

describe('path policy', () => {
  it('blocks traversal and absolute paths', () => {
    expect(() => normalizeVaultRelativePath('../secret.md')).toThrow();
    expect(() => normalizeVaultRelativePath('/tmp/secret.md')).toThrow();
    expect(() => normalizeVaultRelativePath('C:\\secret.md')).toThrow();
  });

  it('allows reads from project and common wiki scopes', () => {
    expect(checkReadablePath(config, 'wiki/project/a.md')).toMatchObject({ scope: 'project' });
    expect(checkReadablePath(config, 'wiki/common/a.md')).toMatchObject({ scope: 'common' });
    expect(checkReadablePath(config, 'wiki')).toMatchObject({ scope: 'visible-root' });
  });

  it('allows writes only inside project wiki', () => {
    expect(checkWritableProjectPath(config, 'wiki/project/a.md')).toBe('wiki/project/a.md');
    expect(() => checkWritableProjectPath(config, 'wiki/common/a.md')).toThrow(/read-only/);
  });

  it('defaults bare note paths into the project wiki', () => {
    expect(defaultProjectNotePath(config, 'notes/a.md')).toBe('wiki/project/notes/a.md');
  });
});
