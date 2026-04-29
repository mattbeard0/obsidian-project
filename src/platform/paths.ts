import os from 'node:os';
import path from 'node:path';

export function configDir(): string {
  if (process.env.OBSIDIAN_PROJECT_CONFIG_DIR) {
    return path.resolve(process.env.OBSIDIAN_PROJECT_CONFIG_DIR);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.obsidian-project');
  }

  return path.join(os.homedir(), '.obsidian-project');
}

export function stateDir(): string {
  if (process.env.OBSIDIAN_PROJECT_STATE_DIR) {
    return path.resolve(process.env.OBSIDIAN_PROJECT_STATE_DIR);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), '.obsidian-project');
  }

  return path.join(os.homedir(), '.obsidian-project', 'state');
}

export function defaultVaultRoot(): string {
  if (process.platform === 'win32') {
    const drive = path.parse(os.homedir()).root || 'C:\\';
    return path.join(drive, 'Vaults');
  }

  return path.join(os.homedir(), 'Vaults');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function legacyConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian-project', 'config.json');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian-project', 'config.json');
  }

  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'obsidian-project', 'config.json');
}

export function serverStatePath(): string {
  return path.join(stateDir(), 'server.json');
}

export function serverLogPath(): string {
  return path.join(stateDir(), 'server.log');
}

export function codexConfigPath(): string {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, 'config.toml');
  }

  return path.join(os.homedir(), '.codex', 'config.toml');
}
