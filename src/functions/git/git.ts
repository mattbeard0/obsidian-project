import fs from 'node:fs/promises';
import path from 'node:path';

import { UserError } from '../errors.js';
import { displayPath } from '../platform/paths.js';
import { runCommand, runRequired } from '../platform/shell.js';

const MANAGED_BEGIN = '# obsidian-project >>>';
const MANAGED_END = '# <<< obsidian-project';

/** Dotfiles and dot-directories; `!.gitignore` keeps this file tracked. */
const MANAGED_BODY = ['.*', '!.gitignore'].join('\n');

/** Commit message for vault registration after `git init`. */
export const INITIAL_VAULT_COMMIT_MESSAGE = 'Initial State';

/** True if `cwd` is inside a Git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 10_000 });
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** Remove `.git` and `.gitignore` from a vault folder (used when replacing an existing repo). */
export async function removeGitArtifacts(cwd: string): Promise<void> {
  await fs.rm(path.join(cwd, '.git'), { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.unlink(path.join(cwd, '.gitignore'));
  } catch {
    // missing
  }
}

/**
 * New repository on `main`: managed `.gitignore`, then commit {@link INITIAL_VAULT_COMMIT_MESSAGE}.
 * Caller must ensure `cwd` is not already a git repo (or has removed `.git` first).
 */
export async function bootstrapFreshVaultGit(cwd: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  const br = await runCommand('git', ['init', '-b', 'main'], { cwd, timeoutMs: 30_000 });
  if (br.code !== 0) {
    await runRequired('git', ['init'], { cwd, timeoutMs: 30_000 });
    await runRequired('git', ['branch', '-M', 'main'], { cwd, timeoutMs: 10_000 });
  }
  await ensureGitignore(cwd);
  const committed = await commitIfNeeded(cwd, INITIAL_VAULT_COMMIT_MESSAGE);
  if (!committed) {
    throw new UserError(`Could not create initial git commit in ${displayPath(cwd)}.`);
  }
}

/** Creates the directory, runs `git init` if needed, writes managed `.gitignore`, then commits if there are changes. */
export async function ensureGitRepo(cwd: string, initialMessage: string): Promise<void> {
  await fs.mkdir(cwd, { recursive: true });
  if (!(await isGitRepo(cwd))) {
    const br = await runCommand('git', ['init', '-b', 'main'], { cwd, timeoutMs: 30_000 });
    if (br.code !== 0) {
      await runRequired('git', ['init'], { cwd, timeoutMs: 30_000 });
      await runRequired('git', ['branch', '-M', 'main'], { cwd, timeoutMs: 10_000 });
    }
  }

  await ensureGitignore(cwd);
  await commitIfNeeded(cwd, initialMessage);
}

/** Remove prior managed block, then append the current managed block. */
async function ensureGitignore(cwd: string): Promise<void> {
  const gitignore = path.join(cwd, '.gitignore');
  let raw = '';
  try {
    raw = await fs.readFile(gitignore, 'utf8');
  } catch {
    // missing
  }

  const stripped = stripManagedBlock(raw);
  const block = [MANAGED_BEGIN, MANAGED_BODY, MANAGED_END].join('\n');
  const spacer = stripped && !stripped.endsWith('\n') ? '\n' : '';
  const prefix = stripped ? `${stripped}${spacer}\n` : '';
  await fs.writeFile(gitignore, `${prefix}${block}\n`, 'utf8');
}

function stripManagedBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let skipUntilEnd = false;

  for (const line of lines) {
    const t = line.trim();
    if (t === MANAGED_BEGIN) {
      skipUntilEnd = true;
      continue;
    }
    if (skipUntilEnd) {
      if (t === MANAGED_END) {
        skipUntilEnd = false;
      }
      continue;
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
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

/** Rename current branch to `main` (if possible), then push to `origin/main`. */
export async function pushOriginMain(cwd: string): Promise<void> {
  await runRequired('git', ['branch', '-M', 'main'], { cwd, timeoutMs: 10_000 });
  await runRequired('git', ['push', '-u', 'origin', 'main'], { cwd, timeoutMs: 120_000 });
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
