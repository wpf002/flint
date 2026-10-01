/**
 * The files Flint may change in its own repository (Machine plan P6). Anything
 * else is FORBIDDEN in tiers.ts, and the `selfmod-paths` CI check applies the
 * same list, so a PR that slips past the runtime still fails on GitHub.
 *
 * What is left out matters as much as what is in: this package (the rules
 * themselves), the MCP gate, the server, the constitution, the runtime's
 * triage, templates, governance, policy and prisma directories, every deploy and
 * backup script, `.github/**`, CODEOWNERS, every package.json and the lockfile.
 */

const ALLOWED: ReadonlyArray<RegExp> = [
  // Connectors, except the one that drives the screen.
  /^packages\/mcp\/connectors\/(?!computer-use-server\.ts$)[A-Za-z0-9_-]+\.ts$/,
  /^packages\/mcp\/test\/connectors\/[A-Za-z0-9_./-]+$/,
  // Prompt text and its tests.
  /^packages\/persona\/src\/(flint|flint-v2|flint-local|flint-local-v2|style-guide)\.ts$/,
  /^packages\/persona\/test\/(flint|flint-v2|flint-local|flint-local-v2|style-guide)\.test\.ts$/,
  // One source adapter per file; the registry (which names the endpoints a source may reach) is out.
  /^apps\/runtime\/src\/sources\/(?!registry\.ts$|index\.ts$)[A-Za-z0-9_-]+\.ts$/,
  /^apps\/runtime\/test\/sources\/[A-Za-z0-9_-]+\.test\.ts$/,
  // Docs, but not the security or plan documents.
  /^docs\/(?![^/]*(security|plan|threat|secret))[A-Za-z0-9_-]+\.md$/i,
];

/**
 * Whether Flint may change this repo-relative path. Absolute paths, `..`,
 * backslashes, empty segments and anything outside the list are refused.
 */
export function selfmodPathAllowed(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const p = path.startsWith('./') ? path.slice(2) : path;
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return ALLOWED.some((re) => re.test(p));
}

/** The paths in `paths` Flint may not change (empty when all are allowed). */
export function disallowedSelfmodPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !selfmodPathAllowed(p));
}
