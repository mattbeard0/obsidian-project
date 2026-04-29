import path from 'node:path';

import { AppConfig } from '../config/schema.js';

export interface VaultLayout {
  project: string;
  repoName: string;
  vaultPath: string;
  rawPath: string;
  wikiPath: string;
  outputPath: string;
}

export interface ProjectVaultLayout extends VaultLayout {
  projectWikiPath: string;
  commonMountPath: string;
  metadataPath: string;
  codexInstructionsPath: string;
}

export function repoNameForProject(config: AppConfig, project: string): string {
  return `${config.repoPrefix}${project}`;
}

export function commonLayout(config: AppConfig): VaultLayout {
  if (!config.commonVaultPath) {
    return vaultLayout(config, config.commonProjectName);
  }

  const repoName = repoNameForProject(config, config.commonProjectName);
  const vaultPath = path.resolve(config.commonVaultPath);
  const fs = config.folderStructure;

  return {
    project: config.commonProjectName,
    repoName,
    vaultPath,
    rawPath: path.join(vaultPath, fs.raw),
    wikiPath: path.join(vaultPath, fs.wiki),
    outputPath: path.join(vaultPath, fs.output)
  };
}

export function projectLayout(config: AppConfig, project: string): ProjectVaultLayout {
  const base = vaultLayout(config, project);
  const fs = config.folderStructure;

  return {
    ...base,
    projectWikiPath: path.join(base.wikiPath, fs.projectWiki),
    commonMountPath: path.join(base.wikiPath, fs.commonWiki),
    metadataPath: path.join(base.vaultPath, '.obsidian-project.json'),
    codexInstructionsPath: path.join(base.vaultPath, '.obsidian-project', 'codex-instructions.md')
  };
}

export function vaultLayout(config: AppConfig, project: string): VaultLayout {
  const repoName = repoNameForProject(config, project);
  const vaultPath = path.join(config.vaultRoot, repoName);
  const fs = config.folderStructure;

  return {
    project,
    repoName,
    vaultPath,
    rawPath: path.join(vaultPath, fs.raw),
    wikiPath: path.join(vaultPath, fs.wiki),
    outputPath: path.join(vaultPath, fs.output)
  };
}
