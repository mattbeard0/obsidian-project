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
  repoPrefix: 'obsidian-vault-',
  commonProjectName: 'common',
  commonConfigured: false,
  copyFromCommon: [],
  projectVaults: {},
  github: { createRemotes: false, hostname: 'github.com' },
  server: { host: '127.0.0.1', preferredPort: 57891 },
  codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' }
});

describe('runScopedObsidianCommand vault scope', () => {
  it('drops vault param when it matches the session vault', async () => {
    runRequiredMock.mockClear();
    await runScopedObsidianCommand({
      config: baseConfig,
      vaultName: 'obsidian-vault-alpha',
      command: 'read',
      params: { path: 'Notes/a.md', vault: 'obsidian-vault-alpha' }
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
        params: { path: 'Notes/a.md', vault: 'other-vault' }
      })
    ).rejects.toThrow(UserError);

    await expect(
      runScopedObsidianCommand({
        config: baseConfig,
        vaultName: 'obsidian-vault-alpha',
        command: 'read',
        params: { path: 'Notes/a.md', vault: 'other-vault' }
      })
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects vault= in flags', async () => {
    await expect(
      runScopedObsidianCommand({
        config: baseConfig,
        vaultName: 'obsidian-vault-alpha',
        command: 'read',
        params: { path: 'Notes/a.md' },
        flags: ['vault=evil']
      })
    ).rejects.toThrow(/not allowed/);
  });
});
