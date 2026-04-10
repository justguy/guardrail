import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = resolve(MODULE_DIR, '..');
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json');

const WRAPPER_FILE_MAP = {
  claude: 'claude-exec-wrapper.js',
  codex: 'codex-exec-wrapper.js',
  git_commit: 'git-commit-wrapper.js',
  git_commit_plan: 'git-commit-plan-wrapper.js',
  cmux_claude: 'cmux-claude-recipe-wrapper.js',
};

let packageVersionCache;

function readPackageVersion() {
  if (packageVersionCache !== undefined) {
    return packageVersionCache;
  }

  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  packageVersionCache = parsed?.version || 'unknown';
  return packageVersionCache;
}

function coerceRepoBase(resolvedInputs) {
  const override = resolvedInputs?.guardrail_repo;
  if (!override) return null;
  if (typeof override !== 'string') return null;
  if (!override.trim()) return null;
  return resolve(process.cwd(), override);
}

export function resolveBundledWrapperPath(wrapperName, resolvedInputs = {}) {
  const fileName = WRAPPER_FILE_MAP[wrapperName];
  if (!fileName) {
    throw new Error(`Unknown bundled wrapper alias: ${wrapperName}`);
  }

  const overrideRoot = coerceRepoBase(resolvedInputs);
  const baseDir = overrideRoot || PACKAGE_ROOT;
  const wrapperPath = resolve(baseDir, 'src', fileName);

  if (!existsSync(wrapperPath)) {
    throw new Error(`Bundled wrapper missing at ${wrapperPath}`);
  }

  return {
    wrapperPath: realpathSync(wrapperPath),
    sourceRoot: realpathSync(baseDir),
    source: overrideRoot ? 'runtime_override' : 'bundled_local',
  };
}

export function resolveBundledWrapperProvenance(wrapperName, resolvedInputs = {}) {
  const details = resolveBundledWrapperPath(wrapperName, resolvedInputs);
  const wrapperContent = readFileSync(details.wrapperPath);
  const sha256 = createHash('sha256').update(wrapperContent).digest('hex');

  return {
    wrapper: wrapperName,
    wrapperPath: details.wrapperPath,
    realPath: details.wrapperPath,
    sourceRoot: details.sourceRoot,
    source: details.source,
    packageVersion: readPackageVersion(),
    sha256,
  };
}

export function extractBundledWrapperRefs(argValues = []) {
  const refs = new Set();
  const pattern = /\{\{bundled_wrapper\.([a-zA-Z0-9_][a-zA-Z0-9_-]*)\}\}/g;
  for (const value of argValues) {
    if (typeof value !== 'string') continue;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      refs.add(match[1]);
    }
  }
  return [...refs];
}
