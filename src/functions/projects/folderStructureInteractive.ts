import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  folderStructureSchema,
  parseVaultConfigJson,
  readPersistedConfig,
  readVaultConfigFromDisk,
  vaultConfigSchema,
  writeVaultConfigToDisk,
  type FolderStructure
} from '../../config/config.js';
import { UserError } from '../errors.js';
import { chooseFolder } from '../platform/shell.js';
import { displayPath, vaultConfigPath } from '../platform/paths.js';

const ROLE_ORDER: (keyof FolderStructure)[] = [
  'attachments',
  'noteLibrary',
  'publish',
  'projectScope',
  'sharedScope'
];

/** True when this OS can open the native folder picker. */
function folderPickerAvailable(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** Read a single line from the user (trimmed). */
async function promptLine(rl: readline.Interface, q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

/** Parse a y/n answer. */
async function promptYesNo(rl: readline.Interface, q: string): Promise<boolean> {
  const a = (await rl.question(`${q} (y/n): `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Require a non-empty path and return it resolved. */
async function promptPath(rl: readline.Interface, label: string): Promise<string> {
  const raw = await promptLine(rl, `${label}: `);
  if (!raw) {
    throw new UserError('A path is required.');
  }
  return path.resolve(raw);
}

/** Top-level directories only, excluding dot folders and usual junk. */
async function listTopLevelDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new UserError(`Cannot read directory: ${displayPath(dir)}`);
  }
  const skip = new Set(['.obsidian', '.git', '.trash', '.obsidian-project', 'node_modules']);
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Map the first five folder names to the five roles in `ROLE_ORDER`. */
function structureFromNames(names: string[]): FolderStructure {
  if (names.length < 5) {
    throw new UserError(`Need at least five folder names (have ${names.length}).`);
  }
  const picked = names.slice(0, 5);
  if (names.length > 5) {
    console.log(`Using the first five folders (alphabetically / creation order): ${picked.join(', ')}`);
  }
  const raw = Object.fromEntries(ROLE_ORDER.map((k, i) => [k, picked[i]]));
  return folderStructureSchema.parse(raw);
}

/** Load `folderStructure` from a user-chosen file or directory containing `vault-config.json`. */
async function parseVaultConfigAtUserPath(picked: string): Promise<FolderStructure> {
  const resolved = path.resolve(picked);
  let file = resolved;
  try {
    const st = await fs.stat(resolved);
    if (st.isDirectory()) {
      file = path.join(resolved, 'vault-config.json');
    }
  } catch {
    throw new UserError(`Path does not exist: ${displayPath(resolved)}`);
  }

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new UserError(
      `Could not read vault-config.json at ${displayPath(file)}. Pick a folder that contains vault-config.json, or select the JSON file directly.`
    );
  }

  const vc = parseVaultConfigJson(raw);
  return folderStructureSchema.parse(vc.folderStructure);
}

/** Wizard branch (a): copy from another vault or JSON file. */
async function branchCopyFromAnotherVault(rl: readline.Interface): Promise<FolderStructure> {
  console.log('Pick a folder that contains vault-config.json, or the vault-config.json file itself.');
  let picked: string;
  if (folderPickerAvailable()) {
    const usePicker = await promptYesNo(rl, 'Open folder/file chooser? (no = type a path instead)');
    if (usePicker) {
      try {
        picked = await chooseFolder('Select folder containing vault-config.json (or parent of another obsidian-project config)');
      } catch {
        picked = await promptPath(rl, 'Path to folder with vault-config.json, or to vault-config.json');
      }
    } else {
      picked = await promptPath(rl, 'Path to folder with vault-config.json, or to vault-config.json');
    }
  } else {
    picked = await promptPath(rl, 'Path to folder with vault-config.json, or to vault-config.json');
  }

  return parseVaultConfigAtUserPath(picked);
}

/** Wizard branch (b): infer five folder names from the registered common vault (or pick one). */
async function branchCopyFromCommon(rl: readline.Interface): Promise<FolderStructure> {
  const persisted = await readPersistedConfig();
  let root = persisted.commonVaultPath?.trim();
  if (!root) {
    console.log(
      'No common vault path is saved in config yet. Choose or enter the folder that will be (or already is) your common vault.'
    );
    if (folderPickerAvailable() && (await promptYesNo(rl, 'Open folder chooser?'))) {
      try {
        root = await chooseFolder('Select your common Obsidian vault folder');
      } catch {
        root = await promptPath(rl, 'Path to common vault folder');
      }
    } else {
      root = await promptPath(rl, 'Path to common vault folder');
    }
  }
  root = path.resolve(root);
  const names = await listTopLevelDirs(root);
  if (names.length === 0) {
    throw new UserError(
      `No subfolders found under common vault ${displayPath(root)}. Create folders there or use another option.`
    );
  }
  console.log(`Folders under common vault:\n  ${names.join(', ')}`);
  if (names.length < 5) {
    console.log('Fewer than five folders — you will name the remaining roles next.');
    const extra: string[] = [...names];
    for (let i = names.length; i < 5; i++) {
      const role = ROLE_ORDER[i];
      const name = await promptLine(rl, `Folder name for “${role}”: `);
      if (!name) {
        throw new UserError('A non-empty folder name is required.');
      }
      extra.push(name);
    }
    return folderStructureSchema.parse({
      attachments: extra[0],
      noteLibrary: extra[1],
      publish: extra[2],
      projectScope: extra[3],
      sharedScope: extra[4]
    });
  }
  const structure = structureFromNames(names);
  if (await promptYesNo(rl, `Use the first five folders (sorted) mapped to roles ${ROLE_ORDER.join(' → ')}?`)) {
    return structure;
  }
  return await promptEachRoleManually(rl);
}

/** Ask for each role’s folder name explicitly. */
async function promptEachRoleManually(rl: readline.Interface): Promise<FolderStructure> {
  const out: Partial<FolderStructure> = {};
  for (const role of ROLE_ORDER) {
    const name = await promptLine(rl, `Folder name for “${role}” (single path segment, e.g. notes or wiki): `);
    if (!name) {
      throw new UserError('A non-empty folder name is required.');
    }
    out[role] = name;
  }
  return folderStructureSchema.parse(out);
}

/** Wizard branch (c): create folders under a base path, then map to roles. */
async function branchCreateFoldersHere(rl: readline.Interface): Promise<FolderStructure> {
  console.log('Choose a base directory. Folder names you add will be created under it.');
  let base: string;
  if (folderPickerAvailable() && (await promptYesNo(rl, 'Pick base folder in Finder / Explorer?'))) {
    try {
      base = await chooseFolder('Select base folder where folders will be created');
    } catch {
      base = await promptPath(rl, 'Base directory path');
    }
  } else {
    base = await promptPath(rl, 'Base directory path');
  }

  const created: string[] = [];
  for (;;) {
    const more = await promptYesNo(rl, created.length === 0 ? 'Add a folder?' : 'Add another folder?');
    if (!more) {
      break;
    }
    const name = await promptLine(rl, 'Folder name (single segment, no slashes): ');
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new UserError('Use a single folder name without path separators.');
    }
    const dest = path.join(base, name);
    await fs.mkdir(dest, { recursive: true });
    created.push(name);
    console.log(`Created ${displayPath(dest)}`);
  }

  if (created.length >= 5) {
    return structureFromNames(created);
  }
  console.log(`You have ${created.length} folder(s); five roles are required. Name the rest (folders do not need to exist yet).`);
  const names = [...created];
  for (let i = created.length; i < 5; i++) {
    const role = ROLE_ORDER[i];
    const name = await promptLine(rl, `Folder name for “${role}”: `);
    if (!name) {
      throw new UserError('A non-empty folder name is required.');
    }
    await fs.mkdir(path.join(base, name), { recursive: true }).catch(() => undefined);
    names.push(name);
  }
  return folderStructureSchema.parse({
    attachments: names[0],
    noteLibrary: names[1],
    publish: names[2],
    projectScope: names[3],
    sharedScope: names[4]
  });
}

/** Wizard branch (d): user creates folders in Explorer/Finder, then we read subfolder names. */
async function branchCreateInUi(rl: readline.Interface): Promise<FolderStructure> {
  if (!folderPickerAvailable()) {
    throw new UserError(
      'Native folder UI is only on macOS and Windows. Use option (c), or type paths on this platform.'
    );
  }
  console.log(
    'A folder window will open. Create the folders you need inside it, then confirm — the dialog closes when you choose OK / Select Folder.'
  );
  const base = await chooseFolder(
    'Open this folder, create subfolders inside, then press OK (choose the same folder again to confirm)'
  );
  const names = await listTopLevelDirs(base);
  if (names.length === 0) {
    throw new UserError('No subfolders found. Create at least five folders inside the selected folder, then run through the wizard again.');
  }
  console.log(`Found folders:\n  ${names.join(', ')}`);
  if (names.length < 5) {
    console.log('Fewer than five folders — name the remaining roles.');
    const extra = [...names];
    for (let i = names.length; i < 5; i++) {
      const role = ROLE_ORDER[i];
      const name = await promptLine(rl, `Folder name for “${role}”: `);
      if (!name) {
        throw new UserError('A non-empty folder name is required.');
      }
      extra.push(name);
    }
    return folderStructureSchema.parse({
      attachments: extra[0],
      noteLibrary: extra[1],
      publish: extra[2],
      projectScope: extra[3],
      sharedScope: extra[4]
    });
  }
  if (await promptYesNo(rl, 'Map the first five folders (sorted) to the five folder roles?')) {
    return structureFromNames(names);
  }
  return await promptEachRoleManually(rl);
}

/** True if on-disk `vault-config.json` already has a valid `folderStructure`. */
async function hasCompleteFolderStructureOnDisk(): Promise<boolean> {
  const v = await readVaultConfigFromDisk();
  if (!v) {
    return false;
  }
  try {
    folderStructureSchema.parse(v.folderStructure);
    return true;
  } catch {
    return false;
  }
}

/**
 * When vault-config.json is missing or incomplete, interactively fill `folderStructure`.
 * Does not prescribe default folder names — user picks via menu (a–d).
 */
export async function ensureFolderStructureInteractive(): Promise<FolderStructure> {
  if (await hasCompleteFolderStructureOnDisk()) {
    const v = await readVaultConfigFromDisk();
    return folderStructureSchema.parse(v!.folderStructure);
  }

  if (!input.isTTY || !output.isTTY) {
    throw new UserError(
      'vault-config.json needs a complete folderStructure. Create or edit vault-config.json, or re-run this command in an interactive terminal to run the folder-structure wizard.'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    console.log('folderStructure is not set yet. How do you want to define folder names?');
    console.log('  (a) Copy from another vault / vault-config.json');
    console.log('  (b) Use folders under your registered common vault');
    console.log('  (c) Create folders here (you type names; folders are created under a base path)');
    console.log('  (d) Create folders in Finder / File Explorer, then confirm');
    const choice = (await promptLine(rl, 'Choose a, b, c, or d: ')).toLowerCase();

    let folderStructure: FolderStructure;
    switch (choice) {
      case 'a':
        folderStructure = await branchCopyFromAnotherVault(rl);
        break;
      case 'b':
        folderStructure = await branchCopyFromCommon(rl);
        break;
      case 'c':
        folderStructure = await branchCreateFoldersHere(rl);
        break;
      case 'd':
        folderStructure = await branchCreateInUi(rl);
        break;
      default:
        throw new UserError('Choose a, b, c, or d.');
    }

    await writeVaultConfigToDisk(
      vaultConfigSchema.parse({
        version: 1,
        folderStructure
      })
    );
    console.log(`Saved folder structure to ${displayPath(vaultConfigPath())}`);
    return folderStructure;
  } finally {
    rl.close();
  }
}
