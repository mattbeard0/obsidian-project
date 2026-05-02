import path from 'node:path';

import { AppConfig } from '../../config/config.js';
import { UserError } from '../errors.js';
import { isVaultRelativeUnderCommonMount } from '../vaults/commonMountPaths.js';

type ScopeKind = 'project' | 'common';

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

/** Classify a vault-relative path into project vs common (via the vault-root `common` mount) for read access. */
export function checkReadablePath(_config: AppConfig, input: string): ScopeCheck {
  const relativePath = normalizeVaultRelativePath(input);

  if (isVaultRelativeUnderCommonMount(relativePath)) {
    return { relativePath, scope: 'common' };
  }

  return { relativePath, scope: 'project' };
}

/** Like `checkReadablePath` but only allows writes outside the common mount (common notes are MCP read-only). */
export function checkWritableProjectPath(config: AppConfig, input: string): string {
  const readable = checkReadablePath(config, input);
  if (readable.scope === 'common') {
    throw new UserError(`Common notes are read-only. Use request_common_update for shared changes: ${input}`);
  }

  return readable.relativePath;
}

/** Return vault-relative path as given (paths are always relative to the project vault root). */
export function defaultProjectNotePath(_config: AppConfig, notePath: string): string {
  return normalizeVaultRelativePath(notePath);
}
