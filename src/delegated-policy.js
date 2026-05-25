import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { serializeStable } from './contract.js';
import {
  evaluateGitCommit,
  evaluateGitDiff,
  evaluateGitPush,
  evaluateHttp,
  evaluateRecipe,
  evaluateService,
  serviceDefinitionsFromGrant,
} from './delegated-tool-evaluators.js';

export { serviceDefinitionsFromGrant };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function grantHash(grant) {
  return createHash('sha256').update(serializeStable(grant)).digest('hex');
}

function decision(allowed, reason, details = {}) {
  return { allowed, reason, ...details };
}

function realpathExisting(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function isPathWithin(child, parent) {
  const realChild = realpathExisting(child);
  const realParent = realpathExisting(parent);
  if (!realChild || !realParent) return false;
  const rel = relative(realParent, realChild);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveFrom(baseDir, value = '.') {
  return resolve(baseDir, String(value || '.'));
}

function getToolConfig(grant, toolName) {
  const tools = grant?.tools;
  if (Array.isArray(tools)) return tools.includes(toolName) ? {} : null;
  if (!isObject(tools)) return null;
  const config = tools[toolName];
  if (config === true) return {};
  if (isObject(config)) return config;
  return null;
}

function validateGrantShape(grant) {
  const errors = [];
  if (!isObject(grant)) return ['Grant must be a JSON object.'];
  if (grant.version !== 1) errors.push('Grant version must be 1.');
  if (!isObject(grant.tools) && !Array.isArray(grant.tools)) {
    errors.push('Grant must declare a tools object or array.');
  }
  if (grant.expires_at !== undefined && Number.isNaN(Date.parse(grant.expires_at))) {
    errors.push('expires_at must be a valid ISO timestamp.');
  }
  return errors;
}

export function loadDelegatedGrant(grantPath, options = {}) {
  if (!grantPath) {
    return { ok: false, grant: null, hash: null, path: null, errors: ['--grant is required for Guardrail MCP tool execution.'] };
  }
  const resolvedPath = resolve(options.cwd || process.cwd(), grantPath);
  if (!existsSync(resolvedPath)) {
    return { ok: false, grant: null, hash: null, path: resolvedPath, errors: [`Grant file not found: ${resolvedPath}`] };
  }
  let grant;
  try {
    grant = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    return { ok: false, grant: null, hash: null, path: resolvedPath, errors: [`Grant file is not valid JSON: ${err.message}`] };
  }
  const errors = validateGrantShape(grant);
  if (errors.length > 0) return { ok: false, grant, hash: null, path: resolvedPath, errors };
  return { ok: true, grant, hash: grantHash(grant), path: resolvedPath, errors: [] };
}

export function describeDelegatedGrant(grantState, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const grant = grantState?.grant;
  const expired = !!grant?.expires_at && Date.parse(grant.expires_at) <= now.getTime();
  const tools = isObject(grant?.tools) ? Object.keys(grant.tools) : toArray(grant?.tools);
  return {
    ok: !!grantState?.ok && !expired,
    hash: grantState?.hash ?? null,
    path: grantState?.path ?? null,
    agent: grant?.agent ?? null,
    repoPath: grant?.repo_path ?? grant?.repoPath ?? '.',
    expiresAt: grant?.expires_at ?? null,
    expired,
    tools,
    errors: grantState?.errors ?? [],
  };
}

function evaluateCommon(context, toolName, args) {
  const grantState = context.grantState;
  const grant = grantState?.grant;
  if (!grantState?.ok || !grant) {
    return decision(false, (grantState?.errors || ['Delegated grant is unavailable.']).join(' '));
  }
  const now = context.now ? new Date(context.now) : new Date();
  if (grant.expires_at && Date.parse(grant.expires_at) <= now.getTime()) {
    return decision(false, 'Delegated grant has expired.');
  }
  if (grant.agent && context.agent && grant.agent !== context.agent) {
    return decision(false, `Delegated grant is for agent "${grant.agent}", not "${context.agent}".`);
  }
  const config = getToolConfig(grant, toolName);
  if (!config) return decision(false, `Tool "${toolName}" is not delegated by the grant.`);
  if (config.enabled === false) return decision(false, `Tool "${toolName}" is disabled by the grant.`);

  const root = resolveFrom(context.cwd || process.cwd(), grant.repo_path ?? grant.repoPath ?? '.');
  const repoPath = resolveFrom(context.cwd || process.cwd(), args?.repo_path ?? args?.repoPath ?? '.');
  if (!isPathWithin(repoPath, root)) {
    return decision(false, `Repository path "${repoPath}" is outside delegated root "${root}".`);
  }
  const repoPaths = toArray(config.repo_paths ?? config.repoPaths);
  if (repoPaths.length > 0) {
    const allowed = repoPaths.some((entry) => isPathWithin(repoPath, resolveFrom(root, entry)));
    if (!allowed) return decision(false, `Repository path "${repoPath}" is not in the tool repo_paths allowlist.`);
  }
  return decision(true, 'allowed', {
    config,
    root: realpathExisting(root),
    repoPath: realpathExisting(repoPath),
  });
}

function combine(common, specific) {
  return specific.allowed ? { ...common, ...specific, reason: 'allowed' } : specific;
}

export function evaluateDelegatedTool(context, toolName, args = {}) {
  if (toolName === 'guardrail_grant_status') return decision(true, 'allowed');
  const common = evaluateCommon(context, toolName, args);
  if (!common.allowed) return common;
  const config = common.config;
  const grant = context.grantState.grant;
  if (toolName === 'guardrail_run_recipe') return combine(common, evaluateRecipe(config, args));
  if (toolName === 'guardrail_http_request') return combine(common, evaluateHttp(config, args));
  if (toolName === 'guardrail_git_diff') return combine(common, evaluateGitDiff(config, args));
  if (toolName.startsWith('guardrail_service_')) return combine(common, evaluateService(config, grant, args));
  if (toolName === 'guardrail_git_commit') return combine(common, evaluateGitCommit(config, args));
  if (toolName === 'guardrail_git_push_feature_branch') return combine(common, evaluateGitPush(config, args));
  return common;
}
