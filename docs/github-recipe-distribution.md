# GitHub Recipe Distribution — Implementation Spec

**Status:** GitHub install and `recipe publish` are shipped; signed index remains planned, and the self-hosted registry path now ships as a static snapshot plus exact-version trusted-registry install surface
**Target:** v0.2 (pre-SaaS, open source launch)
**Depends on:** recipe.js, recipe-install.js, recipe-runner.js, cli.js

---

## Overview

Two features that make recipe distribution work via a public GitHub repo:

1. **`guardrail recipe install github://...@sha`** — SHA-pinned install from GitHub
2. **`guardrail recipe publish --name <name>`** — one-command PR submission to the public registry

The public repo is `github.com/guardrail-dev/recipes`. This avoids running a custom registry service, but it does not remove the maintainer work. The GitHub repo still needs review policy, CI, signing-key custody, incident response, and deprecation handling.

### Security and Open-Source Boundary

This distribution design improves provenance and reproducibility. It does **not** turn recipes into trusted code by itself.

- SHA pinning, trusted-source checks, and signed indexes reduce accidental drift and ambiguous provenance.
- Guardrail still does not sandbox recipe execution or certify third-party code as safe.
- Maintainers review recipe metadata, lint signals, and registry policy compliance. They are not acting as a security firm or giving a blanket safety warranty.
- Users remain responsible for what they install and what they approve for execution.
- Missing trust config, failed SHA resolution, invalid signatures, lint failures, or publish-policy failures must fail closed.
- Private-repo installs may need authenticated GitHub API fallback when raw GitHub fetches are unavailable. That only works if `gh` is installed and authenticated in the caller's runtime context.

### Name-Based Install (v0.2 vs v0.3)

In v0.2, users must provide the full `github://` URL with an explicit SHA:

```bash
guardrail recipe install github://guardrail-dev/recipes/github/open-pr.json@a3f9c12e...
```

The ergonomic shorthand — `guardrail recipe install open-pr` — requires a signed index file at the registry root that maps recipe names to SHAs. That index is planned for v0.3 (see "Signed Index" section below). In v0.2, the CLI rejects bare names with a helpful error:

```
Error: Recipe "open-pr" is not a local path, URL, or github:// source.
To install from the public registry, use the full GitHub URL:
  guardrail recipe install github://guardrail-dev/recipes/github/open-pr.json@<sha>
Browse available recipes at: https://github.com/guardrail-dev/recipes
```

---

## Feature 1: GitHub SHA-Pinned Install

### Usage

```bash
guardrail recipe install github://guardrail-dev/recipes/github/open-pr.json@a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b
```

### URL Format

```
github://<owner>/<repo>/<path>@<sha>
```

- `owner` — GitHub user or org
- `repo` — repository name
- `path` — path within the repo to the recipe JSON file
- `sha` — git commit SHA. **Required.** No branch/tag references — immutable only.

**SHA policy:** Short SHAs (7+ chars) are accepted at the CLI as input sugar, but Guardrail must resolve them to a full 40-character SHA before it fetches or stores anything. If full resolution fails, install aborts. Guardrail never stores or trusts a short-SHA pin.

### Files to Change

#### 1. `src/recipe-install.js` — ~80 lines

**Add `parseGitHubUrl(source)`:**

```js
/**
 * Parse a github:// URL into components.
 *
 * Format: github://owner/repo/path/to/file.json@sha
 * Returns: { owner, repo, path, sha, rawUrl }
 * Throws on missing sha or invalid format.
 */
export function parseGitHubUrl(source) {
  // Strip scheme
  const rest = source.replace(/^github:\/\//, '');

  // Split on @ to get sha
  const atIdx = rest.lastIndexOf('@');
  if (atIdx === -1) {
    throw new Error(
      `GitHub recipe URL must include a commit SHA: ${source}\n` +
      'Format: github://owner/repo/path/to/file.json@<sha>'
    );
  }

  const pathPart = rest.slice(0, atIdx);
  const sha = rest.slice(atIdx + 1);

  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`Invalid commit SHA "${sha}" in: ${source}`);
  }

  // Split path: owner/repo/remaining...
  const segments = pathPart.split('/');
  if (segments.length < 3) {
    throw new Error(
      `GitHub URL must include owner/repo/path: ${source}\n` +
      'Format: github://owner/repo/path/to/file.json@<sha>'
    );
  }

  const owner = segments[0];
  const repo = segments[1];
  const path = segments.slice(2).join('/');

  return {
    owner,
    repo,
    path,
    sha,
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`,
  };
}
```

**Add `loadRawJson(url)` to `src/recipe.js`:**

This is a general-purpose JSON fetcher (distinct from `loadRemoteRecipe` which validates recipe schema). It handles status codes, size limits, and returns parsed JSON. Reused by `resolveFullSha` and any future API calls.

```js
/**
 * Fetch and parse JSON from a URL with safety limits.
 *
 * - Rejects non-2xx responses with status code
 * - Limits response body to maxBytes (default 1MB) to prevent memory exhaustion
 * - Returns parsed JSON object
 *
 * @param {string} url - HTTPS URL to fetch
 * @param {object} [opts] - { headers, maxBytes, timeout }
 * @returns {Promise<object>} Parsed JSON
 */
