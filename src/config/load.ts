import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { UserError } from '../errors.js';
import { configPath, defaultVaultRoot, legacyConfigPath } from '../platform/paths.js';
import { AppConfig, appConfigSchema } from './schema.js';

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(configPath());
    return true;
  } catch {
    try {
      await fs.access(legacyConfigPath());
      return true;
    } catch {
      return false;
    }
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const file = await existingConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new UserError(`obsidian-project is not configured. Run "obsidian-project init" first.`);
  }

  try {
    const parsed = appConfigSchema.parse(JSON.parse(raw));
    if (file !== configPath()) {
      await saveConfig(parsed);
    }
    return parsed;
  } catch (error) {
    throw new UserError(`Invalid config file at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function existingConfigPath(): Promise<string> {
  try {
    await fs.access(configPath());
    return configPath();
  } catch {
    return legacyConfigPath();
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const parsed = appConfigSchema.parse(config);
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

export interface InitOptions {
  vaultRoot?: string;
  commonProjectName?: string;
  repoPrefix?: string;
  githubOwner?: string;
  createRemotes?: boolean;
  yes?: boolean;
  ifMissing?: boolean;
}

export async function initConfig(options: InitOptions = {}): Promise<AppConfig> {
  if (options.ifMissing && (await configExists())) {
    return await loadConfig();
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.yes;
  const rl = interactive ? readline.createInterface({ input, output }) : undefined;
  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!rl) {
      return fallback;
    }
    const answer = await rl.question(`${question} (${fallback}): `);
    return answer.trim() || fallback;
  };

  try {
    const vaultRoot = path.resolve(options.vaultRoot ?? (await ask('Vault root', defaultVaultRoot())));
    const commonProjectName = sanitizeProjectName(
      options.commonProjectName ?? (await ask('Common vault project name', 'common'))
    );
    const repoPrefix = options.repoPrefix ?? (await ask('Repository name prefix', 'obsidian-vault-'));
    const githubOwner = options.githubOwner ?? (await ask('GitHub owner/org, blank to skip remote creation', ''));

    const config = appConfigSchema.parse({
      version: 1,
      vaultRoot,
      repoPrefix,
      commonProjectName,
      folderStructure: {
        raw: 'raw',
        wiki: 'wiki',
        output: 'output',
        projectWiki: 'project',
        commonWiki: 'common'
      },
      copyFromCommon: [],
      github: {
        owner: githubOwner || undefined,
        visibility: 'private',
        createRemotes: options.createRemotes ?? Boolean(githubOwner)
      },
      server: {
        host: '127.0.0.1',
        preferredPort: 57891,
        maxPortScan: 1000
      },
      codex: {
        mcpServerNamePrefix: 'obsidianProject',
        profileNamePrefix: 'obsidian-vault-'
      }
    });

    await saveConfig(config);
    return config;
  } finally {
    rl?.close();
  }
}

export async function ensureConfig(options: InitOptions = {}): Promise<AppConfig> {
  if (await configExists()) {
    return await loadConfig();
  }

  return await initConfig({ ...options, ifMissing: false });
}

export function sanitizeProjectName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!sanitized) {
    throw new UserError('Project name must contain at least one letter or number.');
  }

  if (sanitized === '.' || sanitized === '..' || sanitized.includes('..')) {
    throw new UserError('Project name cannot be "." or contain "..".');
  }

  return sanitized;
}
