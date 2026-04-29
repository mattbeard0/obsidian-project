import { AppConfig } from '../config/schema.js';

export interface LinkViolation {
  line: number;
  link: string;
  reason: string;
}

const wikiLinkPattern = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const markdownLinkPattern = /\[[^\]]*]\(([^)]+)\)/g;

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

function extractLinks(line: string): string[] {
  const links: string[] = [];
  wikiLinkPattern.lastIndex = 0;
  markdownLinkPattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = wikiLinkPattern.exec(line))) {
    links.push(match[1].trim());
  }

  while ((match = markdownLinkPattern.exec(line))) {
    links.push(match[1].trim());
  }

  return links;
}

function classifyLinkTarget(config: AppConfig, link: string): 'project' | 'common' | 'unknown' {
  const clean = link.replace(/\\/g, '/').replace(/^\/+/, '');
  const fs = config.folderStructure;

  if (clean === fs.projectWiki || clean.startsWith(`${fs.projectWiki}/`) || clean.startsWith(`${fs.wiki}/${fs.projectWiki}/`)) {
    return 'project';
  }

  if (clean === fs.commonWiki || clean.startsWith(`${fs.commonWiki}/`) || clean.startsWith(`${fs.wiki}/${fs.commonWiki}/`)) {
    return 'common';
  }

  return 'unknown';
}
