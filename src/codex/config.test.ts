import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config/schema.js';
import { codexMcpServerName, codexProfileName, writeCodexProjectProfile } from './config.js';

describe('codex config generation', () => {
  it('writes a project-scoped MCP server and profile block', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-project-test-'));
    const configPath = path.join(dir, 'config.toml');
    const config = appConfigSchema.parse({
      vaultRoot: path.join(dir, 'knowledge'),
      codex: {
        configPath,
        mcpServerNamePrefix: 'obsidian-notes',
        profileNamePrefix: ''
      }
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
    expect(codexMcpServerName(config, 'project-1')).toBe('obsidian-notes');
    expect(codexProfileName(config, 'project-1')).toBe('project-1');
  });
});
