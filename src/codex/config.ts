import fs from 'node:fs/promises';
import path from 'node:path';

import { AppConfig } from '../config/schema.js';
import { codexConfigPath as defaultCodexConfigPath } from '../platform/paths.js';

const BEGIN_PREFIX = '# BEGIN obsidian-project ';
const END_PREFIX = '# END obsidian-project ';

export interface CodexProjectProfileOptions {
  config: AppConfig;
  project: string;
  port: number;
  instructionsPath: string;
}

export interface CleanupCodexProfilesResult {
  configPath: string;
  removedProjects: string[];
  keptProjects: string[];
}

export interface RemoveCodexProfilesResult {
  configPath: string;
  removedProjects: string[];
}

export async function writeCodexProjectProfile(options: CodexProjectProfileOptions): Promise<string> {
  const file = options.config.codex.configPath ?? defaultCodexConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });

  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    // Create below.
  }

  const block = renderCodexBlock(options);
  const next = replaceMarkedBlock(current, options.project, block);
  await fs.writeFile(file, next, 'utf8');
  return file;
}

export async function cleanupCodexProjectProfiles(
  config: AppConfig,
  existingProjects: Set<string>
): Promise<CleanupCodexProfilesResult> {
  const file = config.codex.configPath ?? defaultCodexConfigPath();
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    return {
      configPath: file,
      removedProjects: [],
      keptProjects: []
    };
  }

  const removedProjects: string[] = [];
  const keptProjects: string[] = [];
  const pattern = new RegExp(
    `${escapeRegExp(BEGIN_PREFIX)}([^\\r\\n]+)\\r?\\n[\\s\\S]*?${escapeRegExp(END_PREFIX)}\\1\\r?\\n?`,
    'g'
  );
  const next = current.replace(pattern, (block, project: string) => {
    if (existingProjects.has(project)) {
      keptProjects.push(project);
      return block;
    }

    removedProjects.push(project);
    return '';
  });

  if (next !== current) {
    await fs.writeFile(file, collapseExcessBlankLines(next), 'utf8');
  }

  return {
    configPath: file,
    removedProjects,
    keptProjects
  };
}

export async function removeAllCodexProjectProfiles(configPath?: string): Promise<RemoveCodexProfilesResult> {
  const file = configPath ?? defaultCodexConfigPath();
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    return {
      configPath: file,
      removedProjects: []
    };
  }

  const removedProjects: string[] = [];
  const pattern = new RegExp(
    `${escapeRegExp(BEGIN_PREFIX)}([^\\r\\n]+)\\r?\\n[\\s\\S]*?${escapeRegExp(END_PREFIX)}\\1\\r?\\n?`,
    'g'
  );
  const next = current.replace(pattern, (_block, project: string) => {
    removedProjects.push(project);
    return '';
  });

  if (next !== current) {
    await fs.writeFile(file, collapseExcessBlankLines(next), 'utf8');
  }

  return {
    configPath: file,
    removedProjects
  };
}

export async function refreshCodexProfilesForPort(config: AppConfig, port: number): Promise<void> {
  const root = config.vaultRoot;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter(entry => entry.startsWith(config.repoPrefix))
      .map(async entry => {
        const project = entry.slice(config.repoPrefix.length);
        if (project === config.commonProjectName) {
          return;
        }

        const instructionsPath = path.join(root, entry, '.obsidian-project', 'codex-instructions.md');
        try {
          await fs.access(instructionsPath);
        } catch {
          return;
        }
        await writeCodexProjectProfile({ config, project, port, instructionsPath });
      })
  );
}

function renderCodexBlock(options: CodexProjectProfileOptions): string {
  const serverName = codexMcpServerName(options.config, options.project);
  const profileName = codexProfileName(options.config, options.project);
  const url = `http://${options.config.server.host}:${options.port}/mcp`;
  const escapedInstructions = tomlString(path.resolve(options.instructionsPath));

  return [
    `${BEGIN_PREFIX}${options.project}`,
    `[profiles.${tomlBareKey(profileName)}]`,
    `model_instructions_file = ${escapedInstructions}`,
    '',
    `[profiles.${tomlBareKey(profileName)}.mcp_servers.${tomlBareKey(serverName)}]`,
    `url = ${tomlString(url)}`,
    `required = true`,
    `startup_timeout_ms = 10000`,
    `tool_timeout_sec = 120`,
    `http_headers = { "x-obsidian-project" = ${tomlString(options.project)} }`,
    `${END_PREFIX}${options.project}`,
    ''
  ].join('\n');
}

function replaceMarkedBlock(current: string, project: string, block: string): string {
  const begin = `${BEGIN_PREFIX}${project}`;
  const end = `${END_PREFIX}${project}`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\r?\\n?`, 'm');
  const normalizedBlock = block.endsWith('\n') ? block : `${block}\n`;

  if (pattern.test(current)) {
    return current.replace(pattern, normalizedBlock);
  }

  const prefix = current && !current.endsWith('\n') ? `${current}\n\n` : current ? `${current}\n` : '';
  return `${prefix}${normalizedBlock}`;
}

export function codexMcpServerName(config: AppConfig, project: string): string {
  return config.codex.mcpServerNamePrefix;
}

export function codexProfileName(config: AppConfig, project: string): string {
  return `${config.codex.profileNamePrefix}${project}`;
}

function tomlBareKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseExcessBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}
