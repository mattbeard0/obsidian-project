import { AppConfig } from '../config/config.js';
import { UserError } from '../functions/errors.js';
import { envWithGithubHost, runCommand, runRequired } from '../functions/platform/shell.js';
import { checkReadablePath, checkWritableProjectPath } from '../functions/platform/vaultScopes.js';
import { VAULT_RELATIVE_COMMON_MOUNT } from '../functions/vaults/commonMountPaths.js';

/** Open a pull request in the common vault repo via `gh pr create`. */
export async function createPullRequest(
  cwd: string,
  title: string,
  body: string,
  githubHostname?: string
): Promise<string> {
  const result = await runRequired('gh', ['pr', 'create', '--title', title, '--body', body], {
    cwd,
    timeoutMs: 120_000,
    env: envWithGithubHost(githubHostname)
  });

  return result.stdout.trim();
}

/** Return the existing PR URL for a branch, if any. */
export async function findPullRequestForBranch(
  cwd: string,
  branch: string,
  githubHostname?: string
): Promise<string | undefined> {
  const result = await runCommand('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
    cwd,
    timeoutMs: 30_000,
    env: envWithGithubHost(githubHostname)
  });

  if (result.code !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}

type RiskLevel = 'read' | 'write' | 'unsafe';

interface ObsidianCommandSpec {
  command: string;
  risk: RiskLevel;
  description: string;
  pathParams?: string[];
  folderParams?: string[];
}

