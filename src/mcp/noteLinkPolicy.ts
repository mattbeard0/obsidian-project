import { AppConfig } from '../config/config.js';

interface LinkViolation {
  line: number;
  link: string;
  reason: string;
}

const doubleBracketLinkPattern = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const markdownLinkPattern = /\[[^\]]*]\(([^)]+)\)/g;

/** Scan note content for wiki/markdown links that violate common→project linking rules. */
export function findForbiddenLinks(config: AppConfig, sourcePath: string, content: string): LinkViolation[] {
  const violations: LinkViolation[] = [];
  const sourceScope = classifyLinkTarget(config, sourcePath);
  const lines = content.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    for (const link of extractLinks(lineText)) {
      const targetScope = classifyLinkTarget(config, link);
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

/** Map a link target string to project vs common scope using `folderStructure`. */
function classifyLinkTarget(config: AppConfig, link: string): 'project' | 'common' | 'unknown' {
  const clean = link.replace(/\\/g, '/').replace(/^\/+/, '');
  const layout = config.folderStructure;

  if (
    clean === layout.projectScope ||
    clean.startsWith(`${layout.projectScope}/`) ||
    clean.startsWith(`${layout.noteLibrary}/${layout.projectScope}/`)
  ) {
    return 'project';
  }

  if (
    clean === layout.sharedScope ||
    clean.startsWith(`${layout.sharedScope}/`) ||
    clean.startsWith(`${layout.noteLibrary}/${layout.sharedScope}/`)
  ) {
    return 'common';
  }

  return 'unknown';
}
