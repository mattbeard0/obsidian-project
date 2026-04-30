import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { formatGithubConfig, isGithubRemoteSyncConfigured } from './projects.js';

const testFolders = {
  attachments: 'i0',
  noteLibrary: 'n0',
  publish: 'p0',
  projectScope: 'j0',
  sharedScope: 'k0'
};

const minimal = {
  repoPrefix: 'obsidian-vault-',
  commonProjectName: 'common',
  commonConfigured: false,
  folderStructure: testFolders,
  copyFromCommon: [] as string[]
};

describe('projects GitHub helpers', () => {
  it('isGithubRemoteSyncConfigured is true only when createRemotes and owner are set', () => {
    expect(
      isGithubRemoteSyncConfigured(
        appConfigSchema.parse({
          ...minimal,
          github: { owner: 'acme', createRemotes: true }
        })
      )
    ).toBe(true);
    expect(
      isGithubRemoteSyncConfigured(
        appConfigSchema.parse({
          ...minimal,
          github: { owner: 'acme', createRemotes: false }
        })
      )
    ).toBe(false);
    expect(
      isGithubRemoteSyncConfigured(
        appConfigSchema.parse({
          ...minimal,
          github: { createRemotes: true }
        })
      )
    ).toBe(false);
  });

  it('formatGithubConfig summarizes owner, fixed private repos, and remote flag', () => {
    const config = appConfigSchema.parse({
      ...minimal,
      github: { owner: 'acme', createRemotes: true }
    });
    const text = formatGithubConfig(config);
    expect(text).toContain('Host: github.com');
    expect(text).toContain('acme');
    expect(text).toContain('always private');
    expect(text).toContain('yes');
  });
});
