import fs from 'node:fs/promises';
import path from 'node:path';

import { saveConfig, sanitizeProjectName } from '../config/load.js';
import { AppConfig } from '../config/schema.js';
import { UserError } from '../errors.js';
import { ensureGitRepo } from '../git/repo.js';
import { chooseFolder } from '../platform/folderPicker.js';
import { commonLayout } from '../vaults/layout.js';

export interface SetCommonVaultOptions {
  vaultPath?: string;
  name?: string;
}

export interface CreateCommonVaultOptions {
  name?: string;
}

export interface CommonVaultResult {
  commonProjectName: string;
  commonVaultPath: string;
  created: boolean;
}

export async function setCommonVault(config: AppConfig, options: SetCommonVaultOptions = {}): Promise<CommonVaultResult> {
  const commonVaultPath = path.resolve(options.vaultPath ?? (await chooseFolder()));
  const stat = await fs.stat(commonVaultPath).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new UserError(`Common vault folder does not exist: ${commonVaultPath}`);
  }

  const commonProjectName = sanitizeProjectName(
    options.name ?? projectNameFromVaultPath(commonVaultPath, config.repoPrefix)
  );
  const nextConfig = {
    ...config,
    commonProjectName,
    commonConfigured: true,
    commonVaultPath
  };
  const common = commonLayout(nextConfig);
  await fs.mkdir(common.rawPath, { recursive: true });
  await fs.mkdir(common.wikiPath, { recursive: true });
  await fs.mkdir(common.outputPath, { recursive: true });
  await ensureGitRepo(common.vaultPath, 'Initialize common vault');
  await saveConfig(nextConfig);

  return {
    commonProjectName,
    commonVaultPath,
    created: false
  };
}

export async function createCommonVault(
  config: AppConfig,
  options: CreateCommonVaultOptions = {}
): Promise<CommonVaultResult> {
  if (!config.vaultRootConfigured) {
    throw new UserError('Vault root is not configured yet. Run "obsidian-project --init" first.');
  }

  const commonProjectName = sanitizeProjectName(options.name ?? config.commonProjectName);
  const nextConfig = {
    ...config,
    commonProjectName,
    commonConfigured: true,
    commonVaultPath: undefined
  };
  const common = commonLayout(nextConfig);
  let created = false;

  try {
    await fs.access(common.vaultPath);
  } catch {
    created = true;
    await fs.mkdir(common.rawPath, { recursive: true });
    await fs.mkdir(common.wikiPath, { recursive: true });
    await fs.mkdir(common.outputPath, { recursive: true });
  }

  await ensureGitRepo(common.vaultPath, 'Initialize common vault');

  await saveConfig(nextConfig);
  return {
    commonProjectName,
    commonVaultPath: common.vaultPath,
    created
  };
}

function projectNameFromVaultPath(vaultPath: string, repoPrefix: string): string {
  const folderName = path.basename(path.resolve(vaultPath));
  return folderName.startsWith(repoPrefix) ? folderName.slice(repoPrefix.length) : folderName;
}