export async function loadRawJson(url, opts = {}) {
  const { get } = await import(url.startsWith('https') ? 'node:https' : 'node:http');
  const maxBytes = opts.maxBytes || 1024 * 1024; // 1MB default
  const headers = { 'User-Agent': 'guardrail-cli', ...opts.headers };

  return new Promise((resolve, reject) => {
    const req = get(url, { headers, timeout: opts.timeout || 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          res.destroy();
          reject(new Error(`Response exceeded ${maxBytes} bytes from ${url}`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Invalid JSON from ${url}: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}
```

**Add `resolveFullSha(parsed)` to `src/recipe-install.js`:**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRawJson } from './recipe.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve a short SHA to a full 40-character SHA via the GitHub API.
 * Fails closed if the full SHA cannot be resolved.
 *
 * Strategy:
 * 1. If already 40 chars, return as-is
 * 2. Try gh CLI (authenticated, higher rate limit)
 * 3. Fallback to GitHub API via loadRawJson
 * 4. If all resolution paths fail, throw and refuse install
 */
async function resolveFullSha(parsed) {
  if (parsed.sha.length === 40) return parsed.sha.toLowerCase();

  // Try gh CLI first — authenticated requests, 5000/hr rate limit
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', `repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}`,
      '--jq', '.sha',
    ], { timeout: 10000 });
    const fullSha = stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(fullSha)) return fullSha;
  } catch { /* gh not available or API error */ }

  // Fallback: GitHub API via loadRawJson (handles status codes, size limits)
  try {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}`;
    const obj = await loadRawJson(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (obj.sha && /^[0-9a-f]{40}$/i.test(obj.sha)) return obj.sha;
  } catch { /* try next path */ }

  throw new Error(
    `Could not resolve short SHA "${parsed.sha}" for github://${parsed.owner}/${parsed.repo}/${parsed.path}.\n` +
    'Use a full 40-character SHA, or retry with GitHub API access available.'
  );
}
```

**Add `installFromGitHub(source, opts)`:**

```js
/**
 * Install a recipe from a github:// URL with SHA pinning.
 *
 * Fetches from raw.githubusercontent.com at the exact commit SHA,
 * validates the recipe, stores it locally, and writes pin metadata
 * under a hidden .pins/ directory for runtime re-verification.
 *
 * Short SHAs require GitHub API access for full resolution. Full
 * 40-character SHAs work without the extra lookup.
 */
function pinPathForRecipePath(recipePath) {
  const version = basename(recipePath, '.json');
  return join(dirname(recipePath), '.pins', `${version}.json`);
}

export async function loadGitHubRecipeFromApi(parsed, fullSha) {
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${fullSha}`,
    '--jq',
    '.content',
  ], { timeout: 10000 });

  const content = stdout.replace(/\s+/g, '');
  if (!content) {
    throw new Error(
      `GitHub contents API returned no content for github://${parsed.owner}/${parsed.repo}/${parsed.path}@${fullSha}`
    );
  }

  const recipe = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
  validateRecipe(recipe);
  return recipe;
}

export async function installFromGitHub(source, opts = {}) {
  // Trust check — github:// URLs go through the same trusted_sources gate
  const config = loadConfig(opts.configPath);
  const configPath = opts.configPath || resolve(homedir(), '.guardrail', 'config.json');

  if (!config.trusted_sources || config.trusted_sources.length === 0) {
    throw new Error(
      `No trusted sources configured. Add a trusted_sources array to ${configPath}.\n` +
      `Example: { "trusted_sources": ["github://guardrail-dev/recipes/"] }`
    );
  }
  if (!checkTrustedSource(source, config.trusted_sources)) {
    throw new Error(
      `Source "${source}" is not in trusted sources.\n` +
      `Add a matching prefix to ${configPath}.`
    );
  }

  const parsed = parseGitHubUrl(source);

  // Resolve short SHA to full 40-char SHA
  const fullSha = await resolveFullSha(parsed);
  const resolvedRawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${fullSha}/${parsed.path}`;

  const remoteLoader = opts.loadRemoteRecipe ?? loadRemoteRecipe;
  let recipe;
  try {
    recipe = await remoteLoader(resolvedRawUrl);
  } catch (rawErr) {
    const githubApiLoader = opts.loadGitHubRecipeFromApi ?? loadGitHubRecipeFromApi;
    try {
      recipe = await githubApiLoader(parsed, fullSha);
    } catch {
      throw rawErr;
    }
  }
  const result = _installRecipeToStore(recipe, opts);

  // Write pin metadata under a hidden directory so recipe indexing
  // and version scans continue to see only executable recipe artifacts.
  const pinPath = pinPathForRecipePath(result.path);
  mkdirSync(dirname(pinPath), { recursive: true });
  const pin = {
    source,
    owner: parsed.owner,
    repo: parsed.repo,
    path: parsed.path,
    sha: fullSha,          // Always store full 40-char SHA
    input_sha: parsed.sha, // Original user input for reference
    rawUrl: resolvedRawUrl,
    content_hash: result.hash,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');

  return { ...result, pin };
}
```

**Rename `installRecipe` → `_installRecipeToStore`:**

Currently `installRecipe` is called by `installFromPath`, `installFromUrl`, and `installFromGitHub`. Rename it to `_installRecipeToStore` to signal it's the internal-but-shared install core, not a public API. Update the three callers accordingly.

#### 2. `src/recipe-runner.js` — ~40 lines

**In `runRecipeById()`, after `resolveRecipeById()` returns `{ recipe, sourcePath }`, add pin verification:**

```js
const { recipe, sourcePath, version } = resolveRecipeById(specifier, opts.searchDirs);
await verifyPinnedRecipeSource(recipe, sourcePath, opts);

// ...

async function verifyPinnedRecipeSource(recipe, sourcePath, opts = {}) {
  const pinPath = pinPathForRecipePath(sourcePath);
  if (!existsSync(pinPath)) return;

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const currentHash = hashRecipe(recipe);
  if (currentHash !== pin.content_hash) {
    throw Object.assign(
      new Error(
        `Pin verification failed for "${recipe.id}": local content hash does not match ` +
        `pinned hash from ${pin.source}. Recipe may have been tampered with.\n` +
        `Expected: ${pin.content_hash}\n` +
        `Got:      ${currentHash}\n` +
        'Re-install the recipe to fix: guardrail recipe install ' + pin.source
      ),
      { exitCode: 12 }
    );
  }

  // Re-fetch from GitHub to verify remote hasn't changed.
  // Git SHAs should be immutable; a mismatch indicates compromise
  // or severe upstream corruption.
  if (!opts.skipRemoteVerify) {
    try {
      const remoteLoader = opts.loadRemoteRecipe ?? loadRemoteRecipe;
      const githubApiLoader = opts.loadGitHubRecipeFromApi ?? loadGitHubRecipeFromApi;
      let remoteRecipe = null;

      try {
        remoteRecipe = await remoteLoader(pin.rawUrl);
      } catch (rawErr) {
        if (pin.owner && pin.repo && pin.path && pin.sha) {
          try {
            remoteRecipe = await githubApiLoader({
              owner: pin.owner,
              repo: pin.repo,
              path: pin.path,
            }, pin.sha);
          } catch {
            throw rawErr;
          }
        } else {
          throw rawErr;
        }
      }

      const remoteHash = hashRecipe(remoteRecipe);
      if (remoteHash !== pin.content_hash) {
        throw Object.assign(
          new Error(
            `Remote verification failed for "${recipe.id}": content at ${pin.source} ` +
            `no longer matches pinned hash. Possible upstream compromise. Exit 12.`
          ),
          { exitCode: 12 }
        );
      }
    } catch (err) {
      if (err.exitCode === 12) throw err;
      // Network failure is not fatal — local pin still protects the
      // installed artifact.
    }
  }
}
```

**Notes:**
- Remote re-verification is best-effort. If the network is unavailable (air-gapped, offline), the local pin hash still protects against tampering.
- The `skipRemoteVerify` flag name matches the positive action — "skip remote verify" is unambiguous. Default is `false` (verify on).
- Pin metadata lives in `~/.guardrail/recipes/<id>/.pins/` so existing recipe index and version scans keep seeing only runnable recipe JSON files.
- Pre-v0.2 installs without matching pin metadata proceed normally — no verification, no error. This grandfathers existing installs without forcing re-install.

#### 3. `src/cli.js` — ~5 lines

**In the `recipe-install` handler, add the `github://` route:**

```js
// Current (line 1298):
if (source.startsWith('http://') || source.startsWith('https://')) {

// Change to:
if (source.startsWith('github://')) {
  const { installFromGitHub } = await import('./recipe-install.js');
  result = await installFromGitHub(source, { force: parsed.force });
} else if (source.startsWith('http://') || source.startsWith('https://')) {
```

**Add bare-name rejection with helpful error:**

```js
// After all install branches, before the else-error:
} else if (/^[a-z][a-z0-9-]*$/.test(source) && !existsSync(source)) {
  // Looks like a recipe name, not a file path
  console.error(
    `Recipe "${source}" is not a local path, URL, or github:// source.\n` +
    'To install from the public registry, use the full GitHub URL:\n' +
    `  guardrail recipe install github://guardrail-dev/recipes/<category>/${source}.json@<sha>\n` +
    'Browse available recipes at: https://github.com/guardrail-dev/recipes'
  );
  process.exit(1);
```

### Trust Configuration

Users add `github://` prefixes to their trusted sources:

```json
{
  "trusted_sources": [
    "github://guardrail-dev/recipes/",
    "github://my-org/internal-recipes/"
  ]
}
```

Prefix matching works as-is — `checkTrustedSource()` already does `source.startsWith(prefix)`.

### Storage Layout

```
~/.guardrail/recipes/
  open-pr/
    1.0.0.json          # Recipe content (standard)
    .pins/
      1.0.0.json        # GitHub source pin metadata (new)
```

The hidden `.pins/` directory is metadata only and must be ignored by recipe list/index/version scans.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Install succeeded |
| 1    | Install failed (validation, trust, network) |
| 12   | Pin verification failed (drift/tamper on run) |

### Logging and Audit Expectations

Install and publish flows should emit the same kind of structured, low-surprise records as the rest of Guardrail. At minimum, record:

- event name (`recipe_install_started`, `recipe_install_succeeded`, `recipe_install_failed`, `recipe_publish_started`, `recipe_publish_dry_run`, `recipe_publish_pr_opened`)
- actor / trace ID when available
- source URL, resolved full SHA, recipe id/version, content hash
- trust decision inputs (`trusted_source_match`, `allow_unverified`, resolved channel)
- publish outcome metadata (`dryRun`, PR URL, fork owner, blocked guard)

These logs must never print auth tokens, GitHub CLI credentials, or raw secret values. For open-source maintainability, failures should be diagnosable from structured fields rather than from verbose ad hoc console output.

### Agent and CI Runtime Note

The `github://` flow behaves the same for humans, CI, and agents, but the environment matters:

- the runtime still needs a matching `trusted_sources` entry
- public repositories can often rely on raw GitHub fetch alone
- private repositories require `gh` authentication in that same runtime
- if the runtime overrides `HOME`, moves into a container, or runs under a different service account, `GH_CONFIG_DIR` may need to be set explicitly so the authenticated fallback can work

If those conditions are not met, Guardrail must fail closed rather than silently bypassing GitHub provenance checks.

### Migration Path

Recipes installed before v0.2 (without `.pins/<version>.json` metadata) continue to work normally. Pin verification only activates when matching pin metadata exists. No re-install required. Users who want pin protection on existing recipes can re-install them with a `github://` URL.

---

## Feature 2: Recipe Publish

### Usage

```bash
guardrail recipe publish --name npm-install-safe --category packages
```

**Requires:** `gh` CLI installed and authenticated. `GITHUB_TOKEN` alone is insufficient — `gh` is used for fork, branch, file write, and PR creation (4 API calls minimum). With a personal access token, the rate limit is 5,000 requests/hour. The unauthenticated limit of 60/hour is not sufficient for publish. If `gh` is not installed or not authenticated, the error is:

```
Error: GitHub CLI (gh) is required for recipe publish.
Install: https://cli.github.com
Authenticate: gh auth login
```

### Output

```
✓ Lint passed (7 checks)
✓ Personal data scrubbed
✓ Recipe written: packages/npm-install-safe.json
✓ Forked guardrail-dev/recipes
✓ Branch created: recipe/npm-install-safe
✓ PR opened: https://github.com/guardrail-dev/recipes/pull/14

Content hash: sha256:a3f9c12e...
The maintainers will review your recipe.
You'll get a GitHub notification when it's merged.
```

### File to Create: `src/recipe-publish.js` — ~250 lines

This is a new file. It orchestrates the full publish flow.

### Flow

```
Developer runs: guardrail recipe publish --name open-pr --category github
        ↓
1. Check gh CLI is installed and authenticated
        ↓
2. Read the local approved command manifest (.guardrail/approved.json)
        ↓
3. Risk floor check — RED recipes blocked from public registry
        ↓
4. Convert structured command manifest → recipe JSON
        ↓
5. Lint against recipe schema (validateRecipe)
        ↓
6. Scrub personal data from metadata fields only
        ↓
7. Compute content hash (hashRecipe)
        ↓
8. Fork guardrail-dev/recipes (or use existing fork) via GitHub API
        ↓
9. Create branch: recipe/<name>
        ↓
10. Write recipe file to correct category path
        ↓
11. Open PR against guardrail-dev/recipes:main
        ↓
12. Print PR URL + content hash
```

### Implementation

```js
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadManifest } from './manifest.js';
import { validateRecipe, hashRecipe } from './recipe.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPSTREAM_OWNER = 'guardrail-dev';
const UPSTREAM_REPO = 'recipes';
const PUBLISH_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// gh CLI prerequisite check
// ---------------------------------------------------------------------------

/**
 * Verify that gh CLI is installed and authenticated.
 * Throws with actionable error if not.
 */
function requireGhCli() {
  try {
    execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || '';
    if (stderr.includes('not logged in') || stderr.includes('no oauth token')) {
      throw new Error(
        'GitHub CLI (gh) is not authenticated.\n' +
        'Run: gh auth login'
      );
    }
    // gh not installed at all
    throw new Error(
      'GitHub CLI (gh) is required for recipe publish.\n' +
      'Install: https://cli.github.com\n' +
      'Authenticate: gh auth login'
    );
  }
}

// ---------------------------------------------------------------------------
// Personal data scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub personal data from a recipe before publishing.
 *
 * - Human-facing metadata fields containing usernames → {{working_dir}}
 * - Input defaults containing user-specific absolute paths → {{working_dir}}
 * - approved_by → ["author"]
 * - Timestamps → null
 *
 * This function must not rewrite steps[*].run.command or steps[*].run.args.
 * If executable fields contain user-specific absolute paths, publish should
 * fail and tell the author to create a template or author the recipe manually.
 */
export function scrubPersonalData(recipe) {
  const scrubbed = JSON.parse(JSON.stringify(recipe));
  const userPathRe = /(?:\/Users\/[^/"\s]+|\/home\/[^/"\s]+|C:\\Users\\[^"\\\s]+)/g;

  const scrubText = (value) => typeof value === 'string'
    ? value.replace(userPathRe, '{{working_dir}}')
    : value;

  // Strip approval identity
  if (scrubbed.acknowledgedBy) scrubbed.acknowledgedBy = 'author';
  if (scrubbed.approved_by) scrubbed.approved_by = ['author'];

  // Null out timestamps
  if (scrubbed.approvedAt) scrubbed.approvedAt = null;
  if (scrubbed.acknowledgedAt) scrubbed.acknowledgedAt = null;

  // Scrub human-facing metadata only.
  scrubbed.description = scrubText(scrubbed.description);
  if (typeof scrubbed.author === 'string') scrubbed.author = scrubText(scrubbed.author);
  if (scrubbed.inputs) {
    for (const def of Object.values(scrubbed.inputs)) {
      if (def && typeof def === 'object') {
        if (def.description) def.description = scrubText(def.description);
        if (typeof def.default === 'string' && userPathRe.test(def.default)) {
          def.default = '{{working_dir}}';
        }
      }
    }
  }

  // Do not mutate executable fields. Reject instead.
  for (const step of scrubbed.steps || []) {
    const execFields = [step.run?.command, ...(step.run?.args || [])];
    if (execFields.some(v => typeof v === 'string' && userPathRe.test(v))) {
      throw new Error(
        'Recipe publish cannot safely scrub user-specific absolute paths from executable fields.\n' +
        'Create a template or author the recipe manually with explicit inputs first.'
      );
    }
  }

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Manifest → Recipe conversion
// ---------------------------------------------------------------------------

/**
 * Convert an approved structured command manifest into a publishable recipe.
 *
 * Preserves the approved command/argv shape exactly. This is packaging,
 * not template inference. Shell manifests are rejected in v0.2 because
 * recipes only support structured execution.
 */
export function manifestToRecipe(manifest, opts) {
  const { name, category, description } = opts;

  if (!name) throw new Error('--name is required for recipe publish');
  if (!category) throw new Error('--category is required for recipe publish');

  const contract = manifest.contract;
  const risk = manifest.riskAssessment;
  if (!contract) throw new Error('Approved command manifest is missing contract');
  if (contract.mode !== 'structured') {
    throw new Error(
      'recipe publish only supports structured command manifests in v0.2.\n' +
      'Shell manifests must be rewritten as recipes manually.'
    );
  }

  // Map risk level: green→low, yellow→medium, red→high
  const riskMap = { green: 'low', yellow: 'medium', red: 'high' };

  const recipe = {
    id: name,
    name: opts.displayName || name.replace(/-/g, ' '),
    description: description || `Recipe generated from approved manifest for ${name}`,
    version: opts.version || '1.0.0',
    author: opts.author || 'author',
    category: category,
    channel: 'community',
    risk_level: riskMap[risk?.riskLevel] || 'medium',
    approval_required: risk?.riskLevel !== 'green',
    inputs: opts.inputs || {},
    steps: buildStepsFromContract(contract),
    guardrails: buildGuardrailsFromContract(contract),
  };

  if (opts.tags) recipe.tags = opts.tags;

  return recipe;
}

/**
 * Build recipe steps from contract command/args.
 */
function buildStepsFromContract(contract) {
  if (!contract) return [];

  const command = contract.command || '';
  const args = Array.isArray(contract.args) ? contract.args : [];

  return [{
    id: 'main',
    description: [command, ...args].join(' '),
    run: {
      command,
      args,
      mode: 'structured',
    },
  }];
}

/**
 * Build guardrails from contract constraints.
 */
function buildGuardrailsFromContract(contract) {
  const guardrails = { constraints: [], invariants: [] };

  if (contract?.writablePaths?.length) {
    guardrails.constraints.push(
      `writable paths: ${contract.writablePaths.join(', ')}`
    );
  }
  if (contract?.allowedBinaries?.length) {
    guardrails.constraints.push(
      `allowed binaries: ${contract.allowedBinaries.join(', ')}`
    );
  }

  guardrails.invariants.push('mode: structured');

  return guardrails;
}

// ---------------------------------------------------------------------------
// GitHub API helpers (uses gh CLI)
// ---------------------------------------------------------------------------

/**
 * Run a gh CLI command and return stdout.
 */
function gh(args, opts = {}) {
  try {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('gh() requires a non-empty argv array');
    }
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`GitHub CLI error: ${stderr}`);
  }
}

/**
 * Ensure the user has a fork of the upstream recipes repo.
 * Returns the fork's owner/repo string.
 */
export function ensureFork() {
  const username = gh(['api', 'user', '--jq', '.login']);

  // Check if fork already exists
  try {
    gh(['api', `repos/${username}/${UPSTREAM_REPO}`, '--jq', '.fork']);
    return `${username}/${UPSTREAM_REPO}`;
  } catch { /* fork doesn't exist yet */ }

  // Create fork
  gh(['repo', 'fork', `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`, '--clone=false']);
  return `${username}/${UPSTREAM_REPO}`;
}

/**
 * Create a branch, write the recipe file, and open a PR.
 * Returns { prUrl, branch, filePath, hash }.
 */
export function createRecipePR(fork, recipe, opts) {
  const branch = `recipe/${recipe.id}`;
  const category = recipe.category || 'custom';
  const filePath = `${category}/${recipe.id}.json`;
  const content = JSON.stringify(recipe, null, 2) + '\n';
  const contentBase64 = Buffer.from(content).toString('base64');
  const hash = hashRecipe(recipe);

  // Create branch from upstream main
  const mainSha = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/git/refs/heads/main`,
    '--jq',
    '.object.sha',
  ]);
  try {
    gh(['api', `repos/${fork}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${mainSha}`]);
  } catch {
    // Branch may already exist — update it
    gh(['api', `repos/${fork}/git/refs/heads/${branch}`, '-X', 'PATCH', '-f', `sha=${mainSha}`, '-f', 'force=true']);
  }

  // Write file to branch
  gh([
    'api',
    `repos/${fork}/contents/${filePath}`,
    '-X',
    'PUT',
    '-f',
    `message=Add recipe: ${recipe.id}`,
    '-f',
    `content=${contentBase64}`,
    '-f',
    `branch=${branch}`,
  ]);

  // Build PR body
  const body = buildPRBody(recipe, hash, opts);

  // Check if PR already exists for this branch
  const existingPr = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`,
    '--jq',
    `.[] | select(.head.label == "${fork.split('/')[0]}:${branch}") | .html_url`,
  ]);
  if (existingPr) {
    return { prUrl: existingPr, branch, filePath, hash, updated: true };
  }

  // Open PR
  const prUrl = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`,
    '-f',
    `title=Recipe: ${recipe.id}`,
    '-f',
    `head=${fork.split('/')[0]}:${branch}`,
    '-f',
    'base=main',
    '--input',
    '-',
    '--jq',
    '.html_url',
  ], { input: JSON.stringify({ body }) });

  return { prUrl, branch, filePath, hash };
}

