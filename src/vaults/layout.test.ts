import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertMissingOrEmptyDirectory } from './layout.js';

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
