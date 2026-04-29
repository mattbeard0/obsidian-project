import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';

import { sanitizeProjectName } from '../config/load.js';
import { AppConfig } from '../config/schema.js';
import { UserError, errorMessage } from '../errors.js';
import { assertGhReady } from '../github/gh.js';
import { assertObsidianCliReady } from '../obsidian/cli.js';
import { projectLayout } from '../vaults/layout.js';
import { createProjectMcpServer } from './mcp.js';

export interface ServerOptions {
  port: number;
  shutdownToken: string;
}

export async function runMcpHttpServer(config: AppConfig, options: ServerOptions): Promise<http.Server> {
  const obsidianVersion = await assertObsidianCliReady();
  const account = await assertGhReady();
  console.log(`Obsidian CLI ready: ${obsidianVersion}`);
  console.log(`GitHub CLI ready: ${account.login}${account.name ? ` (${account.name})` : ''}`);

  const app = createMcpExpressApp({ host: config.server.host });
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
        const server = createProjectMcpServer(config, project);
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
    const server = app.listen(options.port, config.server.host, () => resolve(server));
    server.on('error', reject);
  });
}

async function projectFromRequest(config: AppConfig, req: Request): Promise<string> {
  const raw = req.header('x-obsidian-project');
  if (!raw) {
    throw new UserError('Missing required x-obsidian-project header.');
  }

  const project = sanitizeProjectName(raw);
  if (project === config.commonProjectName) {
    throw new UserError('MCP sessions must target a project vault, not the common vault directly.');
  }

  const layout = projectLayout(config, project);
  try {
    await fs.access(layout.vaultPath);
  } catch {
    throw new UserError(`Unknown obsidian-project vault: ${project}`);
  }

  return project;
}

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
