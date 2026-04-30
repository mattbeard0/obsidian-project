import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

import { AppConfig, sanitizeProjectName } from '../config/config.js';
import { UserError, errorMessage } from '../functions/errors.js';
import { refreshCodexProfilesForPort } from '../functions/codex/config.js';
import { assertGhReady, assertObsidianCliReady, type GitHubAccount } from '../functions/dependency/dependencyCheck.js';
import { commitIfNeeded } from '../functions/git/index.js';
import {
  createPullRequest,
  findPullRequestForBranch,
  obsidianCommandSpecs,
  runScopedObsidianCommand,
  toolNameForObsidianCommand,
  type ObsidianParams
} from './obsidianCommandRuntime.js';
import { findForbiddenLinks } from './noteLinkPolicy.js';
import { displayPath, redactHomeInText, serverLogPath, serverStatePath, stateDir } from '../functions/platform/paths.js';
import { runCommand, runRequired } from '../functions/platform/shell.js';
import { normalizeVaultRelativePath } from '../functions/platform/vaultScopes.js';
import { resolveCommonVaultPaths, resolveProjectVaultPaths } from '../functions/vaults/vaults.js';

/** Check out an existing branch or create it if missing. */
async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  const exists = await runCommand('git', ['rev-parse', '--verify', branch], { cwd, timeoutMs: 10_000 });
  if (exists.code === 0) {
    await runRequired('git', ['checkout', branch], { cwd, timeoutMs: 30_000 });
    return;
  }

  await runRequired('git', ['checkout', '-b', branch], { cwd, timeoutMs: 30_000 });
}

// --- Process-spawned HTTP server (state, health, shutdown) ---

interface ServerState {
  pid: number;
  host: string;
  port: number;
  shutdownToken: string;
  startedAt: string;
}

interface StartResult {
  state: ServerState;
  account: GitHubAccount;
  obsidianVersion: string;
  alreadyRunning: boolean;
}

/** Start the detached MCP HTTP server (or return early if already healthy), refresh Codex profiles, persist state. */
export async function startServer(config: AppConfig): Promise<StartResult> {
  const existing = await readServerState();
  if (existing && (await health(existing))) {
    return {
      state: existing,
      account: await assertGhReady(config.github.hostname),
      obsidianVersion: await assertObsidianCliReady(),
      alreadyRunning: true
    };
  }

  const obsidianVersion = await assertObsidianCliReady();
  const account = await assertGhReady(config.github.hostname);
  const port = config.server.preferredPort;
  await assertPortAvailable('127.0.0.1', port);
  const shutdownToken = randomBytes(24).toString('hex');
  const logFile = serverLogPath();
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const out = fsSync.openSync(logFile, 'a');
  const err = fsSync.openSync(logFile, 'a');

  const child = spawnDetachedServer(port, shutdownToken, out, err);
  fsSync.closeSync(out);
  fsSync.closeSync(err);
  const state: ServerState = {
    pid: child.pid ?? 0,
    host: '127.0.0.1',
    port,
    shutdownToken,
    startedAt: new Date().toISOString()
  };

  const ready = await waitForHealth(state, 15_000);
  if (!ready) {
    throw new UserError(`Server did not become healthy. See log: ${displayPath(logFile)}`);
  }

  await writeServerState(state);
  await refreshCodexProfilesForPort(config, port);

  return {
    state,
    account,
    obsidianVersion,
    alreadyRunning: false
  };
}

/** Request shutdown on the child server and remove state file. */
export async function stopServer(): Promise<boolean> {
  const state = await readServerState();
  if (!state) {
    return false;
  }

  try {
    await fetch(`http://${state.host}:${state.port}/shutdown`, {
      method: 'POST',
      headers: {
        'x-obsidian-project-token': state.shutdownToken
      }
    });
  } catch {
    if (state.pid) {
      try {
        process.kill(state.pid);
      } catch {
        // Process is already gone.
      }
    }
  }

  await fs.rm(serverStatePath(), { force: true });
  return true;
}

