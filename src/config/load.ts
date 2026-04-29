import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
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
    throw new UserError(`obsidian-project is not configured. Run "obsidian-project --init" first.`);
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
  vaultRootMode?: 'default' | 'pick' | 'later';
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

  const existing = await loadConfig().catch(() => undefined);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.yes;
  let rl: readline.Interface | undefined;
  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!rl) {
      return fallback;
    }
    const answer = await rl.question(`${question} (${fallback}): `);
    return answer.trim() || fallback;
  };

  try {
    const vaultRootChoice = options.vaultRoot
      ? { vaultRoot: path.resolve(options.vaultRoot), configured: true }
      : await chooseVaultRoot(interactive, options.vaultRootMode);
    rl = interactive ? readline.createInterface({ input, output }) : undefined;
    const vaultRoot = vaultRootChoice.vaultRoot;
    const repoPrefix = options.repoPrefix ?? (await ask('Repository name prefix', existing?.repoPrefix ?? 'obsidian-vault-'));
    const defaultCommonMode = vaultRootChoice.configured ? (existing ? commonModeForExistingConfig(existing) : 'create') : 'later';
    const commonMode = vaultRootChoice.configured
      ? await chooseCommonMode(interactive, defaultCommonMode, options.commonMode)
      : 'later';
    const commonVaultPath =
      commonMode === 'existing'
        ? path.resolve(options.commonVaultPath ?? (await askExistingCommonVaultPath(rl, existing?.commonVaultPath)))
        : undefined;
    const commonProjectName =
      commonMode === 'later'
        ? sanitizeProjectName(options.commonProjectName ?? existing?.commonProjectName ?? 'common')
        : commonMode === 'existing'
          ? sanitizeProjectName(options.commonProjectName ?? existing?.commonProjectName ?? projectNameFromVaultPath(commonVaultPath!, repoPrefix))
          : sanitizeProjectName(options.commonProjectName ?? (await ask('Common vault project name', existing?.commonProjectName ?? 'common')));
    const folderStructure = {
      raw: options.folderStructure?.raw ?? (await ask('Raw folder', existing?.folderStructure.raw ?? 'raw')),
      wiki: options.folderStructure?.wiki ?? (await ask('Wiki folder', existing?.folderStructure.wiki ?? 'wiki')),
      output: options.folderStructure?.output ?? (await ask('Output folder', existing?.folderStructure.output ?? 'output')),
      projectWiki: options.folderStructure?.projectWiki ?? (await ask('Project wiki folder', existing?.folderStructure.projectWiki ?? 'project')),
      commonWiki: options.folderStructure?.commonWiki ?? (await ask('Common wiki mount folder', existing?.folderStructure.commonWiki ?? 'common'))
    };
    const githubOwner = options.githubOwner ?? (await ask('GitHub owner/org, blank to skip remote creation', existing?.github.owner ?? ''));

    const config = appConfigSchema.parse({
      version: 1,
      vaultRoot,
      vaultRootConfigured: vaultRootChoice.configured,
      repoPrefix,
      commonProjectName,
      commonConfigured: commonMode !== 'later',
      commonVaultPath,
      folderStructure,
      copyFromCommon: existing?.copyFromCommon ?? [],
      github: {
        owner: githubOwner || undefined,
        visibility: existing?.github.visibility ?? 'private',
        createRemotes: options.createRemotes ?? existing?.github.createRemotes ?? Boolean(githubOwner)
      },
      server: {
        host: existing?.server.host ?? '127.0.0.1',
        preferredPort: existing?.server.preferredPort ?? 57891,
        maxPortScan: existing?.server.maxPortScan ?? 1000
      },
      codex: {
        configPath: existing?.codex.configPath,
        mcpServerNamePrefix: existing?.codex.mcpServerNamePrefix ?? 'obsidianProject',
        profileNamePrefix: existing?.codex.profileNamePrefix ?? 'obsidian-vault-'
      }
    });

    await saveConfig(config);
    return config;
  } finally {
    rl?.close();
  }
}

async function chooseCommonMode(
  interactive: boolean,
  fallback: 'create' | 'existing' | 'later',
  mode?: 'create' | 'existing' | 'later'
): Promise<'create' | 'existing' | 'later'> {
  if (mode) {
    return normalizeCommonMode(mode);
  }

  if (!interactive) {
    return fallback;
  }

  return await selectMenu('Common vault setup', [
    { value: 'existing' as const, label: 'Choose an existing common vault folder...' },
    { value: 'create' as const, label: 'Create managed common vault' },
    { value: 'later' as const, label: 'Set up later' }
  ], fallback);
}

async function chooseVaultRoot(
  interactive: boolean,
  mode?: 'default' | 'pick' | 'later'
): Promise<{ vaultRoot: string; configured: boolean }> {
  const fallback = defaultVaultRoot();

  if (!interactive) {
    return {
      vaultRoot: fallback,
      configured: mode !== 'later'
    };
  }

  const selected = mode ?? (await selectMenu('Vault root', [
    { value: 'default' as const, label: `Use default folder: ${fallback}` },
    { value: 'pick' as const, label: 'Choose a folder...' },
    { value: 'later' as const, label: 'Set up later' }
  ]));

  if (selected === 'pick') {
    return {
      vaultRoot: path.resolve(await chooseFolder('Select the vault root folder')),
      configured: true
    };
  }

  return {
    vaultRoot: fallback,
    configured: selected !== 'later'
  };
}

async function selectMenu<T extends string>(
  title: string,
  choices: Array<{ value: T; label: string }>,
  fallback?: T
): Promise<T> {
  if (!input.isTTY || !output.isTTY) {
    return choices[0].value;
  }

  let index = Math.max(0, choices.findIndex(choice => choice.value === fallback));
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);

  const render = () => {
    output.write('\x1B[?25l');
    output.write(`\r\x1B[0J${title}\n`);
    for (let i = 0; i < choices.length; i += 1) {
      output.write(`${i === index ? '>' : ' '} ${choices[i].label}\n`);
    }
    output.write('\nUse arrow keys, then press Enter.\x1B[0J');
    output.write(`\x1B[${choices.length + 2}A`);
  };

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      output.write(`\x1B[${choices.length + 2}B`);
      output.write('\x1B[?25h\n');
    };
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new UserError('Setup cancelled.'));
        return;
      }

      if (key.name === 'up') {
        index = (index + choices.length - 1) % choices.length;
        render();
        return;
      }

      if (key.name === 'down') {
        index = (index + 1) % choices.length;
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const value = choices[index].value;
        cleanup();
        resolve(value);
      }
    };

    input.on('keypress', onKeypress);
    render();
  });
}

async function askExistingCommonVaultPath(rl: readline.Interface | undefined, fallback?: string): Promise<string> {
  if (!rl) {
    throw new UserError('A common vault path is required when using --common-mode existing in non-interactive mode.');
  }

  const suffix = fallback ? ` (${fallback})` : ', blank to choose in file explorer';
  const answer = (await rl.question(`Existing common vault folder${suffix}: `)).trim();
  if (answer) {
    return answer;
  }
  return fallback ?? (await chooseFolder());
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

function commonModeForExistingConfig(config: AppConfig): 'create' | 'existing' | 'later' {
  if (!config.commonConfigured) {
    return 'later';
  }

  return config.commonVaultPath ? 'existing' : 'create';
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
