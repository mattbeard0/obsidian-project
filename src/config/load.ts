import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { UserError } from '../errors.js';
import { configPath, defaultVaultRoot, legacyConfigPath } from '../platform/paths.js';
import { chooseFolder } from '../platform/folderPicker.js';
import { AppConfig, FolderStructure, appConfigSchema } from './schema.js';

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
  commonMode?: 'create' | 'existing' | 'later';
  commonVaultPath?: string;
  folderStructure?: Partial<FolderStructure>;
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
    const repoPrefix = options.repoPrefix ?? (await ask('Repository name prefix', 'obsidian-vault-'));
    const commonMode = normalizeCommonMode(options.commonMode ?? (interactive ? await askCommonMode(rl) : 'create'));
    const commonVaultPath =
      commonMode === 'existing'
        ? path.resolve(options.commonVaultPath ?? (await askExistingCommonVaultPath(rl)))
        : undefined;
    const commonProjectName =
      commonMode === 'later'
        ? sanitizeProjectName(options.commonProjectName ?? 'common')
        : commonMode === 'existing'
          ? sanitizeProjectName(options.commonProjectName ?? projectNameFromVaultPath(commonVaultPath!, repoPrefix))
          : sanitizeProjectName(options.commonProjectName ?? (await ask('Common vault project name', 'common')));
    const folderStructure = {
      raw: options.folderStructure?.raw ?? (await ask('Raw folder', 'raw')),
      wiki: options.folderStructure?.wiki ?? (await ask('Wiki folder', 'wiki')),
      output: options.folderStructure?.output ?? (await ask('Output folder', 'output')),
      projectWiki: options.folderStructure?.projectWiki ?? (await ask('Project wiki folder', 'project')),
      commonWiki: options.folderStructure?.commonWiki ?? (await ask('Common wiki mount folder', 'common'))
    };
    const githubOwner = options.githubOwner ?? (await ask('GitHub owner/org, blank to skip remote creation', ''));

    const config = appConfigSchema.parse({
      version: 1,
      vaultRoot,
      repoPrefix,
      commonProjectName,
      commonConfigured: commonMode !== 'later',
      commonVaultPath,
      folderStructure,
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

async function askCommonMode(rl: readline.Interface | undefined): Promise<'create' | 'existing' | 'later'> {
  if (!rl) {
    return 'create';
  }

  const answer = (
    await rl.question('Common vault setup: use existing folder, create managed common vault, or add later? [existing/create/later] (create): ')
  )
    .trim()
    .toLowerCase();

  if (!answer || answer === 'create' || answer === 'c') {
    return 'create';
  }
  if (answer === 'existing' || answer === 'e' || answer === 'use') {
    return 'existing';
  }
  if (answer === 'later' || answer === 'l') {
    return 'later';
  }

  throw new UserError('Common vault setup must be "existing", "create", or "later".');
}

async function askExistingCommonVaultPath(rl: readline.Interface | undefined): Promise<string> {
  if (!rl) {
    throw new UserError('A common vault path is required when using --common-mode existing in non-interactive mode.');
  }

  const answer = (await rl.question('Existing common vault folder, blank to choose in file explorer: ')).trim();
  return answer || (await chooseFolder());
}

function projectNameFromVaultPath(vaultPath: string, repoPrefix: string): string {
  const folderName = path.basename(path.resolve(vaultPath));
  return folderName.startsWith(repoPrefix) ? folderName.slice(repoPrefix.length) : folderName;
}

function normalizeCommonMode(value: string): 'create' | 'existing' | 'later' {
  if (value === 'create' || value === 'existing' || value === 'later') {
    return value;
  }

  throw new UserError('Common vault setup must be "existing", "create", or "later".');
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