/** Read persisted server pid/port/token, if any. */
export async function readServerState(): Promise<ServerState | undefined> {
  try {
    const raw = await fs.readFile(serverStatePath(), 'utf8');
    return JSON.parse(raw) as ServerState;
  } catch {
    return undefined;
  }
}

/** Write server metadata alongside logs under state dir. */
async function writeServerState(state: ServerState): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(serverStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Spawn the CLI `serve` subprocess detached with stdio redirected to the log file. */
function spawnDetachedServer(port: number, token: string, out: number, err: number) {
  const entry = process.argv[1];
  const args = buildServeArgs(entry, port, token);
  const child = spawn(args.command, args.args, {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true
  });
  child.unref();
  return child;
}

/** Build argv for running this CLI entry in dev (`tsx`) vs installed (`node`). */
function buildServeArgs(entry: string, port: number, token: string): { command: string; args: string[] } {
  if (entry.endsWith('.ts')) {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['tsx', entry, 'serve', '--port', String(port), '--token', token]
    };
  }

  return {
    command: process.execPath,
    args: [entry, 'serve', '--port', String(port), '--token', token]
  };
}

/** Fail fast if something already listens on host:port. */
async function assertPortAvailable(host: string, port: number): Promise<void> {
  if (!(await canListen(host, port))) {
    throw new UserError(
      `MCP port ${port} is already in use. Set a different server.preferredPort in config (first-time: obsidian-project with --port) or free this port.`
    );
  }
}

