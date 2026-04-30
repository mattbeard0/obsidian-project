import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UserError } from '../errors.js';
import { configDir, displayPath } from '../platform/paths.js';

/** Path to Codex `config.toml` for skill install (prefers `CODEX_HOME`). */
function codexConfigPathForSkills(): string {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, 'config.toml');
  }

  return path.join(os.homedir(), '.codex', 'config.toml');
}

/** Parent directory of the Codex config file. */
function codexHomeDirForSkills(): string {
  return path.dirname(codexConfigPathForSkills());
}

/** Primary bundled skill (MCP integration); other shipped skills live alongside it under {@link bundledSkillsRoot}. */
export const CODEX_SKILL_NAME = 'obsidian-project-mcp';

/** Absolute path to the `skills/` directory shipped inside this package (contains one folder per Codex skill). */
export function bundledSkillsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../skills');
}

/** Absolute path to the primary bundled skill folder (same layout as other skill dirs under {@link bundledSkillsRoot}). */
export function bundledCodexSkillDir(): string {
  return path.join(bundledSkillsRoot(), CODEX_SKILL_NAME);
}

/** Parent directory for canonical copies: `<configDir>/skills/<name>/`. */
export function canonicalSkillsRoot(): string {
  return path.join(configDir(), 'skills');
}

/** Stable copy path for the MCP skill — `<canonicalSkillsRoot>/<CODEX_SKILL_NAME>`. */
export function canonicalSkillCopyPath(): string {
  return path.join(canonicalSkillsRoot(), CODEX_SKILL_NAME);
}

/** Default Codex skills parent (`$CODEX_HOME/skills` or `~/.codex/skills`). Each skill is `<root>/<skillName>/`. */
export function codexSkillsRootDefault(): string {
  return path.join(codexHomeDirForSkills(), 'skills');
}

/** Directories under {@link bundledSkillsRoot} that contain `SKILL.md`. */
export async function listBundledSkillNames(): Promise<string[]> {
  const root = bundledSkillsRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    try {
      await fs.access(path.join(root, e.name, 'SKILL.md'));
      names.push(e.name);
    } catch {
      /* skip dirs without SKILL.md */
    }
  }
  names.sort();
  return names;
}

interface InstallCodexSkillResult {
  skillNames: string[];
  canonicalSkillsRoot: string;
  codexSkillsRoot: string;
}

interface InstallCodexSkillOptions {
  /** Parent directory; each bundled skill is copied to `<codexSkillsRoot>/<skillName>/`. Default: {@link codexSkillsRootDefault}. */
  codexSkillsRoot?: string;
  /**
   * @deprecated Prefer `codexSkillsRoot`. If this points at a single skill folder (e.g. `.../obsidian-project-mcp`),
   * its parent directory is used as the Codex skills root so all bundled skills install next to it.
   */
  codexSkillDir?: string;
}

function resolveCodexSkillsRoot(rawOption: InstallCodexSkillOptions | undefined, skillNames: string[]): string {
  const raw = rawOption?.codexSkillsRoot?.trim() || rawOption?.codexSkillDir?.trim();
  if (!raw) {
    return codexSkillsRootDefault();
  }
  const resolved = path.resolve(raw);
  const base = path.basename(resolved);
  if (skillNames.includes(base)) {
    return path.dirname(resolved);
  }
  return resolved;
}

/** Copy every bundled skill into the canonical config dir and into Codex’s skills directory (or `codexSkillsRoot`). */
export async function installCodexSkill(options?: InstallCodexSkillOptions): Promise<InstallCodexSkillResult> {
  const skillNames = await listBundledSkillNames();
  if (skillNames.length === 0) {
    throw new UserError(
      'Bundled Codex skill files are missing. Reinstall obsidian-project-cli or run from a full source checkout.'
    );
  }

  const bundledRoot = bundledSkillsRoot();
  const canonicalRoot = canonicalSkillsRoot();
  const codexRoot = resolveCodexSkillsRoot(options, skillNames);

  await fs.mkdir(canonicalRoot, { recursive: true });
  await fs.mkdir(codexRoot, { recursive: true });

  for (const name of skillNames) {
    const source = path.join(bundledRoot, name);
    await fs.cp(source, path.join(canonicalRoot, name), { recursive: true, force: true });
    await fs.cp(source, path.join(codexRoot, name), { recursive: true, force: true });
  }

  return {
    skillNames,
    canonicalSkillsRoot: canonicalRoot,
    codexSkillsRoot: codexRoot
  };
}

/** User-facing summary after install. */
export function formatCodexSkillLines(result: InstallCodexSkillResult): string {
  const names = result.skillNames.join(', ');
  return [`Skills: ${names}`, `Canonical: ${displayPath(result.canonicalSkillsRoot)}`, `Codex: ${displayPath(result.codexSkillsRoot)}`].join(
    '\n'
  );
}
