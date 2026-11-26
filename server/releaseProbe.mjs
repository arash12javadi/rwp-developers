/**
 * Only the tag of a repository's latest published release: one GitHub API call, nothing downloaded. What the automatic release check
 * asks every few minutes; the full read (core `resolveReleaseCandidate`) runs only when the tag is new.
 *
 * Kept in this plugin on purpose, not imported from core: a plugin must work with the core a site already runs, and an import of a
 * name an older core does not export stops the whole module from loading.
 *
 * Returns '' when there is no published release (or only a draft or pre-release). Throws an Error with `code: 'github_rate_limit'`
 * when GitHub is limiting calls, and another Error for anything else; never includes the token in a message.
 */
export async function latestReleaseTag(fullName, { token = '', fetchImpl = fetch } = {}) {
  const [owner, repo] = String(fullName || '').split('/');
  if (!owner || !repo) throw new Error('Not a repository name.');
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'react-wp-release-check',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
  });
  if (response.status === 404) return '';
  if (response.status === 403 || response.status === 429) throw Object.assign(new Error('GitHub is limiting how often this site may ask.'), { code: 'github_rate_limit' });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  const release = await response.json().catch(() => null);
  return release && !release.draft && !release.prerelease ? String(release.tag_name || '') : '';
}
