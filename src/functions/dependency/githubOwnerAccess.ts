import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { UserError } from '../errors.js';
import { envWithGithubHost, runCommand } from '../platform/shell.js';

/** Normalize configured GitHub hostname (no scheme, no path). */
export function normalizeGithubHostname(hostname: string | undefined): string {
  const raw = (hostname ?? 'github.com')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.trim();
  return raw || 'github.com';
}

/** Host used for `git@…` SSH URLs (same as API host for github.com and typical GH Enterprise). */
function sshGitHost(githubHostname: string): string {
  return normalizeGithubHostname(githubHostname);
}

function formatGithubSshHints(githubHostname: string): string {
  const h = normalizeGithubHostname(githubHostname);
  return [
    '',
    `If you expect SSH to work for ${h}:`,
    `• Add your SSH public key (GitHub → Settings → SSH and GPG keys on ${h}).`,
    `• Test: ssh -T git@${h} (GitHub may exit 1 with a success message).`,
    '• `gh` can be logged in via HTTPS while `git` uses SSH; both should map to the same account.',
    '• Try `gh auth setup-git` to align Git credential behavior.'
  ].join('\n');
}

function wrapOwnerAccessError(message: string, owner: string, githubHostname: string): UserError {
  const h = normalizeGithubHostname(githubHostname);
  const msgContents = [
    '',
    `If you do have access to "${owner}" on ${h}:`,
    `• Confirm \`gh\` is using the right account: \`gh auth status -h ${h}\`. Switch with \`gh auth login -h ${h}\` or \`gh auth switch\`.`,
    '• SSO-only organizations: run `gh auth refresh -s read:org` (or `gh auth login --web`) so org membership is visible to the API.',
    `• SSH must work for \`git@${h}\`: run \`ssh -T git@${h}\` and add your key under GitHub → Settings → SSH and GPG keys.`,
    `• Enterprise: ensure this hostname (\`${h}\`) matches where ${owner} lives (GH_HOST / GitHub hostname).`
  ].join('\n');
  return new UserError(`${message}${msgContents}`);
}

/** Message when the user chooses “Other…” — must not write config; throw as UserError. */
function cancelGithubOwnerPickerMessage(githubHostname: string): string {
  const h = normalizeGithubHostname(githubHostname);
  return [
    'Cancelled — nothing was saved to config.',
    '',
    'To add or switch the GitHub account that `gh` uses:',
    `  gh auth login -h ${h}`,
    '  gh auth switch',
    '',
    'Then run obsidian-project again.',
    `Verify SSH (used for many Git remotes): ssh -T git@${h}`,
    '',
    'If the GitHub account was already correct, finish SSO / org authorization first: `gh auth refresh -s read:org`.'
  ].join('\n');
}

interface GithubOwnerMenuEntry {
  /** Namespace for new repos (login or org name). */
  owner: string;
  /** Line shown in the menu. */
  label: string;
}

/** Personal account + org memberships from the current `gh` token (same host). */
async function listGithubOwnerMenuEntries(githubHostname: string): Promise<{
  entries: GithubOwnerMenuEntry[];
  personalLogin: string;
}> {
  const env = envWithGithubHost(githubHostname);
  const me = await runCommand('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000, env });
  if (me.code !== 0) {
    throw new UserError(`Could not read your GitHub login via gh. ${(me.stderr || me.stdout).trim()}`.trim());
  }
  const personalLogin = me.stdout.trim();
  const entries: GithubOwnerMenuEntry[] = [
    { owner: personalLogin, label: `${personalLogin} (your personal account)` }
  ];

  const orgsOut = await runCommand('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], {
    timeoutMs: 120_000,
    env
  });
  if (orgsOut.code !== 0) {
    throw new UserError(
      `Could not list your GitHub organizations: ${(orgsOut.stderr || orgsOut.stdout).trim()}`.trim() +
        ' For SSO-enabled organizations, run `gh auth refresh -s read:org` or authorize via your browser if prompted.'
    );
  }
  const orgs = orgsOut.stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  for (const o of orgs) {
    if (o.toLowerCase() === personalLogin.toLowerCase()) {
      continue;
    }
    entries.push({ owner: o, label: `${o} (organization)` });
  }

  return { entries, personalLogin };
}

function gitProtocolFromGhAuthStatus(text: string): string | undefined {
  const m = text.match(/git operations protocol:\s*(\S+)/i);
  return m?.[1];
}

/**
 * Interactive picker: personal account, each org from `gh api user/orgs`, then “Other…” (cancels; no config write).
 */
