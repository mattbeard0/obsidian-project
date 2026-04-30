import fs from 'node:fs/promises';
import path from 'node:path';

import { runCommand, runRequired } from '../platform/shell.js';

/** True if `cwd` is inside a Git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 10_000 });
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** Creates the directory, runs `git init` if needed, updates `.gitignore`, and commits if there are changes. */
export async function ensureGitRepo(cwd: string, initialMessage: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  if (!(await isGitRepo(cwd))) {
    await runRequired('git', ['init'], { cwd, timeoutMs: 30_000 });
  }

  await ensureGitignore(cwd);
  await commitIfNeeded(cwd, initialMessage);
}

/** Appends required ignore patterns to `.gitignore` if they are missing. */
async function ensureGitignore(cwd: string): Promise<void> {
  const gitignore = path.join(cwd, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(gitignore, 'utf8');
  } catch {
    // Create below.
  }

  const required = ['.obsidian/workspace*.json', '.trash/'];
  const missing = required.filter(line => !current.split(/\r?\n/).includes(line));
  if (missing.length === 0) {
    return;
  }

  const next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`;
  await fs.writeFile(gitignore, next, 'utf8');
}

/** Stages all files and creates a commit when there is something staged; returns whether a commit was made. */
export async function commitIfNeeded(cwd: string, message: string): Promise<boolean> {
  await runRequired('git', ['add', '--all'], { cwd, timeoutMs: 30_000 });
  if (!(await hasStagedChanges(cwd))) {
    return false;
  }

  await runRequired('git', ['commit', '-m', message], { cwd, timeoutMs: 60_000 });
  return true;
}

/** True when `git diff --cached` is non-empty (exit code 1 from diff --cached --quiet). */
async function hasStagedChanges(cwd: string): Promise<boolean> {
  const result = await runCommand('git', ['diff', '--cached', '--quiet'], { cwd, timeoutMs: 30_000 });
  return result.code === 1;
}

/** Pushes the current branch to `origin` when a remote exists; returns whether a push ran. */
export async function pushIfRemote(cwd: string): Promise<boolean> {
  const remote = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 });
  if (remote.code !== 0 || !remote.stdout.trim()) {
    return false;
  }

  const branch = await runRequired('git', ['branch', '--show-current'], { cwd, timeoutMs: 10_000 });
  const currentBranch = branch.stdout.trim() || 'main';
  await runRequired('git', ['push', '-u', 'origin', currentBranch], { cwd, timeoutMs: 120_000 });
  return true;
}
