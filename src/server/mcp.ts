import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { AppConfig } from '../config/schema.js';
import { UserError, errorMessage } from '../errors.js';
import { checkoutBranch, commitIfNeeded } from '../git/repo.js';
import { assertGhReady, createPullRequest, findPullRequestForBranch } from '../github/gh.js';
import { ObsidianParams, runScopedObsidianCommand } from '../obsidian/cli.js';
import { obsidianCommandSpecs, toolNameForObsidianCommand } from '../obsidian/spec.js';
import { runCommand, runRequired } from '../platform/command.js';
import { findForbiddenLinks } from '../policy/links.js';
import { normalizeVaultRelativePath } from '../policy/paths.js';
import { commonLayout, projectLayout } from '../vaults/layout.js';

const paramsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const flagsSchema = z.array(z.string()).optional();

export interface ProjectMcpServerOptions {
  chatId?: string;
}

export function createProjectMcpServer(config: AppConfig, project: string, options: ProjectMcpServerOptions = {}): McpServer {
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
    'request_common_update',
    {
      title: 'Request Common Update',
      description: 'Create a GitHub PR proposing a diff-only common vault note update.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'Vault-relative path to the common note being updated. Use wiki/common/<file>.md or common/<file>.md from a project vault perspective; this is mapped to wiki/<file>.md in the common vault.'
          ),
        diff: z
          .string()
          .describe(
            'Unified git diff to apply in the common vault. Provide only the patch/diff, not the full replacement file. File paths in the diff should point at the common repo path, usually wiki/<file>.md.'
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

async function requestCommonUpdate(
  config: AppConfig,
  project: string,
  input: { path: string; diff: string; reasoning: string },
  options: ProjectMcpServerOptions
): Promise<Record<string, string>> {
  await assertGhReady();
  const common = commonLayout(config);
  const targetPath = commonRepoPath(config, input.path);
  const currentBranch = commonUpdateBranch(project, options.chatId);
  const title = `[${path.basename(targetPath)}] Content Update`;

  const violations = findForbiddenLinks(
    config,
    `${config.folderStructure.wiki}/${config.folderStructure.commonWiki}/${path.basename(targetPath)}`,
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
  const existingPrUrl = await findPullRequestForBranch(common.vaultPath, currentBranch);
  const prUrl = existingPrUrl ?? (await createPullRequest(common.vaultPath, title, body));

  return {
    branch: currentBranch,
    path: targetPath,
    title,
    prUrl,
    reusedPr: String(Boolean(existingPrUrl))
  };
}

function commonUpdateBranch(project: string, chatId?: string): string {
  const safeProject = branchSegment(project);
  const safeChatId = chatId ? branchSegment(chatId) : undefined;
  return safeChatId ? `codex/${safeProject}/${safeChatId}` : `codex/${safeProject}`;
}

function branchSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

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
    const detail = (check.stderr || check.stdout || 'git apply --check failed without output.').trim();
    throw new UserError(`Diff validation failed: git could not parse or apply the diff.\n${detail}`);
  }
}

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
