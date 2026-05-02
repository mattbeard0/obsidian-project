import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { AppConfig } from '../config/config.js';
import { UserError } from '../functions/errors.js';
import {
  findCommonMountDrift,
  formatMountDriftReport,
  repairCommonMounts
} from '../functions/vaults/vaults.js';

// --- MCP start: mount drift ---

interface StartMountOptions {
  repairMounts?: boolean;
}

/** Before starting the server, detect common-mount drift and repair or prompt (or fail in CI). */
export async function ensureMountsBeforeServerStart(config: AppConfig, options: StartMountOptions = {}): Promise<void> {
  const drift = await findCommonMountDrift(config);
  if (drift.length === 0) {
    return;
  }

  if (options.repairMounts) {
    await repairCommonMounts(config, drift);
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new UserError(
      'Vault mounts do not match the registered common vault. Run from an interactive terminal, or run obsidian-project start --repair-mounts.'
    );
  }

  console.error(formatMountDriftReport(drift));

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        'Update sharing on disk so each project’s vault-root `common` link points at the registered common vault? This may break Obsidian links if you changed mounts intentionally. (y/N): '
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new UserError('Start cancelled until vault mounts match the registered common vault.');
    }
  } finally {
    rl.close();
  }

  await repairCommonMounts(config, drift);
}
