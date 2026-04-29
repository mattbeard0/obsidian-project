import fs from 'node:fs/promises';
import path from 'node:path';

import { removeAllCodexProjectProfiles } from '../codex/config.js';
import { loadConfig } from '../config/load.js';
import { AppConfig } from '../config/schema.js';
import { runRequired } from '../platform/command.js';
import { configDir, legacyConfigPath, stateDir } from '../platform/paths.js';
import { stopServer } from '../server/lifecycle.js';

export interface UninstallOptions {
  removePackage?: boolean;
}

export interface UninstallResult {
  codexConfigPath: string;
  removedCodexProjects: string[];
  removedPaths: string[];
  serverStopped: boolean;
  packageRemoved: boolean;
}

export async function uninstallProjectTool(options: UninstallOptions = {}): Promise<UninstallResult> {
  const config = await loadConfig().catch(() => undefined);
  const codex = await removeAllCodexProjectProfiles(config?.codex.configPath);
  const serverStopped = await stopServer();
  const removedPaths = await removeProjectConfigPaths(config);

  let packageRemoved = false;
  if (options.removePackage !== false) {
    await runRequired(npmCommand(), ['uninstall', '-g', 'obsidian-project-cli'], { timeoutMs: 120_000 });
    packageRemoved = true;
  }

  return {
    codexConfigPath: codex.configPath,
    removedCodexProjects: codex.removedProjects,
    removedPaths,
    serverStopped,
    packageRemoved
  };
}

async function removeProjectConfigPaths(config: AppConfig | undefined): Promise<string[]> {
  const candidates = new Set<string>([configDir(), stateDir(), path.dirname(legacyConfigPath())]);
  if (config?.codex.configPath) {
    candidates.delete(path.dirname(config.codex.configPath));
  }

  const removed: string[] = [];
  for (const target of [...candidates].sort((a, b) => b.length - a.length)) {
    if (await removeIfExists(target)) {
      removed.push(target);
    }
  }

  return removed;
}

async function removeIfExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
