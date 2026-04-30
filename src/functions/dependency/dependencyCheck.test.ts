import { describe, expect, it, vi } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { UserError } from '../errors.js';

const { runRequiredMock } = vi.hoisted(() => ({
  runRequiredMock: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
}));

vi.mock('../platform/shell.js', () => ({
  runRequired: runRequiredMock,
  runCommand: vi.fn()
}));

import { runScopedObsidianCommand } from '../../mcp/obsidianCommandRuntime.js';

const baseConfig = appConfigSchema.parse({
  folderStructure: {
    attachments: 'i0',
    noteLibrary: 'n0',
    publish: 'p0',
    projectScope: 'j0',
    sharedScope: 'k0'
  }
});

describe('runScopedObsidianCommand vault scope', () => {
  it('drops vault param when it matches the session vault', async () => {
    runRequiredMock.mockClear();
    await runScopedObsidianCommand({
      config: baseConfig,
      vaultName: 'obsidian-vault-alpha',
      command: 'read',
      params: { path: 'n0/j0/a.md', vault: 'obsidian-vault-alpha' }
    });
    const args = runRequiredMock.mock.calls[0]?.[1] as string[];
    expect(args.filter(a => a.startsWith('vault='))).toEqual(['vault=obsidian-vault-alpha']);
  });

  it('throws when vault param targets a different vault', async () => {
    await expect(
      runScopedObsidianCommand({
        config: baseConfig,
        vaultName: 'obsidian-vault-alpha',
        command: 'read',
        params: { path: 'n0/j0/a.md', vault: 'other-vault' }
      })
    ).rejects.toThrow(UserError);

    await expect(
      runScopedObsidianCommand({
        config: baseConfig,
        vaultName: 'obsidian-vault-alpha',
        command: 'read',
        params: { path: 'n0/j0/a.md', vault: 'other-vault' }
      })
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects vault= in flags', async () => {
    await expect(
      runScopedObsidianCommand({
        config: baseConfig,
        vaultName: 'obsidian-vault-alpha',
        command: 'read',
        params: { path: 'n0/j0/a.md' },
        flags: ['vault=evil']
      })
    ).rejects.toThrow(/not allowed/);
  });
});
