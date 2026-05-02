import os from 'node:os';
import path from 'node:path';

/** Directory for `config.json` / app settings (`OBSIDIAN_PROJECT_CONFIG_DIR` overrides). */
export function configDir(): string {
  if (process.env.OBSIDIAN_PROJECT_CONFIG_DIR) {
    return path.resolve(process.env.OBSIDIAN_PROJECT_CONFIG_DIR);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.obsidian-project');
  }

  return path.join(os.homedir(), '.obsidian-project');
}

/** Writable state directory for server pid/log (`OBSIDIAN_PROJECT_STATE_DIR` overrides). */
export function stateDir(): string {
  if (process.env.OBSIDIAN_PROJECT_STATE_DIR) {
    return path.resolve(process.env.OBSIDIAN_PROJECT_STATE_DIR);
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), '.obsidian-project');
  }

  return path.join(os.homedir(), '.obsidian-project', 'state');
}

/** Absolute path to the main `config.json` file. */
export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** JSON file recording the running MCP child process (pid, port, token). */
export function serverStatePath(): string {
  return path.join(stateDir(), 'server.json');
}

/** Append-only log for the detached MCP HTTP server process. */
export function serverLogPath(): string {
  return path.join(stateDir(), 'server.log');
}

// --- User-facing path display (logs, errors, CLI) ---

/** Shorten a filesystem path for user-facing messages (home dir → ~). */
export function displayPath(absPath: string): string {
  const resolved = path.resolve(absPath);
  const home = os.homedir();
  if (home && (resolved === home || resolved.startsWith(home + path.sep))) {
    return path.join('~', resolved.slice(home.length + 1));
  }
  return resolved;
}

/** Remove obvious home-directory prefixes from subprocess error text (e.g. git stderr). */
export function redactHomeInText(text: string): string {
  const home = os.homedir();
  if (!home) {
    return text;
  }
  return text.split(home).join('~');
}
