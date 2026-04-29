import path from 'node:path';

import { AppConfig } from '../config/schema.js';
import { UserError } from '../errors.js';

export type ScopeKind = 'project' | 'common' | 'visible-root';

export interface ScopeCheck {
  relativePath: string;
  scope: ScopeKind;
}

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

export function checkReadablePath(config: AppConfig, input: string): ScopeCheck {
  const relativePath = normalizeVaultRelativePath(input);
  const fs = config.folderStructure;
  const projectPrefix = `${fs.wiki}/${fs.projectWiki}/`;
  const commonPrefix = `${fs.wiki}/${fs.commonWiki}/`;

  if (relativePath === fs.wiki) {
    return { relativePath, scope: 'visible-root' };
  }

  if (relativePath === `${fs.wiki}/${fs.projectWiki}` || relativePath.startsWith(projectPrefix)) {
    return { relativePath, scope: 'project' };
  }

  if (relativePath === `${fs.wiki}/${fs.commonWiki}` || relativePath.startsWith(commonPrefix)) {
    return { relativePath, scope: 'common' };
  }

  throw new UserError(`Path is outside the readable project scope: ${input}`);
}

export function checkWritableProjectPath(config: AppConfig, input: string): string {
  const readable = checkReadablePath(config, input);
  if (readable.scope !== 'project') {
    throw new UserError(`Common notes are read-only. Use request_common_update for shared changes: ${input}`);
  }

  return readable.relativePath;
}

export function defaultProjectNotePath(config: AppConfig, notePath: string): string {
  const normalized = normalizeVaultRelativePath(notePath);
  if (normalized.startsWith(`${config.folderStructure.wiki}/`)) {
    return normalized;
  }

  return `${config.folderStructure.wiki}/${config.folderStructure.projectWiki}/${normalized}`;
}

export function visibleSearchFolders(config: AppConfig): string[] {
  const fs = config.folderStructure;
  return [`${fs.wiki}/${fs.projectWiki}`, `${fs.wiki}/${fs.commonWiki}`];
}
