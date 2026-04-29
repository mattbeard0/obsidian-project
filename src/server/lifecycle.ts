import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { refreshCodexProfilesForPort } from '../codex/config.js';
import { AppConfig } from '../config/schema.js';
import { UserError } from '../errors.js';
import { assertGhReady, GitHubAccount } from '../github/gh.js';
import { assertObsidianCliReady } from '../obsidian/cli.js';
import { serverLogPath, serverStatePath, stateDir } from '../platform/paths.js';

export interface ServerState {
  pid: number;
  host: string;
  port: number;
  shutdownToken: string;
  startedAt: string;
}

export interface StartResult {
  state: ServerState;
  account: GitHubAccount;
  obsidianVersion: string;
  alreadyRunning: boolean;
}

export async function startServer(config: AppConfig): Promise<StartResult> {
  const existing = await readServerState();
  if (existing && (await health(existing))) {
    return {
      state: existing,
      account: await assertGhReady(),
      obsidianVersion: await assertObsidianCliReady(),
      alreadyRunning: true
    };
  }

  const obsidianVersion = await assertObsidianCliReady();
  const account = await assertGhReady();
  const port = await findAvailablePort(config.server.host, config.server.preferredPort, config.server.maxPortScan);
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
    host: config.server.host,
    port,
    shutdownToken,
    startedAt: new Date().toISOString()
  };

  const ready = await waitForHealth(state, 15_000);
  if (!ready) {
    throw new UserError(`Server did not become healthy. See log: ${logFile}`);
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

export async function readServerState(): Promise<ServerState | undefined> {
  try {
    const raw = await fs.readFile(serverStatePath(), 'utf8');
    return JSON.parse(raw) as ServerState;
  } catch {
    return undefined;
  }
}

async function writeServerState(state: ServerState): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(serverStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

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

async function findAvailablePort(host: string, preferredPort: number, maxScan: number): Promise<number> {
  for (let port = preferredPort; port < preferredPort + maxScan && port <= 65535; port += 1) {
    if (await canListen(host, port)) {
      return port;
    }
  }

  throw new UserError(`No available port found from ${preferredPort} to ${Math.min(preferredPort + maxScan, 65535)}.`);
}

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

async function health(state: ServerState): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
