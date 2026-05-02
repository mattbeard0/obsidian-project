import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigSchema } from '../config/config.js';

const mockFindDrift = vi.fn();
const mockRepair = vi.fn();
const mockFormat = vi.fn();

vi.mock('../functions/vaults/vaults.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../functions/vaults/vaults.js')>();
  return {
    ...actual,
    findCommonMountDrift: (...args: unknown[]) => mockFindDrift(...args),
    formatMountDriftReport: (...args: unknown[]) => mockFormat(...args),
    repairCommonMounts: (...args: unknown[]) => mockRepair(...args)
  };
});

import { ensureMountsBeforeServerStart } from './interactive.js';

const baseConfig = appConfigSchema.parse({
  repoPrefix: 'obsidian-vault-',
  commonProjectName: 'common',
  commonConfigured: true,
  copyFromCommon: [],
  projectVaults: {},
  github: { createRemotes: false, hostname: 'github.com' },
  server: { host: '127.0.0.1', preferredPort: 57891 },
  codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFormat.mockReturnValue('drift-report');
});

describe('ensureMountsBeforeServerStart', () => {
  it('returns when there is no drift', async () => {
    mockFindDrift.mockResolvedValue([]);

    await expect(ensureMountsBeforeServerStart(baseConfig)).resolves.toBeUndefined();
    expect(mockRepair).not.toHaveBeenCalled();
  });

  it('repairs mounts when repairMounts is true', async () => {
    const drift = [
      {
        project: 'alpha',
        mountPath: '/proj/n0/k0',
        expectedTarget: '/common/n0',
        reason: 'missing' as const
      }
    ];
    mockFindDrift.mockResolvedValue(drift);

    await ensureMountsBeforeServerStart(baseConfig, { repairMounts: true });

    expect(mockRepair).toHaveBeenCalledWith(baseConfig, drift);
  });
});
