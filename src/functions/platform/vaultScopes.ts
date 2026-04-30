import path from 'node:path';

import { AppConfig } from '../../config/config.js';
import { UserError } from '../errors.js';

type ScopeKind = 'project' | 'common' | 'visible-root';

interface ScopeCheck {
  relativePath: string;
  scope: ScopeKind;
}

/** Normalize and validate a vault-relative path; rejects absolute paths and traversal. */
export function normalizeVaultRelativePath(input: string): string {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new UserError(`Invalid vault-relative path: ${input}`);
  }
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw new UserError(`Absolute paths are not allowed: ${input}`);
  }
  return normalized;
}

/** Classify a vault-relative path into project, common, or root scope for read access. */
export function checkReadablePath(config: AppConfig, input: string): ScopeCheck {
  const relativePath = normalizeVaultRelativePath(input);
  const layout = config.folderStructure;
  const projectPrefix = `${layout.noteLibrary}/${layout.projectScope}/`;
  const commonPrefix = `${layout.noteLibrary}/${layout.sharedScope}/`;

  if (relativePath === layout.noteLibrary) {
    return { relativePath, scope: 'visible-root' };
  }

  if (
    relativePath === `${layout.noteLibrary}/${layout.projectScope}` ||
    relativePath.startsWith(projectPrefix)
  ) {
    return { relativePath, scope: 'project' };
  }

  if (
    relativePath === `${layout.noteLibrary}/${layout.sharedScope}` ||
    relativePath.startsWith(commonPrefix)
  ) {
    return { relativePath, scope: 'common' };
  }

  throw new UserError(`Path is outside the readable project scope: ${input}`);
}

/** Like `checkReadablePath` but only allows writes under the project scope (not shared/common). */
export function checkWritableProjectPath(config: AppConfig, input: string): string {
  const readable = checkReadablePath(config, input);
  if (readable.scope !== 'project') {
    throw new UserError(`Common notes are read-only. Use request_common_update for shared changes: ${input}`);
  }

  return readable.relativePath;
}

/** Resolve a note path relative to the configured note library and project scope when not already prefixed. */
export function defaultProjectNotePath(config: AppConfig, notePath: string): string {
  const normalized = normalizeVaultRelativePath(notePath);
  const lib = config.folderStructure.noteLibrary;
  if (normalized.startsWith(`${lib}/`)) {
    return normalized;
  }

  return `${lib}/${config.folderStructure.projectScope}/${normalized}`;
}
