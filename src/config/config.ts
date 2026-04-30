import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UserError } from '../functions/errors.js';
import { configPath, displayPath, vaultConfigPath } from '../functions/platform/paths.js';

/**
 * Parent directory for default vault folders (`repoPrefix` + project key) when a project is not listed in
 * `projectVaults`. Platform default is `~/Vaults` (Windows: `<drive>\\Vaults`). Not persisted.
 * Set `OBSIDIAN_PROJECT_VAULT_PARENT` to override (e.g. tests or CI).
 */
export function defaultVaultParentDirectory(): string {
  const fromEnv = process.env.OBSIDIAN_PROJECT_VAULT_PARENT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  if (process.platform === 'win32') {
    const drive = path.parse(os.homedir()).root || 'C:\\';
    return path.join(drive, 'Vaults');
  }

  return path.join(os.homedir(), 'Vaults');
}

// --- Schemas & types ---

/** User-chosen directory names only — no fixed product folders; keys describe roles in vault-config.json. */
const folderStructureFields = z.object({
  attachments: z.string().min(1),
  noteLibrary: z.string().min(1),
  publish: z.string().min(1),
  projectScope: z.string().min(1),
  sharedScope: z.string().min(1)
});

export const folderStructureSchema = folderStructureFields;

/** Present only after first-run wizard; when absent, the CLI runs setup before other commands. */
const cliBootstrapSchema = z.object({
  preferredPort: z.number().int().min(1024).max(65535),
  githubHostname: z.string().min(1),
  createRemotes: z.boolean(),
  owner: z.string().optional()
});

const appConfigCoreSchema = z.object({
  repoPrefix: z.string().min(1).default('obsidian-vault-'),
  commonProjectName: z.string().min(1).default('common'),
  commonConfigured: z.boolean().default(true),
  commonVaultPath: z.string().min(1).optional(),
  copyFromCommon: z.array(z.string()).default([]),
  /** Registered project name → absolute vault path (overrides default under the vault parent directory). */
  projectVaults: z.record(z.string(), z.string()).default({}),
  cliBootstrap: cliBootstrapSchema.optional(),
  github: z
    .object({
      owner: z.string().optional(),
      createRemotes: z.boolean().default(false),
      /** Host for `gh` (GH_HOST) and `git remote` URLs (e.g. github.com or your GitHub Enterprise hostname). */
      hostname: z.string().min(1).default('github.com')
    })
    .default({
      createRemotes: false,
      hostname: 'github.com'
    }),
  server: z
    .object({
      /** Ignored at runtime: the MCP server always listens on 127.0.0.1. */
      host: z.string().default('127.0.0.1'),
      preferredPort: z.number().int().min(1024).max(65535).default(57891)
    })
    .default({
      host: '127.0.0.1',
      preferredPort: 57891
    }),
  codex: z
    .object({
      configPath: z.string().optional(),
      mcpServerNamePrefix: z.string().min(1).default('obsidian-notes'),
      profileNamePrefix: z.string().default('')
    })
    .default({
      mcpServerNamePrefix: 'obsidian-notes',
      profileNamePrefix: ''
    })
});

/** Written to `config.json` (canonical layout lives only in `vault-config.json`). */
export const persistedAppConfigSchema = appConfigCoreSchema;

export const appConfigSchema = appConfigCoreSchema.extend({
  folderStructure: folderStructureSchema
});

