import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { createCommonMount } from '../symlinks/index.js';
import { assertMissingOrEmptyDirectory, findCommonMountDrift } from './vaults.js';

describe('assertMissingOrEmptyDirectory', () => {
  it('allows missing and empty directories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-project-layout-test-'));
    const missing = path.join(dir, 'missing');
    const empty = path.join(dir, 'empty');
    await fs.mkdir(empty);

    await expect(assertMissingOrEmptyDirectory(missing, 'Project vault')).resolves.toBeUndefined();
    await expect(assertMissingOrEmptyDirectory(empty, 'Project vault')).resolves.toBeUndefined();
  });

  it('fails when directory has contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-project-layout-test-'));
    const nonEmpty = path.join(dir, 'non-empty');
    await fs.mkdir(nonEmpty);
    await fs.writeFile(path.join(nonEmpty, 'note.md'), 'x', 'utf8');

    await expect(assertMissingOrEmptyDirectory(nonEmpty, 'Project vault')).rejects.toThrow(
      'Project vault path must be empty before creation'
    );
  });
});

describe('findCommonMountDrift', () => {
  it('reports missing shared common mount', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-drift-'));
    const repoPrefix = 'v-';
    const commonName = 'common';
    const commonVault = path.join(root, `${repoPrefix}${commonName}`);
    const projectName = 'alpha';
    const projectVault = path.join(root, `${repoPrefix}${projectName}`);

    await fs.mkdir(path.join(commonVault, 'n0'), { recursive: true });
    await fs.mkdir(path.join(projectVault, 'n0', 'j0'), { recursive: true });

    const config = appConfigSchema.parse({
      repoPrefix,
      commonProjectName: commonName,
      commonConfigured: true,
      commonVaultPath: commonVault,
      projectVaults: { [projectName]: projectVault },
      folderStructure: {
        attachments: 'i0',
        noteLibrary: 'n0',
        publish: 'p0',
        projectScope: 'j0',
        sharedScope: 'k0'
      }
    });

    const drift = await findCommonMountDrift(config);
    expect(drift.some(d => d.project === projectName && d.reason === 'missing')).toBe(true);

    await createCommonMount(path.join(projectVault, 'n0', 'k0'), path.join(commonVault, 'n0'));
    const after = await findCommonMountDrift(config);
    expect(after.filter(d => d.project === projectName)).toHaveLength(0);

    await fs.rm(root, { recursive: true, force: true });
  });
});
