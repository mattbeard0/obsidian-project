import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../../config/config.js';
import { writeCodexProjectProfile } from './config.js';

describe('codex config generation', () => {
  it('writes a project-scoped MCP server and profile block', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-project-test-'));
    const configPath = path.join(dir, 'config.toml');
    const config = appConfigSchema.parse({
      repoPrefix: 'obsidian-vault-',
      commonProjectName: 'common',
      commonConfigured: false,
      copyFromCommon: [],
      projectVaults: {},
      codex: {
        configPath,
        mcpServerNamePrefix: 'obsidian-notes',
        profileNamePrefix: ''
      },
      github: { createRemotes: false, hostname: 'github.com' },
      server: { host: '127.0.0.1', preferredPort: 57891 }
    });

    await writeCodexProjectProfile({
      config,
      project: 'project-1',
      port: 57891,
      instructionsPath: path.join(dir, 'instructions.md')
    });

    const text = await fs.readFile(configPath, 'utf8');
    expect(text).toContain('[profiles.project-1.mcp_servers.obsidian-notes]');
    expect(text).toContain('url = "http://127.0.0.1:57891/mcp"');
    expect(text).toContain('"x-obsidian-project" = "project-1"');
    expect(text).toContain('[profiles.project-1]');
    expect(config.codex.mcpServerNamePrefix).toBe('obsidian-notes');
    expect(config.codex.profileNamePrefix + 'project-1').toBe('project-1');
  });
});
