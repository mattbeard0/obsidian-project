const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!token || !repository || !eventPath) {
  fail('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH are required.');
}

const [owner, repo] = repository.split('/');
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const release = event.release;

if (!release?.id || !release?.tag_name) {
  fail('This script must run from a GitHub release event.');
}

main().catch(error => fail(error.stack || error.message));

async function main() {
  const currentTag = release.tag_name;
  const previousTag = findPreviousTag(currentTag);
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const commits = git(['log', '--format=%H%x09%an%x09%ae', range])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [sha, name, email] = line.split('\t');
      return { sha, name, email };
    });

  const prs = new Map();
  for (const commit of commits) {
    const associated = await github(`/repos/${owner}/${repo}/commits/${commit.sha}/pulls`, {
      accept: 'application/vnd.github+json'
    });
    for (const pr of associated) {
      if (pr.merged_at) {
        prs.set(pr.number, pr);
      }
    }
  }

  const contributors = collectContributors(commits, [...prs.values()]);
  const generated = renderReleaseSection({
    previousTag,
    currentTag,
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
    contributors
  });

  const existingBody = release.body || '';
  const nextBody = replaceGeneratedSection(existingBody, generated);

  await github(`/repos/${owner}/${repo}/releases/${release.id}`, {
    method: 'PATCH',
    body: {
      body: nextBody
    }
  });

  console.log(`Updated release notes for ${currentTag}`);
}

function findPreviousTag(currentTag) {
  const tags = git(['tag', '--sort=-creatordate']).split(/\r?\n/).filter(Boolean);
  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex === -1) {
    return undefined;
  }

  return tags.slice(currentIndex + 1).find(tag => tag !== currentTag);
}

function collectContributors(commits, prs) {
  const contributors = new Map();

  for (const pr of prs) {
    if (pr.user?.login) {
      contributors.set(pr.user.login, {
        label: `@${pr.user.login}`,
        url: pr.user.html_url
      });
    }
  }

  for (const commit of commits) {
    const key = commit.email || commit.name;
    if (key && !contributors.has(key)) {
      contributors.set(key, {
        label: commit.name || commit.email,
        url: undefined
      });
    }
  }

  return [...contributors.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function renderReleaseSection({ previousTag, currentTag, prs, contributors }) {
  const lines = [
    '<!-- obsidian-project-release-notes:start -->',
    '## Included Changes',
    '',
    previousTag ? `Range: \`${previousTag}...${currentTag}\`` : `Range: initial release through \`${currentTag}\``,
    '',
    '### Pull Requests',
    ''
  ];

  if (prs.length === 0) {
    lines.push('- No associated pull requests were found for commits in this release range.');
  } else {
    for (const pr of prs) {
      const author = pr.user?.login ? ` by @${pr.user.login}` : '';
      lines.push(`- #${pr.number} ${pr.title}${author}`);
    }
  }

  lines.push('', '### Contributors', '');

  if (contributors.length === 0) {
    lines.push('- No contributors were found for this release range.');
  } else {
    for (const contributor of contributors) {
      lines.push(`- ${contributor.label}`);
    }
  }

  lines.push('<!-- obsidian-project-release-notes:end -->');
  return lines.join('\n');
}

function replaceGeneratedSection(body, generated) {
  const pattern = /<!-- obsidian-project-release-notes:start -->[\s\S]*<!-- obsidian-project-release-notes:end -->/;
  if (pattern.test(body)) {
    return body.replace(pattern, generated);
  }

  return `${body.trim() ? `${body.trim()}\n\n` : ''}${generated}\n`;
}

async function github(route, options = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method: options.method || 'GET',
    headers: {
      Accept: options.accept || 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'obsidian-project-release-workflow'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
  }

  if (response.status === 204) {
    return undefined;
  }

  return await response.json();
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8'
  }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