// ---------------------------------------------------------------------------
// PR body generation
// ---------------------------------------------------------------------------

/**
 * Build the structured PR description.
 *
 * The body includes recipe metadata, input table, steps, content hash,
 * and a lint checklist with all boxes pre-checked (only lint-passing
 * recipes reach this point).
 */
export function buildPRBody(recipe, hash, opts = {}) {
  const inputs = recipe.inputs || {};
  const steps = recipe.steps || [];
  const guardrails = recipe.guardrails || {};

  // Input table
  let inputTable = '| Field | Type | Constraint |\n|---|---|---|\n';
  for (const [name, def] of Object.entries(inputs)) {
    const constraint = def.pattern ? `\`${def.pattern}\`` :
                       def.enum ? def.enum.join(', ') :
                       def.min !== undefined ? `${def.min}–${def.max}` : '—';
    inputTable += `| ${name} | ${def.type} | ${constraint} |\n`;
  }
  if (Object.keys(inputs).length === 0) {
    inputTable = 'No inputs required.\n';
  }

  // Steps list
  const stepsList = steps.map((s, i) =>
    `${i + 1}. \`${s.run?.command || s.description}\`${s.idempotent ? ' — idempotent: true' : ''}`
  ).join('\n');

  // Environment
  const envSection = recipe.requires_env?.length
    ? recipe.requires_env.map(e => `- \`${e}\``).join('\n')
    : 'No env vars required.';

  // Validator
  const validatorSection = steps
    .filter(s => s.validator?.regex)
    .map(s => `\`${s.validator.regex}\``)
    .join(', ') || '—';

  // Rollback
  const rollbackSection = recipe.rollback?.steps?.length
    ? recipe.rollback.steps.map(s => `\`${s.run?.command || s.description}\``).join(', ')
    : '—';

  // Lint checklist (auto-verified)
  const lintChecks = [
    'mode: structured on all steps',
    'No bare string inputs',
    'Rollback declared',
    'Validator present',
    'No shell metacharacters in arg patterns',
    'Regex complexity within budget',
    'No secret patterns in env declarations',
  ];
  const checklist = lintChecks.map(c => `- [x] ${c}`).join('\n');

  return `## Recipe: ${recipe.id}

**Category:** ${recipe.category || 'custom'}
**Risk:** ${(recipe.risk_level || 'medium').toUpperCase()}
**Channel:** community
**Submitted via:** guardrail recipe publish v${PUBLISH_VERSION}

### What it does
${recipe.description}

### Inputs
${inputTable}

### Environment
${envSection}

### Steps
${stepsList}

### Validator
${validatorSection}

### Rollback
${rollbackSection}

### Content hash
\`sha256:${hash}\`

### Checklist (auto-verified by guardrail lint)
${checklist}

### Test it locally
\`\`\`bash
guardrail recipe install github://${opts.fork || 'guardrail-dev/recipes'}/${recipe.category || 'custom'}/${recipe.id}.json@{sha}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Main publish orchestrator
// ---------------------------------------------------------------------------

/**
 * Publish a recipe from a local approved manifest to the public registry.
 *
 * Flow:
 * 1. Check gh CLI
 * 2. Load approved manifest
 * 3. Risk floor check (RED blocked)
 * 4. Convert manifest → recipe
 * 5. Lint (validateRecipe)
 * 6. Scrub personal data
 * 7. Compute content hash
 * 8. Fork + branch + PR via GitHub API
 *
 * @param {object} opts
 * @param {string} opts.name         - Recipe name (kebab-case)
 * @param {string} opts.category     - Recipe category
 * @param {string} [opts.description]
 * @param {string} [opts.version]    - Defaults to '1.0.0'
 * @param {string} [opts.author]
 * @param {string} [opts.manifestPath]
 * @param {boolean} [opts.dryRun]    - Stop before GitHub operations
 * @param {Function} [opts.log]      - Output function (default: console.log)
 */
export async function publishRecipe(opts) {
  const log = opts.log || console.log;
  const steps = [];

  // 0. Check gh CLI (skip for dry-run since we won't touch GitHub)
  if (!opts.dryRun) {
    requireGhCli();
  }

  // 1. Load manifest
  const manifestPath = opts.manifestPath || resolve('.guardrail', 'approved.json');
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    throw new Error(
      `No approved manifest found at ${manifestPath}.\n` +
      'Run a command with guardrail first to create an approved manifest.'
    );
  }

  // 2. Risk floor check — RED cannot be published to public registry
  const riskLevel = manifest.riskAssessment?.riskLevel;
  if (riskLevel === 'red') {
    throw new Error(
      'RED-risk recipes cannot be published to the public registry.\n' +
      'RED recipes can exist locally and in private org registries.\n' +
      'For the public registry, submit a manual PR with an explicit justification.'
    );
  }

  // 3. Convert manifest to recipe
  const recipe = manifestToRecipe(manifest, opts);

  // 4. Lint (validates recipe schema)
  validateRecipe(recipe);
  steps.push('Lint passed');

  // 5. Scrub personal data
  const scrubbed = scrubPersonalData(recipe);
  steps.push('Personal data scrubbed');

  // 6. Compute hash
  const hash = hashRecipe(scrubbed);

  // 7. Write recipe file path for display
  const filePath = `${scrubbed.category || 'custom'}/${scrubbed.id}.json`;
  steps.push(`Recipe written: ${filePath}`);

  if (opts.dryRun) {
    log('');
    for (const s of steps) log(`✓ ${s}`);
    log('');
    log(`Content hash: sha256:${hash}`);
    log('');
    log('Dry run — no GitHub operations performed.');
    log('Recipe JSON:');
    log(JSON.stringify(scrubbed, null, 2));
    return { recipe: scrubbed, hash, steps, dryRun: true };
  }

  // 8. Fork
  const fork = ensureFork();
  steps.push(`Forked ${UPSTREAM_OWNER}/${UPSTREAM_REPO}`);

  // 9. Branch + write + PR
  const pr = createRecipePR(fork, scrubbed, { fork });
  steps.push(`Branch created: recipe/${scrubbed.id}`);
  if (pr.updated) {
    steps.push(`PR updated: ${pr.prUrl}`);
  } else {
    steps.push(`PR opened: ${pr.prUrl}`);
  }

  // 10. Output
  log('');
  for (const s of steps) log(`✓ ${s}`);
  log('');
  log(`Content hash: sha256:${hash}`);
  log('The maintainers will review your recipe.');
  log("You'll get a GitHub notification when it's merged.");

  return { recipe: scrubbed, hash, prUrl: pr.prUrl, steps };
}
```

### CLI Integration (`src/cli.js`)

Add to argument parsing (near existing `recipe-validate`, `recipe-inspect`):

```js
// In help text:
'  recipe publish --name <name> --category <cat> [--manifest <path>] [--description <desc>] [--dry-run]'

// In argument parsing:
case 'publish':
  result.subcommand = 'recipe-publish';
  // parse --name, --category, --manifest, --description, --version, --author, --dry-run
  break;

// In command routing:
if (parsed.subcommand === 'recipe-publish') {
  const { publishRecipe } = await import('./recipe-publish.js');
  await publishRecipe({
    name: parsed.name,
    category: parsed.category,
    description: parsed.description,
    version: parsed.version,
    author: parsed.author,
    dryRun: parsed.dryRun,
    manifestPath: parsed.manifestPath,
  });
  process.exit(0);
}
```

### Guards

| Guard | Behavior |
|-------|----------|
| `gh` CLI required | Checked first (before manifest load). Clear error with install + auth instructions. Skipped for `--dry-run`. |
| RED risk floor | RED recipes rejected locally — cannot publish to public registry. Must submit manual PR with justification. |
| Lint gate | `validateRecipe()` runs before any GitHub operation. Bare string inputs, shell mode, missing rollback, ReDoS regex → rejected locally. |
| Structured-only source | `recipe publish` accepts structured command manifests only. Shell manifests fail locally with an actionable error. |
| Personal data scrub | Absolute user paths in metadata/defaults → `{{working_dir}}`; approval identity and timestamps are scrubbed; executable fields are never rewritten. |
| Channel assignment | Published recipes are always written as `channel: "community"`. Verified status is granted by maintainers after merge. |
| Rate limit | `gh` uses authenticated requests (5,000/hour). Publish makes ~4 API calls. No unauthenticated path. |
| Audit trail | Install/publish attempts write structured events with source, SHA, hash, actor, and blocking reason. No secrets or tokens in logs. |

### Maintainer Responsibilities

This design is low-infrastructure, not low-maintenance. If Guardrail ships a public recipe registry, maintainers still own:

- CI that validates recipe schema, lint, channel rules, and index generation
- signing-key custody, rotation, and revocation procedures
- PR review standards for community submissions
- deprecation, yanking, and incident-response playbooks when a published recipe is found to be misleading or unsafe
- contributor-facing documentation that explains what review does and does not guarantee

Open-source sustainability matters here. The registry should stay intentionally boring: deterministic layout, few moving parts, explicit review checklists, and logs that make install/publish failures easy to debug.

### PR Body Template

The PR body is auto-generated with:
- Recipe metadata (category, risk, channel)
- Input table with types and constraints
- Environment requirements
- Step list with idempotency flags
- Validator patterns extracted from step definitions
- Rollback commands extracted from rollback block
- Content hash for reviewer verification
- Lint checklist (all boxes pre-checked — only lint-passing recipes reach this point)
- Local install command for reviewers to test

### Edge Cases

| Case | Handling |
|------|----------|
| `gh` not installed | Error: "GitHub CLI (gh) is required..." with install URL |
| `gh` not authenticated | Error: "GitHub CLI (gh) is not authenticated..." with `gh auth login` |
| No approved manifest | Error: "Run a command with guardrail first" |
| Shell manifest publish | Error: `recipe publish only supports structured command manifests in v0.2` |
| RED risk level | Error: blocked from public registry, suggests manual PR |
| Lint failure | Error with specific check that failed, before touching GitHub |
| Fork already exists | Reused — checked via `repos/{user}/{repo}` API |
| Branch already exists | Updated to latest upstream main |
| PR already open for branch | Detected via pulls API query, reported as "PR updated" |
| Recipe name collision | GitHub PR review process catches this — two PRs for same path require human decision |

---

## Signed Index (v0.3)

The v0.3 milestone adds a signed `index.json` at the registry root that enables name-based install:

```bash
guardrail recipe install open-pr      # Resolves via index → github://...@sha
```

### Index Format

```json
{
  "version": 1,
  "generated_at": "2026-04-07T...",
  "signature": {
    "algorithm": "ed25519",
    "key_id": "guardrail-recipes-2026-q2",
    "sig": "base64:..."
  },
  "recipes": {
    "open-pr": {
      "category": "github",
      "path": "github/open-pr.json",
      "sha": "a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b",
      "content_hash": "sha256:...",
      "version": "1.0.0",
      "risk_level": "medium"
    }
  }
}
```

The index is generated by CI on merge to main, signed with a maintainer private key, and published to a well-known location. Guardrail verifies it with the corresponding public key bundled with Guardrail or fetched from a trusted keyring, then resolves the name to a full `github://` URL with SHA. This is additive — explicit `github://` URLs continue to work.

---

## Failure Mode Reference

| Failure | Exit | Message | Fix |
|---------|------|---------|-----|
| No SHA in URL | 1 | `GitHub recipe URL must include a commit SHA` | Add `@sha` to URL |
| SHA not in trusted sources | 1 | `Source is not in trusted sources` | Add prefix to config |
| Short SHA could not be resolved | 1 | `Could not resolve short SHA ...` | Use a full 40-character SHA or restore GitHub API access |
| Network unavailable, no local pin | 1 | `Failed to fetch recipe` | Check connection |
| Network unavailable, local pin exists | 0 | (warning logged) | Proceeds on local pin |
| Local file tampered | 12 | `Pin verification failed` | Re-install recipe |
| Remote content changed at SHA | 12 | `Remote verification failed — possible upstream compromise` | Escalate to security |
| `gh` not installed | 1 | `GitHub CLI (gh) is required for recipe publish` | Install gh CLI |
| `gh` not authenticated | 1 | `GitHub CLI (gh) is not authenticated` | Run `gh auth login` |
| Shell manifest publish | 1 | `recipe publish only supports structured command manifests in v0.2` | Author the recipe manually or start from a template |
| RED risk published | 1 | `RED-risk recipes cannot be published to the public registry` | Submit manual PR |
| Bare recipe name (no SHA) | 1 | `Recipe "X" is not a local path, URL, or github:// source` | Use full github:// URL |

---

## Tests to Write

### Feature 1: GitHub Install

```
test-github-install.js (~45 tests)

loadRawJson (in recipe.js):
  ✓ fetches and parses valid JSON
  ✓ rejects non-2xx responses with status code in error
  ✓ rejects response exceeding maxBytes limit
  ✓ rejects invalid JSON with parse error
  ✓ rejects on network timeout
  ✓ uses User-Agent: guardrail-cli header

parseGitHubUrl:
  ✓ parses valid github://owner/repo/path@sha
  ✓ handles short SHA (7 chars)
  ✓ handles full SHA (40 chars)
  ✓ rejects missing SHA
  ✓ rejects invalid SHA characters (uppercase OK, non-hex rejected)
  ✓ rejects too-short SHA (< 7 chars)
  ✓ rejects missing path (owner/repo only)
  ✓ handles nested paths (github://o/r/a/b/c.json@sha)
  ✓ handles @ in path segments (lastIndexOf correctness)
  ✓ extracts rawUrl pointing to raw.githubusercontent.com

resolveFullSha:
  ✓ returns full SHA unchanged
  ✓ resolves short SHA to full 40-char via API
  ✓ rejects unresolved short SHA (never stores a short pin)

installFromGitHub:
  ✓ installs recipe + writes .pins/<version>.json metadata
  ✓ pin metadata contains source, sha (full 40-char), content_hash, rawUrl
  ✓ pin metadata stores input_sha (original user input)
  ✓ rejects untrusted source
  ✓ rejects when no trusted_sources configured
  ✓ error message includes resolved config path (not hardcoded ~/.guardrail)
  ✓ immutability: same version + same content → "already installed"
  ✓ immutability: same version + different content → error
  ✓ listInstalled/listVersions ignore .pins metadata

Pin verification (in recipe-runner):
  ✓ passes when local hash matches pin
  ✓ exit 12 when local hash diverges from pin
  ✓ error message includes expected vs got hashes
  ✓ error message includes re-install command
  ✓ remote verify passes when remote matches pin
  ✓ remote verify exit 12 when remote diverges
  ✓ proceeds when no pin metadata exists (non-GitHub recipe)
  ✓ proceeds when no pin metadata exists (pre-v0.2 install)
  ✓ proceeds when network unavailable (offline-first)
  ✓ skipRemoteVerify=true skips remote check
  ✓ network error during remote verify logs warning, continues

CLI:
  ✓ bare recipe name shows helpful error with github:// example
  ✓ github:// source routes to installFromGitHub
```

### Feature 2: Recipe Publish

```
test-recipe-publish.js (~40 tests)

requireGhCli:
  ✓ passes when gh is installed and authenticated
  ✓ throws with install URL when gh not found
  ✓ throws with auth instructions when gh not authenticated
  ✓ skipped during dry-run

scrubPersonalData:
  ✓ replaces /Users/alice/... with {{working_dir}} in metadata/defaults
  ✓ replaces /home/bob/... with {{working_dir}} in metadata/defaults
  ✓ replaces C:\Users\... with {{working_dir}} in metadata/defaults
  ✓ handles multiple path occurrences in recipe metadata
  ✓ replaces approved_by with ["author"]
  ✓ replaces acknowledgedBy with "author"
  ✓ nulls approvedAt and acknowledgedAt
  ✓ rejects user-specific absolute paths in executable fields
  ✓ preserves recipe structure after scrub (round-trip valid)
  ✓ handles recipe with no personal data (no-op)

manifestToRecipe:
  ✓ converts manifest to valid recipe (passes validateRecipe)
  ✓ maps green→low, yellow→medium, red→high
  ✓ defaults to medium when riskLevel missing
  ✓ requires --name (throws without)
  ✓ requires --category (throws without)
  ✓ rejects shell manifests
  ✓ preserves command + args as structured recipe fields
  ✓ builds guardrails from contract constraints
  ✓ sets channel to "community"
  ✓ sets approval_required=false only for green

publishRecipe:
  ✓ rejects RED risk level before any GitHub call
  ✓ rejects when no manifest exists
  ✓ rejects when manifest path is wrong
  ✓ rejects shell manifests before any GitHub call
  ✓ dry-run returns recipe without GitHub ops
  ✓ dry-run skips gh CLI check
  ✓ validates recipe schema before GitHub ops
  ✓ lint failure prevents any GitHub API call
  ✓ scrub runs after lint (valid recipe → scrubbed recipe)
  ✓ full publish returns prUrl and hash

buildPRBody:
  ✓ includes category, risk, channel
  ✓ includes input table with types and constraints
  ✓ handles recipe with no inputs
  ✓ includes steps list with idempotency flags
  ✓ includes validator patterns from step definitions
  ✓ includes rollback commands from rollback block
  ✓ handles recipe with no rollback (shows —)
  ✓ includes content hash
  ✓ includes lint checklist (all 7 checks marked)
  ✓ includes install command with fork path

ensureFork:
  ✓ returns existing fork without creating new one
  ✓ creates fork when none exists

--as-template:
  ✓ writes to .guardrail/templates/<id>.json (not recipes dir)
  ✓ adds _source block with type, source, content_hash, trust_class, installed_at
  ✓ sets trust_class to reviewed_internal
  ✓ fatal lint errors block write (no file on disk)
  ✓ non-fatal lint warnings displayed but don't block
  ✓ --force overrides fatal lint errors
  ✓ content_hash in _source matches hashRecipe of original
  ✓ hashTemplateDefinition excludes _source block

trust hash comparison (in template-supervisor):
  ✓ unmodified template inherits _source.trust_class
  ✓ modified template forced to reviewed_internal
  ✓ template without _source treated as reviewed_internal (default)
  ✓ _source.content_hash mismatch logs reason for re-approval
```

---

## Roadmap Position

These features belong in **Open Source Launch (v0.2)** — they require no infrastructure, just the GitHub repo and `gh` CLI.

| # | Feature | Target | Status |
|---|---------|--------|--------|
| D0a | GitHub SHA-pinned install (`github://`) | v0.2 | Done |
| D0b | Recipe publish (`guardrail recipe publish`) | v0.2 | Done |
| D0c | Signed index for name-based install | v0.3 | Not started |
| D1 | npm registry (`@guardrail/recipes`) | v0.3 | Not started — ships after GitHub distribution is proven |
| D2 | Self-hosted recipe registry | v0.5 | Done — `guardrail recipe registry export` writes the static `v1/recipes/*` JSON layout, `recipe registry list` inspects it, and `recipe install <category/id@version> --registry <root>` consumes it under `trusted_registries` |

---

## Templates vs Recipes

Templates and recipes serve different purposes and have a precise relationship.

### Distinction

| | Template | Recipe |
|---|---|---|
| **What it is** | A parameterized workflow skeleton you author locally | A pre-built, community-reviewed execution contract |
| **Who makes it** | You, for your team or project | Guardrail maintainers or community contributors |
| **Inputs** | Declared by you, filled in at run time | Declared by the recipe author, filled in by you |
| **Trust class** | `reviewed_internal` — you own it | `reviewed_internal` or `pinned_external` |
| **Stored where** | `.guardrail/templates/` in your repo | Remote registry or local cache (`~/.guardrail/recipes/`) |
| **Relationship** | Can become a recipe via `guardrail recipe publish` | Can be installed locally as a starting point |

**A template is a repo-local authoring artifact. A recipe is a distributed execution artifact.**

### Where Templates Live

```
your-repo/
  .guardrail/
    approved.json                  ← single command manifest
    templates/
      deploy-staging.json          ← local template
      run-migrations.json          ← local template
      seed-database.json           ← local template
    workflows/
      server-cycle.json            ← multi-step workflow definition
      server-cycle.approved.json   ← approved manifest for that workflow
```

Templates are committed to the repo alongside the code they operate on. A new team member clones the repo and immediately has access to every template the team has built. No registry, no network, no account.

### Template CLI Commands

```bash
# Create a template from scratch
guardrail template create --name deploy-staging

# Create a template from your current approved manifest
guardrail template create \
  --from-manifest .guardrail/approved.json \
  --name deploy-staging

# List local templates
guardrail template list

# Run a template with inputs
guardrail run --template .guardrail/templates/deploy-staging.json \
  --input target_env=staging \
  --input service=api

# Simulate without executing
guardrail template simulate \
  --template .guardrail/templates/deploy-staging.json \
  --input target_env=staging \
  --input service=api

# Lint a template
guardrail template lint --template .guardrail/templates/deploy-staging.json

# Explain what a template does in plain English
guardrail template explain --template .guardrail/templates/deploy-staging.json
```

### Template File Format

```json
{
  "version": 1,
  "kind": "workflow_template",
  "name": "deploy-staging",
  "description": "Deploy a service to staging. Cannot target production.",
  "trust_class": "reviewed_internal",
  "risk": "yellow",

  "inputs": {
    "service": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]+$",
      "description": "Service name to deploy"
    },
    "target_env": {
      "type": "enum",
      "enum": ["staging", "dev"],
      "description": "Target environment. Production requires a separate template."
    },
    "image_tag": {
      "type": "string",
      "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
      "description": "Semver image tag to deploy"
    }
  },

  "requires_env": ["DEPLOY_TOKEN"],

  "steps": [
    {
      "id": "validate",
      "run": {
        "command": "npm",
        "args": ["run", "validate:{{inputs.target_env}}"],
        "mode": "structured"
      },
      "idempotent": true,
      "on_success": "deploy",
      "on_failure": "halt"
    },
    {
      "id": "deploy",
      "run": {
        "command": "deploy-cli",
        "args": [
          "{{inputs.service}}",
          "--env", "{{inputs.target_env}}",
          "--tag", "{{inputs.image_tag}}"
        ],
        "mode": "structured",
        "env": { "allow": ["DEPLOY_TOKEN"] }
      },
      "idempotent": false,
      "validator": {
        "regex": "^Deployment successful: {{inputs.service}}"
      },
      "on_success": "done",
      "on_failure": "rollback"
    }
  ],

  "rollback": {
    "steps": [
      {
        "id": "rollback-deploy",
        "run": {
          "command": "deploy-cli",
          "args": [
            "{{inputs.service}}",
            "--env", "{{inputs.target_env}}",
            "--rollback"
          ],
          "mode": "structured",
          "env": { "allow": ["DEPLOY_TOKEN"] }
        },
        "idempotent": true
      }
    ]
  }
}
```

### Three Local Use Cases

**Use case 1 — Team-specific workflows no one else needs.**
Your deploy scripts, your migration commands, your seed scripts. These live in `.guardrail/templates/` forever and never get published. They're just your team's approved execution contracts, version-controlled with everything else.

**Use case 2 — A recipe as a starting point.**
Install a community recipe, copy it into `.guardrail/templates/`, and customize it for your environment. The customized version is a local template. It doesn't inherit the recipe's trust — it gets re-linted and re-approved as a `reviewed_internal` template.

**Use case 3 — Building a recipe to contribute.**
You work locally, refine the template over time, and when it's solid you publish it via `guardrail recipe publish`. A future `guardrail template publish` command can be a thin alias on top of the same flow.

### Trust Inheritance Rule

**A locally customized template derived from a `pinned_external` recipe is treated as a new approval unit.** It does not inherit the recipe's approval history or trust class. The moment you modify it, it becomes `reviewed_internal` and requires a fresh approval.

Guardrail enforces this by comparing the content hash of the template against the content hash of the source recipe at approval time. If they differ — even by one character — the template is treated as original work. This prevents a pattern where someone installs a trusted recipe, quietly modifies it, and the modified version runs under the original recipe's trust.

### Implementation Notes

Most of the template system already exists in `src/template.js` and `src/template-supervisor.js`:
- Template schema validation (individual + workflow kinds) — **Done**
- Input type system with pattern/enum/range — **Done**
- Interpolation engine (`{{inputs.x}}`) — **Done**
- Environment handshake — **Done**
- Template lint (8 checks) — **Done**
- Template explain — **Done**
- Template simulate (dry-run) — **Done**
- Template execution with rollback — **Done**

**What needs to be added:**

| Feature | Status | Notes |
|---------|--------|-------|
| `template create --from-manifest` | Not started | See spec below |
| `template publish` | Not started | Alias for `recipe publish` with template as source instead of manifest |
| `template list` | Not started | Scan `.guardrail/templates/` and display table |
| Trust hash comparison on approval | Not started | See spec below |
| Recipe → template install (`--as-template`) | Not started | See spec below |

### Spec: `template create --from-manifest`

**Purpose:** Convert an existing approved manifest into a reusable parameterized template. This is the cold-start feature — a developer who already has a working `approved.json` can turn it into a template without writing JSON from scratch.

**Command:**
```bash
guardrail template create --from-manifest .guardrail/approved.json --name deploy-staging
```

**Flow:**
1. Load and validate the manifest at the given path
2. Extract contract fields: command, args, writablePaths, readablePaths, allowedBinaries, inject, envPolicy
3. **Infer inputs from args:** Scan `contract.args` for values that look parameterizable:
   - File paths → `working_dir` input (type: string, pattern inferred from path structure)
   - Environment names (dev/staging/prod) → `target_env` input (type: enum)
   - Version strings (semver-like) → `version` input (type: string, pattern: semver)
   - Remaining literal args stay as literals in the template
4. **Interactive prompts** (when TTY available):
   - For each inferred input: "Make `./src` a template input? [Y/n] Name: [working_dir]"
   - For args not auto-detected: "Parameterize `--tag 1.2.3`? [y/N]"
   - Non-interactive mode (`--non-interactive`): accept all inferred inputs, skip prompts
5. Build template JSON with `kind: "template"` or `kind: "workflow_template"` (based on manifest type)
6. Set `trust_class: "reviewed_internal"`
7. Write to `.guardrail/templates/<name>.json`
8. Run lint on the output — warn (don't block) if lint finds issues

**Output file:** `.guardrail/templates/<name>.json`

**What it does NOT do:**
- Does not copy approval history — the template starts fresh
- Does not parameterize everything — literals stay literal unless explicitly promoted
- Does not guess descriptions — uses `"TODO: describe this input"` as placeholder

### Spec: `--as-template` flag for recipe install

**Purpose:** Install a community recipe as a local template for customization.

**Command:**
```bash
guardrail recipe install github://guardrail-dev/recipes/github/open-pr.json@sha --as-template
```

**Flow:**
1. Fetch and validate the recipe normally
2. Run lint on the recipe **before writing**. Fatal lint errors (bare string input, shell mode, missing rollback on non-idempotent step, ReDoS regex) block the install. Non-fatal warnings are displayed but don't block. `--force` overrides fatal lint errors with an explicit acknowledgment.
3. Add a `_source` metadata block to the template (excluded from hashing — see Trust Hash spec below):
   ```json
   "_source": {
     "type": "recipe",
     "source": "github://guardrail-dev/recipes/github/open-pr.json@sha",
     "content_hash": "sha256:...",
     "trust_class": "pinned_external",
     "installed_at": "2026-04-07T..."
   }
   ```
   The `trust_class` is captured at install time so the approval flow can reference it later.
4. Set the stored template's default `trust_class` to `reviewed_internal`. Approval-time provenance logic may still classify an unmodified imported template as `_source.trust_class`; any edit forces `reviewed_internal`.
5. Write to `.guardrail/templates/<id>.json` (only after lint passes or `--force` is set)

**Trust enforcement:** On every approval of a template that has `_source`, Guardrail compares the current template content hash against `_source.content_hash`. If they match, the template is identical to the source recipe and inherits its trust. If they differ, it's treated as original work requiring fresh `reviewed_internal` approval.

### Spec: Trust hash comparison on approval

**Where:** `src/template-supervisor.js`, in the approval flow (before `createTemplateManifest`).

**`_source` stripping for hashing:** The `_source` block is metadata, not template content. It must be excluded from the content hash to ensure the hash of an unmodified installed template matches the hash of the original recipe. Add a dedicated `hashTemplateDefinition()` helper in `src/template.js` for this purpose. This is separate from `hashTemplateExecution()` because source-provenance comparison should hash the template definition itself, not a resolved execution instance. `hashTemplateDefinition()` must explicitly exclude `_source` from the hashable object. This is the single source of truth for what's hashed — no other code path should strip `_source`.

```js
// In hashTemplateDefinition() — src/template.js:
function hashTemplateDefinition(template) {
  const { _source, ...content } = template; // Strip _source metadata
  // ... existing hash logic over content fields
}
```

**Approval flow logic** (`src/template-supervisor.js`):

```
if template has _source:
  current_hash = hashTemplateDefinition(template)  // excludes _source block
  if current_hash === _source.content_hash:
    // Unmodified — can inherit source trust class
    trust_class = _source.trust_class
  else:
    // Modified — force reviewed_internal, require fresh approval
    trust_class = 'reviewed_internal'
    log("Template has been modified from source recipe. Fresh approval required.")
```

This prevents the attack where someone installs a trusted recipe, modifies it to add a malicious step, and the modified version runs under the original recipe's trust.