const obsidianSpecs: ObsidianCommandSpec[] = [
  { command: 'help', risk: 'read', description: 'Show Obsidian CLI help.' },
  { command: 'version', risk: 'read', description: 'Show Obsidian version.' },
  { command: 'reload', risk: 'unsafe', description: 'Reload the app window.' },
  { command: 'restart', risk: 'unsafe', description: 'Restart the app.' },
  { command: 'bases', risk: 'read', description: 'List base files.' },
  { command: 'base:views', risk: 'read', description: 'List views in a base.', pathParams: ['path'] },
  { command: 'base:create', risk: 'write', description: 'Create a new base item.', pathParams: ['path'] },
  { command: 'base:query', risk: 'read', description: 'Query a base.', pathParams: ['path'] },
  { command: 'bookmarks', risk: 'read', description: 'List bookmarks.' },
  { command: 'bookmark', risk: 'write', description: 'Add a bookmark.', pathParams: ['file', 'folder'] },
  { command: 'commands', risk: 'read', description: 'List command IDs.' },
  { command: 'command', risk: 'unsafe', description: 'Execute an arbitrary Obsidian command.' },
  { command: 'hotkeys', risk: 'read', description: 'List hotkeys.' },
  { command: 'hotkey', risk: 'read', description: 'Get a hotkey.' },
  { command: 'daily', risk: 'write', description: 'Open daily note.' },
  { command: 'daily:path', risk: 'read', description: 'Get daily note path.' },
  { command: 'daily:read', risk: 'read', description: 'Read daily note.' },
  { command: 'daily:append', risk: 'write', description: 'Append to daily note.' },
  { command: 'daily:prepend', risk: 'write', description: 'Prepend to daily note.' },
  { command: 'diff', risk: 'read', description: 'List or compare file versions.', pathParams: ['path'] },
  { command: 'history', risk: 'read', description: 'List local file history.', pathParams: ['path'] },
  { command: 'history:list', risk: 'read', description: 'List files with local history.' },
  { command: 'history:read', risk: 'read', description: 'Read a local history version.', pathParams: ['path'] },
  { command: 'history:restore', risk: 'unsafe', description: 'Restore a local history version.', pathParams: ['path'] },
  { command: 'history:open', risk: 'unsafe', description: 'Open file recovery.', pathParams: ['path'] },
  { command: 'file', risk: 'read', description: 'Show file info.', pathParams: ['path'] },
  { command: 'files', risk: 'read', description: 'List files.', folderParams: ['folder'] },
  { command: 'folder', risk: 'read', description: 'Show folder info.', folderParams: ['path'] },
  { command: 'folders', risk: 'read', description: 'List folders.', folderParams: ['folder'] },
  { command: 'open', risk: 'read', description: 'Open a file in Obsidian.', pathParams: ['path'] },
  { command: 'create', risk: 'write', description: 'Create or overwrite a file.', pathParams: ['path'] },
  { command: 'read', risk: 'read', description: 'Read file contents.', pathParams: ['path'] },
  { command: 'append', risk: 'write', description: 'Append to a file.', pathParams: ['path'] },
  { command: 'prepend', risk: 'write', description: 'Prepend to a file.', pathParams: ['path'] },
  { command: 'move', risk: 'write', description: 'Move or rename a file.', pathParams: ['path', 'to'] },
  { command: 'rename', risk: 'write', description: 'Rename a file.', pathParams: ['path'] },
  { command: 'delete', risk: 'write', description: 'Delete a file.', pathParams: ['path'] },
  { command: 'backlinks', risk: 'read', description: 'List backlinks.', pathParams: ['path'] },
  { command: 'links', risk: 'read', description: 'List outgoing links.', pathParams: ['path'] },
  { command: 'unresolved', risk: 'read', description: 'List unresolved links.' },
  { command: 'orphans', risk: 'read', description: 'List orphan notes.' },
  { command: 'deadends', risk: 'read', description: 'List dead-end notes.' },
  { command: 'outline', risk: 'read', description: 'Show headings.', pathParams: ['path'] },
  { command: 'plugins', risk: 'read', description: 'List plugins.' },
  { command: 'plugins:enabled', risk: 'read', description: 'List enabled plugins.' },
  { command: 'plugins:restrict', risk: 'unsafe', description: 'Toggle/check restricted mode.' },
  { command: 'plugin', risk: 'read', description: 'Get plugin info.' },
  { command: 'plugin:enable', risk: 'unsafe', description: 'Enable a plugin.' },
  { command: 'plugin:disable', risk: 'unsafe', description: 'Disable a plugin.' },
  { command: 'plugin:install', risk: 'unsafe', description: 'Install a community plugin.' },
  { command: 'plugin:uninstall', risk: 'unsafe', description: 'Uninstall a community plugin.' },
  { command: 'plugin:reload', risk: 'unsafe', description: 'Reload a plugin.' },
  { command: 'aliases', risk: 'read', description: 'List aliases.', pathParams: ['path'] },
  { command: 'properties', risk: 'read', description: 'List properties.', pathParams: ['path'] },
  { command: 'property:set', risk: 'write', description: 'Set a property.', pathParams: ['path'] },
  { command: 'property:remove', risk: 'write', description: 'Remove a property.', pathParams: ['path'] },
  { command: 'property:read', risk: 'read', description: 'Read a property.', pathParams: ['path'] },
  { command: 'publish:site', risk: 'unsafe', description: 'Show publish site info.' },
  { command: 'publish:list', risk: 'unsafe', description: 'List published files.' },
  { command: 'publish:status', risk: 'unsafe', description: 'List publish changes.' },
  { command: 'publish:add', risk: 'unsafe', description: 'Publish a file.', pathParams: ['path'] },
  { command: 'publish:remove', risk: 'unsafe', description: 'Unpublish a file.', pathParams: ['path'] },
  { command: 'publish:open', risk: 'unsafe', description: 'Open published file.', pathParams: ['path'] },
  { command: 'random', risk: 'read', description: 'Open a random note.', folderParams: ['folder'] },
  { command: 'random:read', risk: 'read', description: 'Read a random note.', folderParams: ['folder'] },
  { command: 'search', risk: 'read', description: 'Search file paths.', folderParams: ['path'] },
  { command: 'search:context', risk: 'read', description: 'Search with line context.', folderParams: ['path'] },
  { command: 'search:open', risk: 'read', description: 'Open search view.' },
  { command: 'sync', risk: 'unsafe', description: 'Pause or resume sync.' },
  { command: 'sync:status', risk: 'read', description: 'Show sync status.' },
  { command: 'sync:history', risk: 'read', description: 'List sync history.', pathParams: ['path'] },
  { command: 'sync:read', risk: 'read', description: 'Read a sync version.', pathParams: ['path'] },
  { command: 'sync:restore', risk: 'unsafe', description: 'Restore a sync version.', pathParams: ['path'] },
  { command: 'sync:open', risk: 'unsafe', description: 'Open sync history.', pathParams: ['path'] },
  { command: 'sync:deleted', risk: 'read', description: 'List sync deleted files.' },
  { command: 'tags', risk: 'read', description: 'List tags.', pathParams: ['path'] },
  { command: 'tag', risk: 'read', description: 'Get tag info.' },
  { command: 'tasks', risk: 'read', description: 'List tasks.', pathParams: ['path'] },
  { command: 'task', risk: 'write', description: 'Show or update a task.', pathParams: ['path'] },
  { command: 'templates', risk: 'read', description: 'List templates.' },
  { command: 'template:read', risk: 'read', description: 'Read a template.' },
  { command: 'template:insert', risk: 'write', description: 'Insert template into active file.' },
  { command: 'themes', risk: 'read', description: 'List themes.' },
  { command: 'theme', risk: 'read', description: 'Show active theme or theme info.' },
  { command: 'theme:set', risk: 'unsafe', description: 'Set active theme.' },
  { command: 'theme:install', risk: 'unsafe', description: 'Install a community theme.' },
  { command: 'theme:uninstall', risk: 'unsafe', description: 'Uninstall a theme.' },
  { command: 'snippets', risk: 'read', description: 'List snippets.' },
  { command: 'snippets:enabled', risk: 'read', description: 'List enabled snippets.' },
  { command: 'snippet:enable', risk: 'unsafe', description: 'Enable a CSS snippet.' },
  { command: 'snippet:disable', risk: 'unsafe', description: 'Disable a CSS snippet.' },
  { command: 'unique', risk: 'write', description: 'Create unique note.' },
  { command: 'vault', risk: 'read', description: 'Show vault info.' },
  { command: 'vaults', risk: 'unsafe', description: 'List known vaults; blocked to avoid leaking other vault names.' },
  { command: 'vault:open', risk: 'unsafe', description: 'Switch vault in TUI only.' },
  { command: 'web', risk: 'unsafe', description: 'Open URL in web viewer.' },
  { command: 'wordcount', risk: 'read', description: 'Count words and characters.', pathParams: ['path'] },
  { command: 'workspace', risk: 'read', description: 'Show workspace tree.' },
  { command: 'workspaces', risk: 'read', description: 'List workspaces.' },
  { command: 'workspace:save', risk: 'unsafe', description: 'Save current layout as workspace.' },
  { command: 'workspace:load', risk: 'unsafe', description: 'Load a saved workspace.' },
  { command: 'workspace:delete', risk: 'unsafe', description: 'Delete a saved workspace.' },
  { command: 'tabs', risk: 'read', description: 'List open tabs.' },
  { command: 'tab:open', risk: 'unsafe', description: 'Open a new tab.' },
  { command: 'recents', risk: 'unsafe', description: 'List recently opened files; blocked to avoid leaking other note names.' },
  { command: 'devtools', risk: 'unsafe', description: 'Toggle developer tools.' },
  { command: 'dev:debug', risk: 'unsafe', description: 'Attach/detach debugger.' },
  { command: 'dev:cdp', risk: 'unsafe', description: 'Run Chrome DevTools Protocol command.' },
  { command: 'dev:errors', risk: 'unsafe', description: 'Show captured JavaScript errors.' },
  { command: 'dev:screenshot', risk: 'unsafe', description: 'Take a screenshot.' },
  { command: 'dev:console', risk: 'unsafe', description: 'Show console messages.' },
  { command: 'dev:css', risk: 'unsafe', description: 'Inspect CSS.' },
  { command: 'dev:dom', risk: 'unsafe', description: 'Query DOM.' },
  { command: 'dev:mobile', risk: 'unsafe', description: 'Toggle mobile emulation.' },
  { command: 'eval', risk: 'unsafe', description: 'Execute JavaScript.' }
];

