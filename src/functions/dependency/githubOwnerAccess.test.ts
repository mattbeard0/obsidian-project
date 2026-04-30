import { describe, expect, it } from 'vitest';

import { normalizeGithubHostname } from './githubOwnerAccess.js';

describe('githubOwnerAccess', () => {
  it('normalizes hostnames', () => {
    expect(normalizeGithubHostname('https://github.example.com/api/v3')).toBe('github.example.com');
    expect(normalizeGithubHostname(undefined)).toBe('github.com');
    expect(normalizeGithubHostname('github.com')).toBe('github.com');
  });
});