export const vaultConfigSchema = z.object({
  version: z.literal(1).default(1),
  folderStructure: folderStructureSchema
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type FolderStructure = z.infer<typeof folderStructureFields>;
export type PersistedAppConfig = z.infer<typeof persistedAppConfigSchema>;
type VaultConfig = z.infer<typeof vaultConfigSchema>;

/** First-run wizard is required until `cliBootstrap` is written to config.json. */
export function persistedNeedsCliBootstrap(persisted: PersistedAppConfig): boolean {
  return persisted.cliBootstrap === undefined;
}

// --- vault-config.json I/O ---

/** Read and validate `vault-config.json`; return undefined if missing or unreadable. */
export async function readVaultConfigFromDisk(): Promise<VaultConfig | undefined> {
  try {
    const raw = await fs.readFile(vaultConfigPath(), 'utf8');
    return vaultConfigSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Write validated vault layout JSON next to the main config. */
export async function writeVaultConfigToDisk(vault: VaultConfig): Promise<void> {
  const parsed = vaultConfigSchema.parse(vault);
  const file = vaultConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Merge partial folder structure into existing vault-config and persist. */
export async function mergeVaultConfig(partial: Partial<Pick<VaultConfig, 'folderStructure'>>): Promise<VaultConfig> {
  const current = await readVaultConfigFromDisk();
  if (!current) {
    throw new UserError('vault-config.json is missing. Add vault-config.json (see README), then run any obsidian-project command.');
  }
  const next = vaultConfigSchema.parse({
    ...current,
    ...partial,
    folderStructure: partial.folderStructure
      ? folderStructureSchema.parse({ ...current.folderStructure, ...partial.folderStructure })
      : current.folderStructure
  });
  await writeVaultConfigToDisk(next);
  return next;
}

/** Parse a JSON string as `vault-config.json` or throw `UserError`. */
export function parseVaultConfigJson(raw: string): VaultConfig {
  try {
    return vaultConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new UserError(`Invalid vault-config.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- config.json load/save & merge ---

/** True if `config.json` exists on disk. */
export async function configExists(): Promise<boolean> {
  try {
    await fs.access(configPath());
    return true;
  } catch {
    return false;
  }
}

/** Load and validate persisted app settings from `config.json` (no vault layout). */
export async function readPersistedConfig(): Promise<PersistedAppConfig> {
  const raw = await fs.readFile(configPath(), 'utf8');
  return persistedAppConfigSchema.parse(JSON.parse(raw));
}

/** Atomically write validated persisted settings (not vault-config). */
export async function writePersistedConfig(persisted: PersistedAppConfig): Promise<void> {
  const parsed = persistedAppConfigSchema.parse(persisted);
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Default persisted settings for first-run wizard (same shape as the minimal config.json bootstrap file). */
export function defaultPersistedBootstrap(): PersistedAppConfig {
  return persistedAppConfigSchema.parse({
    repoPrefix: 'obsidian-vault-',
    commonProjectName: 'common',
    commonConfigured: false,
    copyFromCommon: [],
    projectVaults: {},
    github: { createRemotes: false, hostname: 'github.com' },
    server: { host: '127.0.0.1', preferredPort: 57891 },
    codex: { mcpServerNamePrefix: 'obsidian-notes', profileNamePrefix: '' }
  });
}

/** Merge `config.json` with `vault-config.json` into a full `AppConfig`. */
export async function loadConfig(): Promise<AppConfig> {
  const file = configPath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const rawObj = JSON.parse(raw) as Record<string, unknown>;
    const persisted = persistedAppConfigSchema.parse(rawObj);
    const vault = await readVaultConfigFromDisk();

    if (!vault) {
      throw new UserError(
        'Missing vault-config.json or folderStructure. Add vault-config.json with a complete folderStructure (see README), then run add-common-vault, add-project-vault, or other commands that need it.'
      );
    }

    const merged = appConfigSchema.parse({
      ...persisted,
      projectVaults: persisted.projectVaults ?? {},
      folderStructure: vault.folderStructure
    });

    if ('folderStructure' in rawObj && rawObj.folderStructure !== undefined) {
      await writePersistedAppConfigWithoutFolders(merged);
    }

    return merged;
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError(
      `Invalid config file at ${displayPath(file)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Rewrite `config.json` without `folderStructure` after migrating layout to vault-config only. */
async function writePersistedAppConfigWithoutFolders(config: AppConfig): Promise<void> {
  const { folderStructure: _f, ...rest } = config;
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(persistedAppConfigSchema.parse(rest), null, 2)}\n`, 'utf8');
}

/** Persist full app config: split layout to vault-config and non-layout fields to config.json. */
export async function saveConfig(config: AppConfig): Promise<void> {
  const parsed = appConfigSchema.parse(config);
  await writeVaultConfigToDisk(
    vaultConfigSchema.parse({
      version: 1,
      folderStructure: parsed.folderStructure
    })
  );

  const { folderStructure: _fs, ...rest } = parsed;
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(persistedAppConfigSchema.parse(rest), null, 2)}\n`, 'utf8');
}

/** Derive a project key from a vault folder name, stripping `repoPrefix` when present. */
export function projectNameFromVaultPath(vaultPath: string, repoPrefix: string): string {
  const folderName = path.basename(path.resolve(vaultPath));
  return folderName.startsWith(repoPrefix) ? folderName.slice(repoPrefix.length) : folderName;
}

/** Normalize a user-provided project name to a safe lowercase slug. */
export function sanitizeProjectName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!sanitized) {
    throw new UserError('Project name cannot be empty. Use letters, digits, ".", "_", or "-".');
  }

  if (sanitized === '.' || sanitized === '..' || sanitized.includes('..')) {
    throw new UserError('Project name cannot be "." or contain "..".');
  }

  return sanitized;
}