export async function promptGithubOwnerFromMenu(
  githubHostname: string,
  options?: { savedOwnerHint?: string }
): Promise<string> {
  const host = normalizeGithubHostname(githubHostname);
  const env = envWithGithubHost(githubHostname);
  const { entries } = await listGithubOwnerMenuEntries(githubHostname);

  const authSt = await runCommand('gh', ['auth', 'status'], { timeoutMs: 15_000, env });
  const gitProto = gitProtocolFromGhAuthStatus(`${authSt.stdout}\n${authSt.stderr}`);

  const lines: string[] = [
    `Choose where new repository remotes will be created (GitHub host: ${host}).`,
    'Access is verified with `gh` (HTTPS API) and SSH to git@' + host + '.'
  ];
  if (gitProto) {
    lines.push(`gh reports Git protocol: ${gitProto}`);
  }
  lines.push('');
  entries.forEach((e, i) => {
    const hint =
      options?.savedOwnerHint?.trim() &&
      e.owner.toLowerCase() === options.savedOwnerHint.trim().toLowerCase()
        ? ' — saved default'
        : '';
    lines.push(`  ${i + 1}. ${e.label}${hint}`);
  });
  const otherIdx = entries.length + 1;
  lines.push(`  ${otherIdx}. Other… (add/switch GitHub account — cancels without saving)`);
  lines.push('');
  console.log(lines.join('\n'));

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const ans = (await rl.question(`Enter 1–${otherIdx}: `)).trim();
      const n = Number(ans);
      if (!Number.isInteger(n) || n < 1 || n > otherIdx) {
        console.log(`Enter an integer from 1 to ${otherIdx}.`);
        continue;
      }
      if (n === otherIdx) {
        throw new UserError(cancelGithubOwnerPickerMessage(githubHostname));
      }
      return entries[n - 1].owner;
    }
  } finally {
    rl.close();
  }
}

/**
 * Confirms the authenticated GitHub user may create repositories under `owner` (personal login or org membership),
 * then verifies SSH authentication to `git@<host>` so HTTPS-token-only sessions still catch missing SSH keys before
 * git remote operations fail later.
 */
export async function assertGithubOwnerCanCreateRepos(ownerRaw: string, githubHostname: string): Promise<void> {
  const owner = ownerRaw.trim();
  if (!owner) {
    throw new UserError('GitHub owner/org is empty.');
  }

  const env = envWithGithubHost(githubHostname);
  const host = normalizeGithubHostname(githubHostname);

  const me = await runCommand('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000, env });
  if (me.code !== 0) {
    throw wrapOwnerAccessError(
      `Could not read your GitHub login via gh. ${(me.stderr || me.stdout).trim()}`.trim(),
      owner,
      githubHostname
    );
  }
  const myLogin = me.stdout.trim();
  const ownerLower = owner.toLowerCase();
  const myLower = myLogin.toLowerCase();

  if (ownerLower === myLower) {
    await assertGitSshWorks(host);
    return;
  }

  const orgsOut = await runCommand('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], {
    timeoutMs: 120_000,
    env
  });
  if (orgsOut.code !== 0) {
    throw wrapOwnerAccessError(
      `Could not list your GitHub organizations: ${(orgsOut.stderr || orgsOut.stdout).trim()}`.trim() +
        ' For SSO-enabled organizations, run `gh auth refresh -s read:org` or authorize via your browser if prompted.',
      owner,
      githubHostname
    );
  }
  const orgLogins = new Set(
    orgsOut.stdout
      .split(/\r?\n/)
      .map(l => l.trim().toLowerCase())
      .filter(Boolean)
  );
  if (orgLogins.has(ownerLower)) {
    await assertGitSshWorks(host);
    return;
  }

  const orgProbe = await runCommand('gh', ['api', `orgs/${owner}`], { timeoutMs: 30_000, env });
  if (orgProbe.code === 0) {
    throw wrapOwnerAccessError(
      `Your GitHub user "${myLogin}" is not a member of organization "${owner}" (or cannot create repositories there). Confirm membership on ${host}, or choose an org you belong to.`,
      owner,
      githubHostname
    );
  }

  const userProbe = await runCommand('gh', ['api', `users/${owner}`, '--jq', '.login'], { timeoutMs: 30_000, env });
  if (userProbe.code === 0 && userProbe.stdout.trim().toLowerCase() === ownerLower) {
    throw wrapOwnerAccessError(
      `"${owner}" is another user’s personal account. Repositories must be created under your login "${myLogin}" or an organization where you have access.`,
      owner,
      githubHostname
    );
  }

  throw wrapOwnerAccessError(
    `Could not find "${owner}" on ${host}, or you have no access. Check spelling and your GitHub login ("${myLogin}").`,
    owner,
    githubHostname
  );
}

async function assertGitSshWorks(githubHost: string): Promise<void> {
  const gitHost = sshGitHost(githubHost);
  const result = await runCommand(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=20',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-T',
      `git@${gitHost}`
    ],
    { timeoutMs: 35_000 }
  );

  const text = `${result.stdout}\n${result.stderr}`;

  if (result.code === 255 || /permission denied \(publickey\)/i.test(text)) {
    throw new UserError(
      `SSH authentication to git@${gitHost} failed. Git remotes often use SSH; add your SSH key to GitHub and verify: ssh -T git@${gitHost}${formatGithubSshHints(githubHost)}`
    );
  }

  if (/connection refused|could not resolve hostname|timed out|operation timed out/i.test(text)) {
    throw new UserError(
      `Could not reach git@${gitHost} over SSH. Check network, VPN, and that SSH is correct for your GitHub host (${githubHost}).${formatGithubSshHints(githubHost)}`
    );
  }

  if (/successfully authenticated/i.test(text)) {
    return;
  }
  if (result.code === 1 && /hi\s+/i.test(text)) {
    return;
  }
  if (!/denied|fatal|permission denied/i.test(text)) {
    return;
  }

  throw new UserError(`SSH check to git@${gitHost} did not succeed:\n${text.trim()}${formatGithubSshHints(githubHost)}`.trim());
}
