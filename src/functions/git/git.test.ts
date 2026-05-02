import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureGitRepo } from './git.js';

describe('ensureGitRepo', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('writes .gitignore for dot paths before the first commit', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-git-'));
    await fs.mkdir(path.join(dir, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(dir, '.obsidian', 'app.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'visible.md'), 'x', 'utf8');

    await ensureGitRepo(dir, 'init test');

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('.*');
    expect(gi).toContain('!.gitignore');

    const { runCommand } = await import('../platform/shell.js');
    const tracked = await runCommand('git', ['ls-files'], { cwd: dir, timeoutMs: 10_000 });
    const files = tracked.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(files).toContain('.gitignore');
    expect(files).toContain('visible.md');
    expect(files.some(f => f.startsWith('.obsidian'))).toBe(false);
  });
});
