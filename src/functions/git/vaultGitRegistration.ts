import readline from 'node:readline/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

import { UserError } from '../errors.js';
import { displayPath } from '../platform/paths.js';
import { bootstrapFreshVaultGit, isGitRepo, removeGitArtifacts } from './git.js';

export type VaultGitRegistrationKind = 'fresh_bootstrap' | 'skipped_existing_repo';

/**
 * If the folder has no `.git`, initializes git on `main`, writes managed `.gitignore`, commits "Initial State".
 * If it already has a git repo, prompts: replace (wipe `.git` + `.gitignore`, re-bootstrap) or skip (no git changes).
 */
export async function runVaultGitRegistrationInteractive(vaultPath: string): Promise<{ kind: VaultGitRegistrationKind }> {
  const abs = path.resolve(vaultPath);

  if (!(await isGitRepo(abs))) {
    await bootstrapFreshVaultGit(abs);
    console.log(`Git: initialized repository on branch main with commit "Initial State".`);
    return { kind: 'fresh_bootstrap' };
  }

  const interactive = input.isTTY && output.isTTY;
  if (!interactive) {
    throw new UserError(
      [
        `This folder already has a Git repository (${displayPath(abs)}).`,
        'Run this command in an interactive terminal to choose whether to replace it, or delete the `.git` folder and run again with `--path`.'
      ].join(' ')
    );
  }

  console.log('');
  console.log(`A Git repository already exists in ${displayPath(abs)}.`);

  const rl = readline.createInterface({ input, output });
  let answer: string;
  try {
    answer = (
      await rl.question(
        'Replace it with a fresh repository? This removes the .git directory and .gitignore, then re-initializes and can connect to GitHub. (y/N): '
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }

  if (answer !== 'y' && answer !== 'yes') {
    console.log('');
    console.log('Leaving your existing Git repository unchanged (no .gitignore from obsidian-project, no GitHub repo created here).');
    console.log('');
    console.log('You can still use this vault as registered; there is no GitHub remote from this step.');
    console.log('');
    console.log('Later you can either:');
    console.log(`  1) Remove this repo and re-run: delete ${displayPath(path.join(abs, '.git'))} (and .gitignore if you want), then run this command again and answer Yes; or`);
    console.log('  2) Add a GitHub remote yourself (for example: gh repo create, git remote add origin …, git push -u origin main).');
    console.log('');
    return { kind: 'skipped_existing_repo' };
  }

  await removeGitArtifacts(abs);
  await bootstrapFreshVaultGit(abs);
  console.log(`Git: removed the old repository, re-initialized on branch main with commit "Initial State".`);
  return { kind: 'fresh_bootstrap' };
}
