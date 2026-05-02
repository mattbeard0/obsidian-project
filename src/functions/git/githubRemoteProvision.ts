import type { AppConfig } from '../../config/config.js';
import { UserError } from '../errors.js';
import { assertGithubOwnerCanCreateRepos } from '../dependency/githubOwnerAccess.js';
import { assertGhReady } from '../dependency/dependencyCheck.js';
import { envWithGithubHost, runCommand, runRequired } from '../platform/shell.js';
import { isGitRepo, pushOriginMain } from './git.js';

function skipExternalCliChecks(): boolean {
  const v = process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS;
  return v === '1' || v === 'true';
}

/** When owner and hostname are set, create/link the GitHub repo and push current commits. */
export function shouldProvisionGithubRepo(github: AppConfig['github']): boolean {
  return Boolean(github.owner?.trim()) && Boolean(github.hostname?.trim());
}

/**
 * If `origin` is missing, create private `owner/repoName` on the configured host (via `gh`),
 * attach `origin`, and push. If `origin` already exists, push only.
 * Requires a git working tree at `cwd`.
 */
export async function ensureGithubRemoteRepoAndPush(
  cwd: string,
  github: AppConfig['github'],
  repoName: string
): Promise<void> {
  if (!shouldProvisionGithubRepo(github)) {
    return;
  }
  if (skipExternalCliChecks()) {
    return;
  }
  if (!(await isGitRepo(cwd))) {
    throw new UserError(`Cannot configure GitHub remote: not a git repository: ${cwd}`);
  }

  const owner = github.owner!.trim();
  const hostname = github.hostname.trim();
  const env = envWithGithubHost(hostname);
  const fullRepo = `${owner}/${repoName}`;

  await assertGhReady(hostname);
  await assertGithubOwnerCanCreateRepos(owner, hostname);

  const origin = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 });
  if (origin.code === 0 && origin.stdout.trim()) {
    await pushOriginMain(cwd);
    return;
  }

  const created = await runCommand(
    'gh',
    ['repo', 'create', fullRepo, '--private', '--source', '.', '--remote', 'origin', '--push'],
    { cwd, env, timeoutMs: 180_000 }
  );
  if (created.code === 0) {
    console.log(`Created GitHub repo ${fullRepo} and pushed.`);
    return;
  }

  const view = await runCommand('gh', ['repo', 'view', fullRepo, '--json', 'sshCloneUrl,httpsCloneUrl'], {
    cwd,
    env,
    timeoutMs: 60_000
  });
  if (view.code !== 0 || !view.stdout.trim()) {
    throw new UserError(
      `Could not create GitHub repo ${fullRepo} and it was not found on ${hostname}: ${(created.stderr || created.stdout).trim()}`
    );
  }

  let cloneUrl: string;
  try {
    const parsed = JSON.parse(view.stdout) as { sshCloneUrl?: string | null; httpsCloneUrl?: string | null };
    cloneUrl = (parsed.sshCloneUrl || parsed.httpsCloneUrl || '').trim();
  } catch {
    throw new UserError(`Could not parse gh repo view JSON for ${fullRepo}.`);
  }
  if (!cloneUrl) {
    throw new UserError(`GitHub repo ${fullRepo} has no clone URL in gh output.`);
  }

  await runRequired('git', ['remote', 'add', 'origin', cloneUrl], { cwd, timeoutMs: 30_000 });
  await pushOriginMain(cwd);
  console.log(`Linked existing GitHub repo ${fullRepo} as origin and pushed to main.`);
}
