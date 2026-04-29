import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { AppConfig } from '../config/schema.js';
import { UserError, errorMessage } from '../errors.js';
import { checkoutBranch, commitIfNeeded } from '../git/repo.js';
import { assertGhReady, createPullRequest } from '../github/gh.js';
import { ObsidianParams, runScopedObsidianCommand } from '../obsidian/cli.js';
import { runRequired } from '../platform/command.js';
import { obsidianCommandSpecs, toolNameForObsidianCommand } from '../obsidian/spec.js';
import { checkReadablePath, checkWritableProjectPath, defaultProjectNotePath, normalizeVaultRelativePath } from '../policy/paths.js';
import { findForbiddenLinks } from '../policy/links.js';
import { commonLayout, projectLayout } from '../vaults/layout.js';

const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const flagsSchema = z.array(z.string()).optional();

export function createProjectMcpServer(config: AppConfig, project: string): McpServer {
  const layout = projectLayout(config, project);
  const vaultName = layout.repoName;
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
    'project_info',
    {
      title: 'Project Info',
      description: 'Show the active obsidian-project scope.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => textResult({ project, vaultName, vaultPath: layout.vaultPath, writableRoot: `${config.folderStructure.wiki}/${config.folderStructure.projectWiki}` })
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List Notes',
      description: 'List visible notes in the current project scope.',
      inputSchema: {
        location: z.enum(['all', 'project', 'common']).default('all')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ location }) => {
      const folders =
        location === 'project'
          ? [`${config.folderStructure.wiki}/${config.folderStructure.projectWiki}`]
          : location === 'common'
            ? [`${config.folderStructure.wiki}/${config.folderStructure.commonWiki}`]
            : [
                `${config.folderStructure.wiki}/${config.folderStructure.projectWiki}`,
                `${config.folderStructure.wiki}/${config.folderStructure.commonWiki}`
              ];
      const results = [];
      for (const folder of folders) {
        results.push(
          await runScopedObsidianCommand({
            config,
            vaultName,
            command: 'files',
            params: { folder, ext: 'md' }
          })
        );
      }
      return textResult(results);
    }
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read Note',
      description: 'Read a project or common note within the current scope.',
      inputSchema: {
        path: z.string()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async input => {
      const notePath = normalizeReadPath(config, input.path);
      return textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'read',
          params: { path: notePath }
        })
      );
    }
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search Notes',
      description: 'Search only visible project/common notes.',
      inputSchema: {
        query: z.string(),
        location: z.enum(['all', 'project', 'common']).default('all'),
        limit: z.number().int().positive().max(100).optional(),
        context: z.boolean().default(false),
        caseSensitive: z.boolean().default(false)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async input => {
      const folders =
        input.location === 'project'
          ? [`${config.folderStructure.wiki}/${config.folderStructure.projectWiki}`]
          : input.location === 'common'
            ? [`${config.folderStructure.wiki}/${config.folderStructure.commonWiki}`]
            : [
                `${config.folderStructure.wiki}/${config.folderStructure.projectWiki}`,
                `${config.folderStructure.wiki}/${config.folderStructure.commonWiki}`
              ];
      const results = [];
      for (const folder of folders) {
        results.push(
          await runScopedObsidianCommand({
            config,
            vaultName,
            command: input.context ? 'search:context' : 'search',
            params: { query: input.query, path: folder, limit: input.limit, format: 'json' },
            flags: input.caseSensitive ? ['case'] : []
          })
        );
      }
      return textResult(results);
    }
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Get Backlinks',
      description: 'Return backlinks to a visible note.',
      inputSchema: {
        path: z.string(),
        counts: z.boolean().default(true)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async input =>
      textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'backlinks',
          params: { path: normalizeReadPath(config, input.path), format: 'json' },
          flags: input.counts ? ['counts'] : []
        })
      )
  );

  server.registerTool(
    'get_outgoing_links',
    {
      title: 'Get Outgoing Links',
      description: 'Return outgoing links from a visible note.',
      inputSchema: {
        path: z.string()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async input =>
      textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'links',
          params: { path: normalizeReadPath(config, input.path) }
        })
      )
  );

  server.registerTool(
    'write_project_note',
    {
      title: 'Write Project Note',
      description: 'Create or replace a project-scoped note.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().default(true)
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async input => {
      const notePath = normalizeWritePath(config, input.path);
      return textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'create',
          params: { path: notePath, content: input.content },
          flags: input.overwrite ? ['overwrite'] : []
        })
      );
    }
  );

  server.registerTool(
    'append_project_note',
    {
      title: 'Append Project Note',
      description: 'Append content to a project-scoped note.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        inline: z.boolean().default(false)
      },
      annotations: {
        openWorldHint: false
      }
    },
    async input =>
      textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'append',
          params: { path: normalizeWritePath(config, input.path), content: input.content },
          flags: input.inline ? ['inline'] : []
        })
      )
  );

  server.registerTool(
    'patch_project_note',
    {
      title: 'Patch Project Note',
      description: 'Patch a project note by replacing exact text.',
      inputSchema: {
        path: z.string(),
        oldText: z.string(),
        newText: z.string()
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async input => {
      const notePath = normalizeWritePath(config, input.path);
      const read = await runScopedObsidianCommand({ config, vaultName, command: 'read', params: { path: notePath } });
      const text = Array.isArray(read) ? read.map(item => item.stdout).join('\n') : read.stdout;
      if (!text.includes(input.oldText)) {
        throw new UserError('Patch failed: oldText was not found.');
      }
      const next = text.replace(input.oldText, input.newText);
      return textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'create',
          params: { path: notePath, content: next },
          flags: ['overwrite']
        })
      );
    }
  );

  server.registerTool(
    'move_project_note',
    {
      title: 'Move Project Note',
      description: 'Move a project note within the project wiki.',
      inputSchema: {
        fromPath: z.string(),
        toPath: z.string()
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async input =>
      textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'move',
          params: { path: normalizeWritePath(config, input.fromPath), to: normalizeWritePath(config, input.toPath) }
        })
      )
  );

  server.registerTool(
    'delete_project_note',
    {
      title: 'Delete Project Note',
      description: 'Delete a project-scoped note using Obsidian trash behavior.',
      inputSchema: {
        path: z.string()
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async input =>
      textResult(
        await runScopedObsidianCommand({
          config,
          vaultName,
          command: 'delete',
          params: { path: normalizeWritePath(config, input.path) }
        })
      )
  );

  server.registerTool(
    'request_common_update',
    {
      title: 'Request Common Update',
      description: 'Create a GitHub PR proposing a common vault note update.',
      inputSchema: {
        path: z.string(),
        content: z.string(),
        title: z.string(),
        reasoning: z.string(),
        mode: z.enum(['replace', 'append']).default('replace')
      },
      annotations: {
        openWorldHint: true
      }
    },
    async input => textResult(await requestCommonUpdate(config, project, input))
  );

  server.registerTool(
    'obsidian_cli_spec',
    {
      title: 'Obsidian CLI Spec',
      description: 'Show the wrapped Obsidian CLI command spec and risk policy.',
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
        title: `obsidian ${spec.command}`,
        description: `${spec.description} Risk: ${spec.risk}. Unsafe commands return a policy error.`,
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

function normalizeReadPath(config: AppConfig, input: string): string {
  const normalized = normalizeVaultRelativePath(input);
  const fs = config.folderStructure;
  const withDefault = normalized.startsWith(`${fs.wiki}/`)
    ? normalized
    : normalized === fs.commonWiki || normalized.startsWith(`${fs.commonWiki}/`)
      ? `${fs.wiki}/${normalized}`
      : normalized === fs.projectWiki || normalized.startsWith(`${fs.projectWiki}/`)
        ? `${fs.wiki}/${normalized}`
        : defaultProjectNotePath(config, normalized);
  return checkReadablePath(config, withDefault).relativePath;
}

function normalizeWritePath(config: AppConfig, input: string): string {
  return checkWritableProjectPath(config, defaultProjectNotePath(config, input));
}

async function requestCommonUpdate(
  config: AppConfig,
  project: string,
  input: { path: string; content: string; title: string; reasoning: string; mode: 'replace' | 'append' }
): Promise<Record<string, string>> {
  await assertGhReady();
  const common = commonLayout(config);
  const targetPath = commonRepoPath(config, input.path);
  const absoluteTarget = path.join(common.vaultPath, targetPath);
  const currentBranch = `common-update/${project}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const violations = findForbiddenLinks(config, `${config.folderStructure.wiki}/${config.folderStructure.commonWiki}/${path.basename(targetPath)}`, input.content);
  if (violations.length > 0) {
    throw new UserError(`Common update contains forbidden project links: ${JSON.stringify(violations)}`);
  }

  await checkoutBranch(common.vaultPath, currentBranch);
  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
  if (input.mode === 'append') {
    await fs.appendFile(absoluteTarget, input.content, 'utf8');
  } else {
    await fs.writeFile(absoluteTarget, input.content, 'utf8');
  }

  await commitIfNeeded(common.vaultPath, input.title);
  await runRequired('git', ['push', '-u', 'origin', currentBranch], { cwd: common.vaultPath, timeoutMs: 120_000 });
  const body = [`Reasoning:`, '', input.reasoning, '', `Requested from project: ${project}`].join('\n');
  const prUrl = await createPullRequest(common.vaultPath, input.title, body);

  return {
    branch: currentBranch,
    path: targetPath,
    prUrl
  };
}

function commonRepoPath(config: AppConfig, input: string): string {
  const normalized = normalizeVaultRelativePath(input);
  const fs = config.folderStructure;
  let relative: string;

  if (normalized.startsWith(`${fs.wiki}/${fs.commonWiki}/`)) {
    relative = normalized.slice(`${fs.wiki}/${fs.commonWiki}/`.length);
  } else if (normalized.startsWith(`${fs.commonWiki}/`)) {
    relative = normalized.slice(`${fs.commonWiki}/`.length);
  } else if (normalized.startsWith(`${fs.wiki}/`)) {
    relative = normalized.slice(`${fs.wiki}/`.length);
  } else {
    relative = normalized;
  }

  const target = `${fs.wiki}/${relative}`;
  normalizeVaultRelativePath(target);
  return target;
}

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

export function mcpErrorResult(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: errorMessage(error)
      }
    ],
    isError: true
  };
}
