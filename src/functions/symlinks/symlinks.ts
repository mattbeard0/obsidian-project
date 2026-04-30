import fs from 'node:fs/promises';
import path from 'node:path';

import { UserError } from '../errors.js';

/** Build a helpful symlink error message, including macOS Full Disk Access hints when relevant. */
export function formatSymlinkError(operation: string, err: NodeJS.ErrnoException): string {
  const code = err.code;
  const base = `${operation} failed${code ? ` (${code})` : ''}: ${err.message}`;

  if (process.platform === 'darwin' && (code === 'EACCES' || code === 'EPERM')) {
    return (
      `${base}\n` +
      'On macOS, symlink creation can be blocked if Terminal (or your IDE) lacks Full Disk Access.\n' +
      'Open System Settings → Privacy & Security → Full Disk Access, add your terminal app, restart it, and try again.\n' +
      'Avoid placing vaults only inside iCloud-synced locations with restricted access; a folder under your home directory is safest.\n' +
      'If the vault is owned by another user, you may need to run the command with appropriate permissions (for example sudo), though that is rarely required for vaults in your home directory.'
    );
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return `${base}\nCheck that you own the parent folders and that antivirus or sync tools are not locking the path.`;
  }

  return base;
}

interface CreateCommonMountOptions {
  /** After user confirmation: remove wrong symlink/junction or empty directory, then recreate. */
  forceReplace?: boolean;
}

/** Create or replace a directory symlink/junction from project shared folder to the common note library. */
export async function createCommonMount(
  linkPath: string,
  targetPath: string,
  options: CreateCommonMountOptions = {}
): Promise<void> {
  const parent = path.dirname(linkPath);
  await fs.mkdir(parent, { recursive: true });

  const existing = await inspectPath(linkPath);
  if (existing.exists) {
    if (existing.isDirectory || existing.isSymbolicLink) {
      const resolved = await resolveExisting(linkPath);
      const target = path.resolve(targetPath);
      if (samePath(resolved, target)) {
        return;
      }
    }

    if (options.forceReplace) {
      await removeMountForReplace(linkPath, existing);
    } else {
      throw new UserError(`Cannot create common mount because ${linkPath} already exists.`);
    }
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(targetPath, linkPath, linkType);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new UserError(formatSymlinkError('Shared common mount (symlink)', e));
  }
}

/** Remove symlink, empty directory, or cleared mount so a new link can be created. */
async function removeMountForReplace(
  linkPath: string,
  existing: { isDirectory: boolean; isSymbolicLink: boolean }
): Promise<void> {
  if (existing.isSymbolicLink) {
    await fs.unlink(linkPath);
    return;
  }

  if (existing.isDirectory) {
    const entries = await fs.readdir(linkPath);
    if (entries.length > 0) {
      throw new UserError(
        `Cannot replace ${linkPath}: it is a non-empty directory. Move or delete its contents, then run the command again.`
      );
    }
    await fs.rmdir(linkPath);
    return;
  }

  throw new UserError(`Cannot replace ${linkPath}: not a symlink or empty directory.`);
}

/** Return existence and whether the path is a directory or symlink (via `lstat`). */
async function inspectPath(filePath: string): Promise<{ exists: boolean; isDirectory: boolean; isSymbolicLink: boolean }> {
  try {
    const stat = await fs.lstat(filePath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink()
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      isSymbolicLink: false
    };
  }
}

/** Resolved realpath of a link or directory, or the path itself if resolution fails. */
async function resolveExisting(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** Compare paths with Windows case-folding. */
function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
