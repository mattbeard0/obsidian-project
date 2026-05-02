import fs from 'node:fs/promises';
import path from 'node:path';

import { AppConfig, defaultVaultParentDirectory } from '../../config/config.js';
import { UserError } from '../errors.js';
import { displayPath } from '../platform/paths.js';
import { discoverProjectNames } from '../projects/projects.js';
import { createCommonMount } from '../symlinks/index.js';
import { absoluteCommonMount } from './commonMountPaths.js';

// --- Resolved absolute paths (common + project vaults) ---

interface CommonVaultPaths {
  project: string;
  repoName: string;
  vaultPath: string;
}

interface ProjectVaultPaths {
  project: string;
  repoName: string;
  vaultPath: string;
  sharedMountPath: string;
}

/** Git remote / folder name: `repoPrefix` + project key. */
function repoNameForProject(config: AppConfig, project: string): string {
  return `${config.repoPrefix}${project}`;
}

/** Root directory for a project’s vault: explicit registry path or default under the vault parent. */
function resolveProjectVaultDirectory(config: AppConfig, project: string): string {
  const repoName = repoNameForProject(config, project);
  const explicit = config.projectVaults[project];
  return explicit ? path.resolve(explicit) : path.join(defaultVaultParentDirectory(), repoName);
}

/** Paths for the common vault (explicit `commonVaultPath` or default next to other project vaults). */
export function resolveCommonVaultPaths(config: AppConfig): CommonVaultPaths {
  if (!config.commonVaultPath) {
    const vaultPath = resolveProjectVaultDirectory(config, config.commonProjectName);
    const repoName = repoNameForProject(config, config.commonProjectName);
    return {
      project: config.commonProjectName,
      repoName,
      vaultPath
    };
  }

  const repoName = repoNameForProject(config, config.commonProjectName);
  const vaultPath = path.resolve(config.commonVaultPath);
  return {
    project: config.commonProjectName,
    repoName,
    vaultPath
  };
}

/** Resolved paths for a project vault (`common` mount directory at vault root). */
export function resolveProjectVaultPaths(config: AppConfig, project: string): ProjectVaultPaths {
  const repoName = repoNameForProject(config, project);
  const vaultPath = resolveProjectVaultDirectory(config, project);

  return {
    project,
    repoName,
    vaultPath,
    sharedMountPath: absoluteCommonMount(vaultPath)
  };
}

/** Ensure a target path is missing or an empty directory before creating a new vault. */
export async function assertMissingOrEmptyDirectory(targetPath: string, label: string): Promise<void> {
  const absolute = path.resolve(targetPath);
  const stat = await fs.stat(absolute).catch(() => undefined);
  if (!stat) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new UserError(`${label} path exists and is not a directory: ${absolute}`);
  }

  const entries = await fs.readdir(absolute);
  if (entries.length > 0) {
    throw new UserError(`${label} path must be empty before creation: ${absolute}`);
  }
}

// --- Obsidian vault folder checks ---

/** Require `.obsidian` under the path; return the resolved absolute vault path. */
export async function assertObsidianVaultFolder(vaultPath: string, label = 'Vault'): Promise<string> {
  const resolved = path.resolve(vaultPath);
  const obsidianConfig = path.join(resolved, '.obsidian');
  const stat = await fs.stat(obsidianConfig).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new UserError(`${label} must be an Obsidian vault (missing .obsidian folder): ${displayPath(resolved)}`);
  }
  return resolved;
}

/** True if `child` resolves to the same path as `ancestor` or is inside it. */
export async function assertPathInsideDirectory(ancestor: string, child: string): Promise<void> {
  const a = await fs.realpath(path.resolve(ancestor)).catch(() => path.resolve(ancestor));
  const c = await fs.realpath(path.resolve(child)).catch(() => path.resolve(child));
  const normA = path.normalize(a);
  const normC = path.normalize(c);
  if (normC === normA || normC.startsWith(normA + path.sep)) {
    return;
  }
  throw new UserError(`Path must be inside the common vault: ${displayPath(child)}`);
}

// --- Shared mount drift ---

interface MountDrift {
  project: string;
  mountPath: string;
  expectedTarget: string;
  actualTarget?: string;
  reason: 'missing' | 'wrong_target' | 'not_link' | 'error';
  detail?: string;
}

/** Compare each project’s shared mount to the common vault root; list mismatches or missing links. */
export async function findCommonMountDrift(config: AppConfig): Promise<MountDrift[]> {
  if (!config.commonConfigured) {
    return [];
  }

  const common = resolveCommonVaultPaths(config);
  const drift: MountDrift[] = [];
  const projects = await discoverProjectNames(config);

  const expectedTarget = await fs.realpath(common.vaultPath).catch(() => path.resolve(common.vaultPath));

  for (const project of projects) {
    const projectPaths = resolveProjectVaultPaths(config, project);
    const mountPath = projectPaths.sharedMountPath;

    try {
      const stat = await fs.lstat(mountPath).catch(() => undefined);
      if (!stat) {
        drift.push({
          project,
          mountPath,
          expectedTarget,
          reason: 'missing'
        });
        continue;
      }

      let resolved: string;
      try {
        resolved = await fs.realpath(mountPath);
      } catch {
        drift.push({
          project,
          mountPath,
          expectedTarget,
          reason: 'error',
          detail: 'Could not resolve mount path (missing target?).'
        });
        continue;
      }

      if (pathsEquivalent(resolved, expectedTarget)) {
        continue;
      }

      if (stat.isSymbolicLink() || process.platform === 'win32') {
        drift.push({
          project,
          mountPath,
          expectedTarget,
          actualTarget: resolved,
          reason: 'wrong_target'
        });
      } else {
        drift.push({
          project,
          mountPath,
          expectedTarget,
          actualTarget: resolved,
          reason: 'not_link',
          detail: 'Path is not a symlink toward the common vault.'
        });
      }
    } catch (err) {
      drift.push({
        project,
        mountPath,
        expectedTarget,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return drift;
}

/** Human-readable multi-line report of mount drift entries (empty string if none). */
export function formatMountDriftReport(items: MountDrift[]): string {
  if (items.length === 0) {
    return '';
  }
  const lines = ['Shared common mount differs from the registered common vault:', ''];
  for (const d of items) {
    lines.push(`- Project "${d.project}": ${displayPath(d.mountPath)}`);
    lines.push(`  Expected -> ${displayPath(d.expectedTarget)}`);
    if (d.actualTarget) {
      lines.push(`  Actual   -> ${displayPath(d.actualTarget)}`);
    }
    lines.push(`  Reason: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Recreate shared mounts so each listed drift points at the common vault root. */
export async function repairCommonMounts(config: AppConfig, items: MountDrift[]): Promise<void> {
  const common = resolveCommonVaultPaths(config);
  for (const d of items) {
    const projectPaths = resolveProjectVaultPaths(config, d.project);
    await createCommonMount(projectPaths.sharedMountPath, common.vaultPath, { forceReplace: true });
  }
}

/** Compare two normalized paths, case-insensitive on Windows. */
function pathsEquivalent(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
