import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { formatGithubConfig, isGithubRemoteSyncConfigured } from './projects.js';

const minimal = {
  repoPrefix: 'obsidian-vault-',
  commonProjectName: 'common',
  commonConfigured: false,
  copyFromCommon: [] as string[],
  projectVaults: {} as Record<string, string>,
  github: { createRemotes: false, hostname: 'github.com' },
  server: { host: '127.0.0.1' as const, preferredPort: 57891 },
  codex: { mcpServerNamePrefix: 'obsidian-notes' as const, profileNamePrefix: '' }
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
