import { describe, expect, it } from 'vitest';

import { formatSymlinkError } from './symlinks.js';

describe('formatSymlinkError', () => {
  it('adds platform-specific guidance for permission errors', () => {
    const err = Object.assign(new Error('not permitted'), { code: 'EPERM' as const });
    const msg = formatSymlinkError('Symlink', err);
    expect(msg).toContain('not permitted');
    if (process.platform === 'darwin') {
      expect(msg).toContain('Full Disk Access');
    } else {
      expect(msg).toMatch(/Check that you own|Full Disk Access/);
    }
  });
});
