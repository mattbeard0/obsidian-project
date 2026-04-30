import { spawn } from 'node:child_process';
import path from 'node:path';

import { UserError } from '../errors.js';
import { missingExecutableMessage } from './missingExecutableHint.js';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

/** Merge GH_HOST so `gh` targets GitHub.com or Enterprise; omit override for github.com. */
export function envWithGithubHost(hostname: string | undefined): NodeJS.ProcessEnv {
  const raw = (hostname ?? 'github.com')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.trim();
  if (!raw || raw.toLowerCase() === 'github.com') {
    return { ...process.env };
  }
  return { ...process.env, GH_HOST: raw };
}

/** Spawns a subprocess, collects stdout/stderr, optional stdin and timeout; resolves with exit code (non-throwing on failure). */
export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          child.kill();
          reject(new UserError(`Command timed out: ${command} ${args.join(' ')}`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      if (done) {
        return;
      }
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        reject(new UserError(missingExecutableMessage(command)));
        return;
      }
      reject(error);
    });
    child.on('close', code => {
      if (done) {
        return;
      }
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

/** Like `runCommand` but throws `UserError` if the exit code is non-zero. */
export async function runRequired(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new UserError(
      `Command failed (${result.code}): ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`.trim()
    );
  }

  return result;
}

/** Opens the OS folder picker on Windows/macOS, or throws on unsupported platforms. */
export async function chooseFolder(prompt = 'Select the common Obsidian vault folder'): Promise<string> {
  if (process.platform === 'win32') {
    return await chooseFolderWindows(prompt);
  }

  if (process.platform === 'darwin') {
    return await chooseFolderMac(prompt);
  }

  throw new UserError('Folder picker is only supported on Windows and macOS. Pass the full vault path instead.');
}

/** Windows folder dialog via PowerShell. */
async function chooseFolderWindows(prompt: string): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog`,
    `$dialog.Description = ${powershellString(prompt)}`,
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '  exit 0',
    '}',
    'exit 2'
  ].join('; ');

  const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeoutMs: 120_000
  });
  if (result.code === 2) {
    throw new UserError('No common vault folder selected.');
  }
  if (result.code !== 0) {
    throw new UserError((result.stderr || result.stdout || 'Could not open the Windows folder picker.').trim());
  }
  return path.resolve(result.stdout.trim());
}

/** macOS folder dialog via AppleScript. */
async function chooseFolderMac(prompt: string): Promise<string> {
  const result = await runCommand(
    'osascript',
    ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`],
    { timeoutMs: 120_000 }
  );
  if (result.code !== 0) {
    throw new UserError((result.stderr || result.stdout || 'No common vault folder selected.').trim());
  }
  return path.resolve(result.stdout.trim());
}

/** Escape a string for embedding in a PowerShell single-quoted literal. */
function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
