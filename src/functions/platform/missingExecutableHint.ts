import path from 'node:path';

/** Known CLIs: messages stay in one place; `runCommand` resolves them on ENOENT by basename. */
const HINTS: Record<string, string> = {
  obsidian:
    'Obsidian CLI is not available. Install Obsidian 1.12.7+, open Settings > General > Command line interface, turn on the CLI, then restart this terminal so `obsidian` is on your PATH. https://obsidian.md/cli',
  gh: 'GitHub CLI (gh) is not installed or not in PATH. https://cli.github.com/'
};

/**
 * User-facing copy when spawn fails with ENOENT (executable missing).
 * Uses `path.basename(command)` so short names and absolute paths match the same hint.
 */
export function missingExecutableMessage(command: string): string {
  const name = path.basename(command);
  return (
    HINTS[name] ??
    `Could not find "${name}" on your PATH. Install it or enable its CLI in the host app, then restart this terminal so your shell sees the executable.`
  );
}
