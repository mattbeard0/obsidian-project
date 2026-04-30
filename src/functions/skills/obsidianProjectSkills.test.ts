import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  bundledCodexSkillDir,
  bundledSkillsRoot,
  canonicalSkillCopyPath,
  canonicalSkillsRoot,
  CODEX_SKILL_NAME,
  installCodexSkill,
  listBundledSkillNames
} from './obsidianProjectSkills.js';

describe('obsidianProjectSkills', () => {
  it('bundled SKILL.md exists for primary skill', async () => {
    const src = bundledCodexSkillDir();
    expect(path.basename(src)).toBe(CODEX_SKILL_NAME);
    await fs.access(path.join(src, 'SKILL.md'));
  });

  it('lists every bundled skill directory', async () => {
    const names = await listBundledSkillNames();
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain(CODEX_SKILL_NAME);
    expect(names).toContain('obsidian-markdown');
    expect(names).toContain('obsidian-bases');
    expect(names).toContain('json-canvas');
    const root = bundledSkillsRoot();
    for (const n of names) {
      await fs.access(path.join(root, n, 'SKILL.md'));
    }
  });

  it('writes canonical and codex trees for all bundled skills', async () => {
    const tmpCfg = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-cfg-'));
    const tmpCodex = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-cdx-'));
    const prevCfg = process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    const prevCodex = process.env.CODEX_HOME;
    process.env.OBSIDIAN_PROJECT_CONFIG_DIR = tmpCfg;
    process.env.CODEX_HOME = tmpCodex;
    try {
      const result = await installCodexSkill();
      const expected = await listBundledSkillNames();
      expect(result.skillNames).toEqual(expected);
      expect(result.canonicalSkillsRoot).toBe(path.join(tmpCfg, 'skills'));
      expect(result.codexSkillsRoot).toBe(path.join(tmpCodex, 'skills'));
      for (const name of result.skillNames) {
        await fs.access(path.join(result.canonicalSkillsRoot, name, 'SKILL.md'));
        await fs.access(path.join(result.codexSkillsRoot, name, 'SKILL.md'));
      }
    } finally {
      if (prevCfg === undefined) {
        delete process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
      } else {
        process.env.OBSIDIAN_PROJECT_CONFIG_DIR = prevCfg;
      }
      if (prevCodex === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodex;
      }
      await fs.rm(tmpCfg, { recursive: true, force: true });
      await fs.rm(tmpCodex, { recursive: true, force: true });
    }
  });

  it('installs to a custom Codex skills root', async () => {
    const tmpCfg = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-cfg-'));
    const tmpCustom = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-custom-'));
    const customRoot = path.join(tmpCustom, 'my-skills');
    const prevCfg = process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    process.env.OBSIDIAN_PROJECT_CONFIG_DIR = tmpCfg;
    try {
      const result = await installCodexSkill({ codexSkillsRoot: customRoot });
      expect(result.codexSkillsRoot).toBe(path.resolve(customRoot));
      for (const name of result.skillNames) {
        await fs.access(path.join(result.codexSkillsRoot, name, 'SKILL.md'));
      }
    } finally {
      if (prevCfg === undefined) {
        delete process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
      } else {
        process.env.OBSIDIAN_PROJECT_CONFIG_DIR = prevCfg;
      }
      await fs.rm(tmpCfg, { recursive: true, force: true });
      await fs.rm(tmpCustom, { recursive: true, force: true });
    }
  });

  it('treats legacy leaf path (single skill dir) as parent skills root', async () => {
    const tmpCfg = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-cfg-'));
    const tmpCustom = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-legacy-'));
    const leaf = path.join(tmpCustom, 'skills', CODEX_SKILL_NAME);
    const prevCfg = process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    process.env.OBSIDIAN_PROJECT_CONFIG_DIR = tmpCfg;
    try {
      const result = await installCodexSkill({ codexSkillDir: leaf });
      expect(result.codexSkillsRoot).toBe(path.join(tmpCustom, 'skills'));
    } finally {
      if (prevCfg === undefined) {
        delete process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
      } else {
        process.env.OBSIDIAN_PROJECT_CONFIG_DIR = prevCfg;
      }
      await fs.rm(tmpCfg, { recursive: true, force: true });
      await fs.rm(tmpCustom, { recursive: true, force: true });
    }
  });

  it('canonicalSkillCopyPath and canonicalSkillsRoot use configDir', () => {
    const tmp = path.join(os.tmpdir(), 'opc-cfg2');
    const prev = process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
    process.env.OBSIDIAN_PROJECT_CONFIG_DIR = tmp;
    try {
      expect(canonicalSkillCopyPath()).toBe(path.join(tmp, 'skills', CODEX_SKILL_NAME));
      expect(canonicalSkillsRoot()).toBe(path.join(tmp, 'skills'));
    } finally {
      if (prev === undefined) {
        delete process.env.OBSIDIAN_PROJECT_CONFIG_DIR;
      } else {
        process.env.OBSIDIAN_PROJECT_CONFIG_DIR = prev;
      }
    }
  });
});