/** True if we can bind briefly to host:port (port free). */
async function canListen(host: string, port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** Poll /health until ok or timeout. */
async function waitForHealth(state: ServerState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(state)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  return false;
}

/** GET /health on the child server. */
async function health(state: ServerState): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// --- Per-project MCP tool server ---

const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const flagsSchema = z.array(z.string()).optional();

interface ProjectMcpServerOptions {
  chatId?: string;
}

/** Build an MCP server for one project: common-update tool, CLI spec, and wrapped Obsidian commands. */
function createProjectMcpServer(config: AppConfig, project: string, options: ProjectMcpServerOptions = {}): McpServer {
  const projectPaths = resolveProjectVaultPaths(config, project);
  const vaultName = projectPaths.repoName;
  const server = new McpServer(
    {
      name: `obsidian-project-${project}`,
      version: '0.1.0'
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    'request_common_update',
    {
      title: 'Request Common Update',
      description: 'Create a GitHub PR proposing a diff-only common vault note update.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'Vault-relative path to the shared note in the common vault. From the project vault, use paths under your configured note-library and shared-scope folders (see vault-config folderStructure).'
          ),
        diff: z
          .string()
          .describe(
            'Unified git diff to apply in the common vault. Paths in the diff must be under the common vault’s note-library directory (your folderStructure.noteLibrary).'
          ),
        reasoning: z
          .string()
          .describe(
            'Why this change belongs in shared/common knowledge. Explain the reusable pattern or correction, and note why it is not project-specific.'
          )
      },
      annotations: {
        openWorldHint: true
      }
    },
    async input => textResult(await requestCommonUpdate(config, project, input, options))
  );

  server.registerTool(
    'cli_spec',
    {
      title: 'CLI Spec',
      description: 'Show the wrapped Obsidian CLI command spec.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => textResult(obsidianCommandSpecs)
  );

  for (const spec of obsidianCommandSpecs) {
    server.registerTool(
      toolNameForObsidianCommand(spec.command),
      {
        title: spec.command,
        description: spec.description,
        inputSchema: {
          params: paramsSchema,
          flags: flagsSchema
        },
        annotations: {
          readOnlyHint: spec.risk === 'read',
          destructiveHint: spec.risk === 'write' || spec.risk === 'unsafe',
          openWorldHint: spec.risk === 'unsafe'
        }
      },
      async input =>
        textResult(
          await runScopedObsidianCommand({
            config,
            vaultName,
            command: spec.command,
            params: input.params as ObsidianParams | undefined,
            flags: input.flags
          })
        )
    );
  }

  return server;
}

/** Apply a diff in the common vault, push a branch, and open or reuse a PR. */
async function requestCommonUpdate(
  config: AppConfig,
  project: string,
  input: { path: string; diff: string; reasoning: string },
  options: ProjectMcpServerOptions
): Promise<Record<string, string>> {
  await assertGhReady(config.github.hostname);
  const common = resolveCommonVaultPaths(config);
  const targetPath = commonRepoPath(config, input.path);
  const currentBranch = commonUpdateBranch(project, options.chatId);
  const title = `[${path.basename(targetPath)}] Content Update`;

  const layout = config.folderStructure;
  const violations = findForbiddenLinks(
    config,
    `${layout.noteLibrary}/${layout.sharedScope}/${path.basename(targetPath)}`,
    input.diff
  );
  if (violations.length > 0) {
    throw new UserError(`Common update contains forbidden project links: ${JSON.stringify(violations)}`);
  }

  await checkoutBranch(common.vaultPath, currentBranch);
  await validateCommonUpdateDiff(common.vaultPath, input.diff, targetPath);

  await runRequired('git', ['apply', '--'], { cwd: common.vaultPath, input: input.diff, timeoutMs: 30_000 });

  await commitIfNeeded(common.vaultPath, title);
  await runRequired('git', ['push', '-u', 'origin', currentBranch], { cwd: common.vaultPath, timeoutMs: 120_000 });
  const body = ['Reasoning:', '', input.reasoning, '', `Requested from project: ${project}`].join('\n');
  const existingPrUrl = await findPullRequestForBranch(common.vaultPath, currentBranch, config.github.hostname);
  const prUrl = existingPrUrl ?? (await createPullRequest(common.vaultPath, title, body, config.github.hostname));

  return {
    branch: currentBranch,
    path: targetPath,
    title,
    prUrl,
    reusedPr: String(Boolean(existingPrUrl))
  };
}

/** Git branch name for common-vault PRs (optionally namespaced by chat/session id). */
function commonUpdateBranch(project: string, chatId?: string): string {
  const safeProject = branchSegment(project);
  const safeChatId = chatId ? branchSegment(chatId) : undefined;
  return safeChatId ? `codex/${safeProject}/${safeChatId}` : `codex/${safeProject}`;
}

/** Sanitize a string for use as a git branch path segment. */
function branchSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

/** Ensure the proposed diff is a single-file unified diff that applies cleanly. */
async function validateCommonUpdateDiff(commonVaultPath: string, diff: string, targetPath: string): Promise<void> {
  if (!diff.trim()) {
    throw new UserError('Diff validation failed: diff is empty.');
  }

  if (!/^diff --git /m.test(diff)) {
    throw new UserError('Diff validation failed: expected a unified git diff containing at least one "diff --git" header.');
  }

  if (!/^@@ /m.test(diff)) {
    throw new UserError('Diff validation failed: expected at least one unified diff hunk starting with "@@".');
  }

  const paths = extractDiffPaths(diff);
  if (paths.length === 0) {
    throw new UserError('Diff validation failed: diff did not contain any ---/+++ file paths.');
  }

  const normalizedTarget = targetPath.replace(/\\/g, '/');
  const unexpectedPaths = paths.filter(filePath => filePath !== normalizedTarget);
  if (unexpectedPaths.length > 0) {
    throw new UserError(
      `Diff validation failed: diff must only target ${normalizedTarget}. Found extra path(s): ${unexpectedPaths.join(', ')}.`
    );
  }

  if (!paths.includes(normalizedTarget)) {
    throw new UserError(`Diff validation failed: diff must target ${normalizedTarget}. Found: ${paths.join(', ')}.`);
  }

  const check = await runCommand('git', ['apply', '--check', '--'], {
    cwd: commonVaultPath,
    input: diff,
    timeoutMs: 30_000
  });
  if (check.code !== 0) {
    const detail = redactHomeInText((check.stderr || check.stdout || 'git apply --check failed without output.').trim());
    throw new UserError(`Diff validation failed: git could not parse or apply the diff.\n${detail}`);
  }
}

/** Collect normalized file paths from unified diff ---/+++ lines. */
function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) {
      continue;
    }

    const raw = line.slice(4).trim().split(/\s+/)[0];
    if (!raw || raw === '/dev/null') {
      continue;
    }

    const withoutPrefix = raw.replace(/^[ab]\//, '').replace(/\\/g, '/');
    paths.add(withoutPrefix);
  }

  return [...paths];
}

