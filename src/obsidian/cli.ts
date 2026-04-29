import { AppConfig } from '../config/schema.js';
import { UserError } from '../errors.js';
import { runCommand, runRequired } from '../platform/command.js';
import { checkReadablePath, checkWritableProjectPath, visibleSearchFolders } from '../policy/paths.js';
import { ObsidianCommandSpec, obsidianCommandMap } from './spec.js';

export type ObsidianParams = Record<string, string | number | boolean | undefined>;

export interface ScopedObsidianCall {
  config: AppConfig;
  vaultName: string;
  command: string;
  params?: ObsidianParams;
  flags?: string[];
}

export interface ObsidianCallResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

export async function assertObsidianCliReady(): Promise<string> {
  const version = await runCommand('obsidian', ['version'], { timeoutMs: 30_000 });
  if (version.code !== 0) {
    throw new UserError(
      'Obsidian CLI is not available. Install Obsidian 1.12.7+, enable Settings > General > Command line interface, and restart your terminal.'
    );
  }

  return version.stdout.trim();
}

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
  enforceScope(call.config, spec, params);

  if ((call.command === 'search' || call.command === 'search:context') && !params.path) {
    return await Promise.all(
      visibleSearchFolders(call.config).map(folder =>
        invokeObsidian(call.vaultName, call.command, { ...params, path: folder }, flags)
      )
    );
  }

  if (call.command === 'files' && !params.folder) {
    params.folder = call.config.folderStructure.wiki;
  }

  if (call.command === 'folders' && !params.folder) {
    params.folder = call.config.folderStructure.wiki;
  }

  return await invokeObsidian(call.vaultName, call.command, params, flags);
}

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

function rejectDangerousFlags(command: string, flags: string[]): void {
  if (command === 'delete' && flags.includes('permanent')) {
    throw new UserError('Permanent delete is blocked.');
  }

  if (flags.includes('--copy')) {
    throw new UserError('--copy is blocked because clipboard writes are outside the MCP scope.');
  }
}

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
