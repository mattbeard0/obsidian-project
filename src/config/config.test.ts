import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, persistedAppConfigSchema, saveConfig } from './config.js';

describe('config.json', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-cfg-'));
    prev = process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    process.env.OBSIDIAN_PROJECT_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (prev === undefined) {
      delete process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    } else {
      process.env.OBSIDIAN_PROJECT_CONFIG_DIR = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('loadConfig reads persisted settings', async () => {
    const configDir = process.env.OBSIDIAN_PROJECT_CONFIG_DIR!;
    const configJson = {
      repoPrefix: 'obsidian-vault-',
      commonProjectName: 'common',
      commonConfigured: true,
      commonVaultPath: '/tmp/common',
      copyFromCommon: [],
      projectVaults: { alpha: '/tmp/alpha' },
      github: { createRemotes: false, hostname: 'github.com' },
      server: { host: '127.0.0.1', preferredPort: 57891 },
      codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' },
      cliBootstrap: {
        preferredPort: 57891,
        githubHostname: 'github.com',
        createRemotes: false
      }
    };
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.commonVaultPath).toBe('/tmp/common');
    expect(loaded.projectVaults.alpha).toBe('/tmp/alpha');
  });

  it('saveConfig round-trips', async () => {
    const configDir = process.env.OBSIDIAN_PROJECT_CONFIG_DIR!;
    const initial = persistedAppConfigSchema.parse({
      repoPrefix: 'v-',
      commonProjectName: 'common',
      commonConfigured: false,
      copyFromCommon: [],
      projectVaults: {},
      github: { createRemotes: false, hostname: 'github.com' },
      server: { host: '127.0.0.1', preferredPort: 11111 },
      codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' },
      cliBootstrap: {
        preferredPort: 11111,
        githubHostname: 'github.com',
        createRemotes: false
      }
    });
    await fs.mkdir(configDir, { recursive: true });
    await saveConfig(initial);
    const loaded = await loadConfig();
    expect(loaded.server.preferredPort).toBe(11111);
  });
});