export const obsidianCommandSpecs = obsidianSpecs;

const obsidianCommandMap = new Map(obsidianSpecs.map(spec => [spec.command, spec]));

/** Map an Obsidian CLI subcommand to a safe MCP tool name. */
export function toolNameForObsidianCommand(command: string): string {
  return command.replace(/[:]/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
}

export type ObsidianParams = Record<string, string | number | boolean | undefined>;

interface ScopedObsidianCall {
  config: AppConfig;
  vaultName: string;
  command: string;
  params?: ObsidianParams;
  flags?: string[];
}

interface ObsidianCallResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

/** Search roots for default `search` when `path` is omitted (vault root + common mount). */
function visibleSearchFolders(_config: AppConfig): string[] {
  return ['.', VAULT_RELATIVE_COMMON_MOUNT];
}

/** Run a whitelisted Obsidian CLI command with vault and path scoping. */
export async function runScopedObsidianCommand(call: ScopedObsidianCall): Promise<ObsidianCallResult | ObsidianCallResult[]> {
  const spec = obsidianCommandMap.get(call.command);
  if (!spec) {
    throw new UserError(`Unsupported Obsidian CLI command: ${call.command}`);
  }

  if (spec.risk === 'unsafe') {
    throw new UserError(`Blocked unsafe Obsidian CLI command: ${call.command}`);
  }

  const params = { ...(call.params ?? {}) };
  const flags = [...(call.flags ?? [])];
  rejectDangerousFlags(call.command, flags);
  enforceSessionVaultParam(call.vaultName, params);
  enforceScope(call.config, spec, params);

  if ((call.command === 'search' || call.command === 'search:context') && !params.path) {
    return await Promise.all(
      visibleSearchFolders(call.config).map(folder =>
        invokeObsidian(call.vaultName, call.command, { ...params, path: folder }, flags)
      )
    );
  }

  if (call.command === 'files' && !params.folder) {
    params.folder = '.';
  }

  if (call.command === 'folders' && !params.folder) {
    params.folder = '.';
  }

  return await invokeObsidian(call.vaultName, call.command, params, flags);
}

/** Low-level `obsidian` CLI invocation with assembled args. */
async function invokeObsidian(
  vaultName: string,
  command: string,
  params: ObsidianParams,
  flags: string[]
): Promise<ObsidianCallResult> {
  const args = [`vault=${vaultName}`, command, ...paramsToArgs(params), ...flags];
  const result = await runRequired('obsidian', args, { timeoutMs: 120_000 });
  return {
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

/** Strip redundant `vault` param if it matches the session vault. */
function enforceSessionVaultParam(vaultName: string, params: ObsidianParams): void {
  if (!('vault' in params) || params.vault === undefined) {
    return;
  }
  const requested = String(params.vault).trim();
  const allowed = vaultName.trim();
  if (requested === allowed) {
    delete params.vault;
    return;
  }
  throw new UserError(
    `Changing the Obsidian vault is not allowed in this session. This connection is scoped to vault "${allowed}". Remove the "vault" parameter (it is set automatically).`
  );
}

/** Normalize path/folder params through vault scope rules for read vs write. */
function enforceScope(config: AppConfig, spec: ObsidianCommandSpec, params: ObsidianParams): void {
  for (const key of spec.pathParams ?? []) {
    const value = params[key];
    if (typeof value !== 'string') {
      continue;
    }
    params[key] = spec.risk === 'write' ? checkWritableProjectPath(config, value) : checkReadablePath(config, value).relativePath;
  }

  for (const key of spec.folderParams ?? []) {
    const value = params[key];
    if (typeof value !== 'string') {
      continue;
    }
    params[key] = spec.risk === 'write' ? checkWritableProjectPath(config, value) : checkReadablePath(config, value).relativePath;
  }

  if (spec.risk === 'write') {
    const hasPath = [...(spec.pathParams ?? []), ...(spec.folderParams ?? [])].some(key => typeof params[key] === 'string');
    if (!hasPath) {
      throw new UserError(`Write command requires an explicit project-scoped path: ${spec.command}`);
    }
  }
}

/** Block flags that escape scope (permanent delete, clipboard, vault override). */
function rejectDangerousFlags(command: string, flags: string[]): void {
  if (command === 'delete' && flags.includes('permanent')) {
    throw new UserError('Permanent delete is blocked.');
  }

  if (flags.includes('--copy')) {
    throw new UserError('--copy is blocked because clipboard writes are outside the MCP scope.');
  }

  for (const f of flags) {
    if (/^vault(?:=|$)/.test(f) || /^--vault(?:=|$)/.test(f)) {
      throw new UserError(
        'Changing the Obsidian vault is not allowed in this session. Do not pass vault as a flag; it is set automatically for this connection.'
      );
    }
  }
}

/** Flatten params into `key=value` CLI arguments (boolean becomes flag presence). */
function paramsToArgs(params: ObsidianParams): string[] {
  return Object.entries(params).flatMap(([key, value]) => {
    if (value === undefined || value === false) {
      return [];
    }
    if (value === true) {
      return [key];
    }

    return [`${key}=${String(value)}`];
  });
}
