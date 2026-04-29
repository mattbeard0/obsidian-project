import fs from 'node:fs/promises';
import path from 'node:path';

import { writeCodexProjectProfile } from '../codex/config.js';
import { sanitizeProjectName } from '../config/load.js';
import { AppConfig } from '../config/schema.js';
import { ensureGitRepo } from '../git/repo.js';
import { createGitHubRepo } from '../github/gh.js';
import { createCommonMount } from '../vaults/links.js';
import { commonLayout, projectLayout } from '../vaults/layout.js';
import { UserError } from '../errors.js';

export interface CreateProjectOptions {
  createRemote?: boolean;
  serverPort?: number;
}

export interface CreateProjectResult {
  project: string;
  projectVaultPath: string;
  commonVaultPath: string;
  codexConfigPath: string;
}

export async function createProject(
  config: AppConfig,
  requestedProject: string,
  options: CreateProjectOptions = {}
): Promise<CreateProjectResult> {
  const project = sanitizeProjectName(requestedProject);
  if (!config.commonConfigured) {
    throw new UserError(
      'Common vault is not configured yet. Run "obsidian-project set-common" to select one or "obsidian-project create-common" to create one.'
    );
  }

  const common = commonLayout(config);
  const layout = projectLayout(config, project);
  const serverPort = options.serverPort ?? config.server.preferredPort;

  await ensureVaultFolders(common.vaultPath, common.rawPath, common.wikiPath, common.outputPath);
  await ensureVaultFolders(layout.vaultPath, layout.rawPath, layout.wikiPath, layout.outputPath, layout.projectWikiPath);
  await createCommonMount(layout.commonMountPath, common.wikiPath);
  await copyConfiguredCommonFiles(config, common.vaultPath, layout.vaultPath);
  await writeProjectMetadata(config, project);
  await writeCodexInstructions(config, project);
  await ensureProjectGitignore(config, project);

  await ensureGitRepo(common.vaultPath, 'Initialize common vault');
  await ensureGitRepo(layout.vaultPath, `Initialize ${layout.repoName}`);

  const shouldCreateRemote = options.createRemote ?? config.github.createRemotes;
  if (shouldCreateRemote) {
    await createGitHubRepo({
      owner: config.github.owner,
      repoName: common.repoName,
      cwd: common.vaultPath,
      visibility: config.github.visibility
    });
    await createGitHubRepo({
      owner: config.github.owner,
      repoName: layout.repoName,
      cwd: layout.vaultPath,
      visibility: config.github.visibility
    });
  }

  const codexConfigPath = await writeCodexProjectProfile({
    config,
    project,
    port: serverPort,
    instructionsPath: layout.codexInstructionsPath
  });

  return {
    project,
    projectVaultPath: layout.vaultPath,
    commonVaultPath: common.vaultPath,
    codexConfigPath
  };
}

async function ensureVaultFolders(...folders: string[]): Promise<void> {
  await Promise.all(folders.map(folder => fs.mkdir(folder, { recursive: true })));
}

async function writeProjectMetadata(config: AppConfig, project: string): Promise<void> {
  const layout = projectLayout(config, project);
  const metadata = {
    version: 1,
    project,
    repoName: layout.repoName,
    commonProjectName: config.commonProjectName,
    createdAt: new Date().toISOString(),
    folderStructure: config.folderStructure
  };
  await fs.writeFile(layout.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function writeCodexInstructions(config: AppConfig, project: string): Promise<void> {
  const layout = projectLayout(config, project);
  await fs.mkdir(path.dirname(layout.codexInstructionsPath), { recursive: true });
  await fs.writeFile(
    layout.codexInstructionsPath,
    [
      `You are working in the Obsidian project vault "${project}".`,
      '',
      'Use the obsidian-project MCP tools for vault access.',
      `Project notes are writable only under ${config.folderStructure.wiki}/${config.folderStructure.projectWiki}/.`,
      `Shared notes are readable under ${config.folderStructure.wiki}/${config.folderStructure.commonWiki}/ and must only be changed through request_common_update.`,
      'Do not attempt to inspect sibling vaults or bypass the MCP scope.'
    ].join('\n') + '\n',
    'utf8'
  );
}

async function copyConfiguredCommonFiles(config: AppConfig, commonVaultPath: string, projectVaultPath: string): Promise<void> {
  for (const relativePath of config.copyFromCommon) {
    const source = path.resolve(commonVaultPath, relativePath);
    const destination = path.resolve(projectVaultPath, relativePath);
    if (!source.startsWith(path.resolve(commonVaultPath))) {
      continue;
    }
    if (!destination.startsWith(path.resolve(projectVaultPath))) {
      continue;
    }

    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: false });
    } catch {
      // Missing optional seed files should not block a new project.
    }
  }
}

async function ensureProjectGitignore(config: AppConfig, project: string): Promise<void> {
  const layout = projectLayout(config, project);
  const gitignore = path.join(layout.vaultPath, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(gitignore, 'utf8');
  } catch {
    // Create below.
  }

  const commonMount = `${config.folderStructure.wiki}/${config.folderStructure.commonWiki}/`;
  const required = ['.obsidian/workspace*.json', '.trash/', commonMount];
  const existing = new Set(current.split(/\r?\n/));
  const missing = required.filter(line => !existing.has(line));
  if (missing.length === 0) {
    return;
  }

  const next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`;
  await fs.writeFile(gitignore, next, 'utf8');
}
