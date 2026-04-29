import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitizeProjectName } from '../config/load.js';
import { AppConfig } from '../config/schema.js';
import { UserError } from '../errors.js';
import { commitIfNeeded, isGitRepo, pushIfRemote } from '../git/repo.js';
import { projectLayout } from '../vaults/layout.js';

export interface DeleteProjectOptions {
  skipPush?: boolean;
}

export interface DeleteProjectResult {
  project: string;
  deletedPath: string;
  committed: boolean;
  pushed: boolean;
}

export async function deleteProject(
  config: AppConfig,
  requestedProject: string,
  options: DeleteProjectOptions = {}
): Promise<DeleteProjectResult> {
  const project = sanitizeProjectName(requestedProject);
  if (project === config.commonProjectName) {
    throw new UserError('Refusing to delete the common vault with the project delete command.');
  }

  const layout = projectLayout(config, project);
  await assertPathInsideRoot(config.vaultRoot, layout.vaultPath);

  try {
    await fs.access(layout.vaultPath);
  } catch {
    throw new UserError(`Project vault does not exist: ${layout.vaultPath}`);
  }

  let committed = false;
  let pushed = false;
  if (await isGitRepo(layout.vaultPath)) {
    committed = await commitIfNeeded(layout.vaultPath, `Archive ${layout.repoName} before local delete`);
    if (!options.skipPush) {
      pushed = await pushIfRemote(layout.vaultPath);
    }
  }

  await fs.rm(layout.vaultPath, { recursive: true, force: false });
  return {
    project,
    deletedPath: layout.vaultPath,
    committed,
    pushed
  };
}

async function assertPathInsideRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new UserError(`Refusing to delete path outside the configured vault root: ${resolvedTarget}`);
  }
}
