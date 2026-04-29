import { spawn } from 'node:child_process';

import { UserError } from '../errors.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

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
