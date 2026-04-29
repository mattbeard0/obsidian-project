import path from 'node:path';

import { UserError } from '../errors.js';
import { runCommand } from './command.js';

export async function chooseFolder(prompt = 'Select the common Obsidian vault folder'): Promise<string> {
  if (process.platform === 'win32') {
    return await chooseFolderWindows(prompt);
  }

  if (process.platform === 'darwin') {
    return await chooseFolderMac(prompt);
  }

  throw new UserError('Folder picker is only supported on Windows and macOS. Pass the full vault path instead.');
}

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

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
