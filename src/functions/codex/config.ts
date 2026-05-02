import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppConfig } from '../../config/config.js';

const BEGIN_PREFIX = '# BEGIN obsidian-project ';
const END_PREFIX = '# END obsidian-project ';

/** Path to Codex `config.toml` (respects `CODEX_HOME`). */
export function codexConfigPath(): string {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, 'config.toml');
  }

  return path.join(os.homedir(), '.codex', 'config.toml');
}

interface CodexProjectProfileOptions {
  config: AppConfig;
  project: string;
  port: number;
  instructionsPath: string;
}

/** Upsert the marked TOML block for one project in Codex `config.toml`. */
export async function writeCodexProjectProfile(options: CodexProjectProfileOptions): Promise<string> {
  const file = options.config.codex.configPath ?? codexConfigPath();
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

/** TOML snippet for one project profile + MCP server entry. */
function renderCodexBlock(options: CodexProjectProfileOptions): string {
  const serverName = options.config.codex.mcpServerNamePrefix;
  const profileName = options.config.codex.profileNamePrefix + options.project;
  const url = `http://127.0.0.1:${options.port}/mcp`;
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

/** Replace an existing BEGIN/END block or append a new block for `project`. */
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

/** Emit a bare or quoted TOML key segment. */
function tomlBareKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

/** TOML double-quoted string literal for values. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Escape regex metacharacters for building a dynamic RegExp from user/project strings. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
