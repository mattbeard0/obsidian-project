import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appConfigSchema,
  loadConfig,
  mergeVaultConfig,
  readVaultConfigFromDisk,
  saveConfig
} from './config.js';

describe('vault-config', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-vaultcfg-'));
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

  it('reads folder layout from vault-config.json', async () => {
    const configDir = process.env.OBSIDIAN_PROJECT_CONFIG_DIR!;
    const configJson = {
      repoPrefix: 'obsidian-vault-',
      commonProjectName: 'common',
      commonConfigured: false,
      copyFromCommon: [],
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
    await fs.writeFile(
      path.join(configDir, 'vault-config.json'),
      JSON.stringify({
        version: 1,
        folderStructure: {
          attachments: 'R',
          noteLibrary: 'W',
          publish: 'O',
          projectScope: 'P',
          sharedScope: 'C'
        }
      }),
      'utf8'
    );
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.folderStructure.noteLibrary).toBe('W');

    const vault = await readVaultConfigFromDisk();
    expect(vault?.folderStructure.noteLibrary).toBe('W');
  });

  it('drops stale folderStructure from config.json after load when vault-config exists', async () => {
    const configDir = process.env.OBSIDIAN_PROJECT_CONFIG_DIR!;
    const raw = {
      repoPrefix: 'obsidian-vault-',
      commonProjectName: 'common',
      commonConfigured: false,
      folderStructure: {
        attachments: 'old',
        noteLibrary: 'old',
        publish: 'old',
        projectScope: 'old',
        sharedScope: 'old'
      },
      copyFromCommon: [],
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
    await fs.writeFile(
      path.join(configDir, 'vault-config.json'),
      JSON.stringify({
        version: 1,
        folderStructure: {
          attachments: 'R',
          noteLibrary: 'W',
          publish: 'O',
          projectScope: 'P',
          sharedScope: 'C'
        }
      }),
      'utf8'
    );
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(raw, null, 2), 'utf8');

    await loadConfig();
    const diskConfig = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
    expect(diskConfig.folderStructure).toBeUndefined();
  });

  it('mergeVaultConfig merges partial folderStructure', async () => {
    const configDir = process.env.OBSIDIAN_PROJECT_CONFIG_DIR!;
    const configJson = {
      repoPrefix: 'obsidian-vault-',
      commonProjectName: 'common',
      commonConfigured: false,
      copyFromCommon: [],
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
    await fs.writeFile(
      path.join(configDir, 'vault-config.json'),
      JSON.stringify({
        version: 1,
        folderStructure: {
          attachments: 'R',
          noteLibrary: 'W',
          publish: 'O',
          projectScope: 'P',
          sharedScope: 'C'
        }
      }),
      'utf8'
    );
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');

    await mergeVaultConfig({ folderStructure: { noteLibrary: 'NEW' } });
    const vault = await readVaultConfigFromDisk();
    expect(vault?.folderStructure.noteLibrary).toBe('NEW');
    expect(vault?.folderStructure.attachments).toBe('R');
  });
});
