import fs from 'node:fs/promises';
import path from 'node:path';

import { AppConfig } from '../config/schema.js';
import { commonLayout, projectLayout } from '../vaults/layout.js';

export interface FolderStatus {
  label: string;
  path: string;
  exists: boolean;
  linked: boolean;
  target?: string;
}

export interface ProjectInventoryItem {
  project: string;
  repoName: string;
  vaultPath: string;
  kind: 'common' | 'project';
  folders: FolderStatus[];
}

export async function listProjects(config: AppConfig): Promise<ProjectInventoryItem[]> {
  const projects = await discoverProjectNames(config);
  const items: ProjectInventoryItem[] = [];

  if (config.commonConfigured) {
    const common = commonLayout(config);
    items.push({
      project: common.project,
      repoName: common.repoName,
      vaultPath: common.vaultPath,
      kind: 'common',
      folders: await inspectFolders([
        ['vault', common.vaultPath],
        ['raw', common.rawPath],
        ['wiki', common.wikiPath],
        ['output', common.outputPath],
        ['git', path.join(common.vaultPath, '.git')]
      ])
    });
  }

  for (const project of projects) {
    const layout = projectLayout(config, project);
    items.push({
      project,
      repoName: layout.repoName,
      vaultPath: layout.vaultPath,
      kind: 'project',
      folders: await inspectFolders([
        ['vault', layout.vaultPath],
        ['raw', layout.rawPath],
        ['wiki', layout.wikiPath],
        ['wiki/project', layout.projectWikiPath],
        ['wiki/common', layout.commonMountPath],
        ['output', layout.outputPath],
        ['git', path.join(layout.vaultPath, '.git')]
      ])
    });
  }

  return items;
}

export async function existingProjectNameSet(config: AppConfig): Promise<Set<string>> {
  return new Set(await discoverProjectNames(config));
}

async function discoverProjectNames(config: AppConfig): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.vaultRoot);
  } catch {
    return [];
  }

  const projects: string[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (!entry.startsWith(config.repoPrefix)) {
      continue;
    }

    const project = entry.slice(config.repoPrefix.length);
    if (!project || project === config.commonProjectName) {
      continue;
    }

    const layout = projectLayout(config, project);
    const stat = await fs.stat(layout.vaultPath).catch(() => undefined);
    if (stat?.isDirectory()) {
      projects.push(project);
    }
  }

  return projects;
}

async function inspectFolders(entries: Array<[string, string]>): Promise<FolderStatus[]> {
  return await Promise.all(entries.map(([label, folderPath]) => inspectFolder(label, folderPath)));
}

async function inspectFolder(label: string, folderPath: string): Promise<FolderStatus> {
  const stat = await fs.lstat(folderPath).catch(() => undefined);
  if (!stat) {
    return {
      label,
      path: folderPath,
      exists: false,
      linked: false
    };
  }

  const linked = stat.isSymbolicLink();
  const target = linked ? await resolveLinkTarget(folderPath) : undefined;
  return {
    label,
    path: folderPath,
    exists: true,
    linked,
    target
  };
}

async function resolveLinkTarget(folderPath: string): Promise<string> {
  try {
    return await fs.realpath(folderPath);
  } catch {
    return await fs.readlink(folderPath).catch(() => folderPath);
  }
}
