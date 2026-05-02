import { AppConfig } from '../config/config.js';
import { isVaultRelativeUnderCommonMount } from '../functions/vaults/commonMountPaths.js';

interface LinkViolation {
  line: number;
  link: string;
  reason: string;
}

const doubleBracketLinkPattern = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const markdownLinkPattern = /\[[^\]]*]\(([^)]+)\)/g;

/** Scan note content for wiki/markdown links that violate common→project linking rules. */
export function findForbiddenLinks(config: AppConfig, sourcePath: string, content: string): LinkViolation[] {
  void config;
  const violations: LinkViolation[] = [];
  const sourceScope = classifyLinkTarget(sourcePath);
  const lines = content.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    for (const link of extractLinks(lineText)) {
      const targetScope = classifyLinkTarget(link);
      if (sourceScope === 'common' && targetScope === 'project') {
        violations.push({
          line: index + 1,
          link,
          reason: 'Common notes cannot link to project notes.'
        });
      }
    }
  });

  return violations;
}

/** Extract `[[links]]` targets and markdown `(...)` hrefs from a single line. */
function extractLinks(line: string): string[] {
  const links: string[] = [];
  doubleBracketLinkPattern.lastIndex = 0;
  markdownLinkPattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = doubleBracketLinkPattern.exec(line))) {
    links.push(match[1].trim());
  }

  while ((match = markdownLinkPattern.exec(line))) {
    links.push(match[1].trim());
  }

  return links;
}

/** Map a link target string to project vs common scope using the vault-root `common` mount path. */
function classifyLinkTarget(link: string): 'project' | 'common' | 'unknown' {
  const clean = link.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = clean.split('#')[0]?.trim() ?? '';

  if (isVaultRelativeUnderCommonMount(normalized)) {
    return 'common';
  }

  if (normalized.includes('/')) {
    return 'project';
  }

  return 'unknown';
}
