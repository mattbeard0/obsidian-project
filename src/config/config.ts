import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UserError } from '../functions/errors.js';
import { configPath, displayPath } from '../functions/platform/paths.js';

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

/** Written to `config.json`. */
export const persistedAppConfigSchema = appConfigCoreSchema;

export const appConfigSchema = persistedAppConfigSchema;

export type AppConfig = z.infer<typeof appConfigSchema>;
export type PersistedAppConfig = z.infer<typeof persistedAppConfigSchema>;

/** First-run wizard is required until `cliBootstrap` is written to config.json. */
export function persistedNeedsCliBootstrap(persisted: PersistedAppConfig): boolean {
  return persisted.cliBootstrap === undefined;
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

/** Load and validate persisted app settings from `config.json`. */
export async function readPersistedConfig(): Promise<PersistedAppConfig> {
  const raw = await fs.readFile(configPath(), 'utf8');
  return persistedAppConfigSchema.parse(JSON.parse(raw));
}

/** Atomically write validated persisted settings. */
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

/** Load and validate `config.json` as the full app config. */
export async function loadConfig(): Promise<AppConfig> {
  const file = configPath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    return persistedAppConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError(
      `Invalid config file at ${displayPath(file)}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Persist app config to `config.json`. */
export async function saveConfig(config: AppConfig): Promise<void> {
  await writePersistedConfig(persistedAppConfigSchema.parse(config));
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