/** Map user `path` input to a vault-relative path under the common note library. */
function commonRepoPath(config: AppConfig, input: string): string {
  const normalized = normalizeVaultRelativePath(input);
  const layout = config.folderStructure;
  let relative: string;

  if (normalized.startsWith(`${layout.noteLibrary}/${layout.sharedScope}/`)) {
    relative = normalized.slice(`${layout.noteLibrary}/${layout.sharedScope}/`.length);
  } else if (normalized.startsWith(`${layout.sharedScope}/`)) {
    relative = normalized.slice(`${layout.sharedScope}/`.length);
  } else if (normalized.startsWith(`${layout.noteLibrary}/`)) {
    relative = normalized.slice(`${layout.noteLibrary}/`.length);
  } else {
    relative = normalized;
  }

  const target = `${layout.noteLibrary}/${relative}`;
  normalizeVaultRelativePath(target);
  return target;
}

/** MCP tool result wrapper for JSON-serializable tool output. */
function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

// --- In-process HTTP + Express MCP transport ---

interface ServerOptions {
  port: number;
  shutdownToken: string;
}

/** In-process Express + Streamable HTTP MCP server (used by `serve` subcommand). */
export async function runMcpHttpServer(config: AppConfig, options: ServerOptions): Promise<http.Server> {
  const obsidianVersion = await assertObsidianCliReady();
  const account = await assertGhReady(config.github.hostname);
  console.log(`Obsidian CLI ready: ${obsidianVersion}`);
  console.log(`GitHub CLI ready: ${account.login}${account.name ? ` (${account.name})` : ''}`);

  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      pid: process.pid,
      port: options.port
    });
  });

  app.post('/shutdown', async (req, res) => {
    if (req.header('x-obsidian-project-token') !== options.shutdownToken) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 50).unref();
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const project = await projectFromRequest(config, req);
        const chatId = chatIdFromRequest(req);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: initializedSessionId => {
            transports[initializedSessionId] = transport;
          }
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            delete transports[sid];
          }
        };
        const server = createProjectMcpServer(config, project, { chatId });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: missing or invalid MCP session.' },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      sendJsonRpcError(res, error);
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing MCP session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  return await new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(options.port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/** Resolve project name from the `x-obsidian-project` header and ensure the vault exists. */
async function projectFromRequest(config: AppConfig, req: Request): Promise<string> {
  const raw = req.header('x-obsidian-project');
  if (!raw) {
    throw new UserError('Missing required x-obsidian-project header.');
  }

  const project = sanitizeProjectName(raw);
  if (project === config.commonProjectName) {
    throw new UserError('MCP sessions must target a project vault, not the common vault directly.');
  }

  const projectPaths = resolveProjectVaultPaths(config, project);
  try {
    await fs.access(projectPaths.vaultPath);
  } catch {
    throw new UserError(`Unknown obsidian-project vault: ${project}`);
  }

  return project;
}

/** Best-effort session id from headers or env for branch namespacing. */
function chatIdFromRequest(req: Request): string | undefined {
  const candidates = [
    req.header('x-obsidian-chat-id'),
    req.header('x-codex-session-id'),
    req.header('x-codex-chat-id'),
    req.header('x-codex-conversation-id'),
    req.header('x-openai-conversation-id'),
    process.env.OBSIDIAN_PROJECT_CHAT_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CODEX_CHAT_ID
  ];

  return candidates.find(value => value && value.trim())?.trim();
}

/** JSON-RPC style error for failed MCP HTTP requests. */
function sendJsonRpcError(res: Response, error: unknown): void {
  if (res.headersSent) {
    return;
  }

  res.status(error instanceof UserError ? 400 : 500).json({
    jsonrpc: '2.0',
    error: {
      code: error instanceof UserError ? -32000 : -32603,
      message: errorMessage(error)
    },
    id: null
  });
}

