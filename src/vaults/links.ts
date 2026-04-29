import fs from 'node:fs/promises';
import path from 'node:path';

import { UserError } from '../errors.js';

export async function createCommonMount(linkPath: string, targetPath: string): Promise<void> {
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

    throw new UserError(`Cannot create common mount because ${linkPath} already exists.`);
  }

  if (process.platform === 'win32') {
    await fs.symlink(targetPath, linkPath, 'junction');
    return;
  }

  await fs.symlink(targetPath, linkPath, 'dir');
}

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

async function resolveExisting(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
