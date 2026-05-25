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

function correction(expected, details = {}) {
  return {
    correction: {
      expected,
      ...details,
    },
  };
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

function summarizeToolConfig(toolName, config, grant) {
  if (config === true) {
    return { delegated: true, policy: 'No additional grant-level constraints.' };
  }
  if (!isObject(config)) return { delegated: true };

  if (toolName === 'guardrail_http_request') {
    return {
      delegated: true,
      policy: {
        hosts: toArray(config.hosts),
        ports: toArray(config.ports).map((entry) => Number.parseInt(entry, 10)).filter(Number.isFinite),
        methods: toArray(config.methods).map((entry) => String(entry).toUpperCase()),
        allowedHeaders: toArray(config.allowed_headers ?? config.allowedHeaders).map((entry) => String(entry).toLowerCase()),
        allowRemoteHosts: config.allow_remote_hosts === true || config.allowRemoteHosts === true,
        maxBodyBytes: Number.parseInt(config.max_body_bytes ?? config.maxBodyBytes ?? 64 * 1024, 10),
        maxTimeoutMs: Number.parseInt(config.max_timeout_ms ?? config.maxTimeoutMs ?? 5000, 10),
      },
      usage: 'Use guardrail_http_request instead of raw curl for bounded local API probes. Start with loopback URLs unless allowRemoteHosts is true.',
    };
  }

  if (toolName === 'guardrail_run_recipe') {
    const recipes = config.recipes;
    let delegatedRecipes = [];
    if (Array.isArray(recipes)) {
      delegatedRecipes = recipes.map((name) => ({ name: String(name), constraints: {} }));
    } else if (isObject(recipes)) {
      delegatedRecipes = Object.entries(recipes).map(([name, recipeConfig]) => {
        const details = recipeConfig === true ? {} : recipeConfig;
        return {
          name,
          recipeHash: details?.recipe_hash ?? details?.recipeHash ?? null,
          allowUnverified: details?.allow_unverified === true || details?.allowUnverified === true || config.allow_unverified === true || config.allowUnverified === true,
          inputs: details?.inputs ?? details?.input_constraints ?? {},
        };
      });
    }
    return {
      delegated: true,
      policy: { recipes: delegatedRecipes },
      usage: 'Use only delegated recipe names and inputs shown here. Recipe hashes are included so drift can fail closed.',
    };
  }

  if (toolName === 'guardrail_git_diff') {
    return {
      delegated: true,
      policy: {
        allowedPaths: toArray(config.allowed_paths ?? config.allowedPaths),
        maxBytes: Number.parseInt(config.max_bytes ?? config.maxBytes ?? 64 * 1024, 10),
      },
      usage: 'Use guardrail_git_diff for bounded read-only diff inspection. Keep paths repo-relative.',
    };
  }

  if (toolName === 'guardrail_git_commit') {
    return {
      delegated: true,
      policy: {
        recipeHash: config.recipe_hash ?? config.recipeHash ?? null,
        allowedPaths: toArray(config.allowed_paths ?? config.allowedPaths),
        allowUnverified: config.allow_unverified === true || config.allowUnverified === true,
      },
      usage: 'Use guardrail_git_commit for approved commits. Provide repo-relative paths and a repo-relative message_file.',
    };
  }

  if (toolName === 'guardrail_git_push_feature_branch') {
    return {
      delegated: true,
      policy: {
        recipeHash: config.recipe_hash ?? config.recipeHash ?? null,
        remote: config.remote ?? 'origin',
        branchPattern: config.branch_pattern ?? config.branchPattern ?? '^(feature|bugfix|chore|docs|refactor|test|ci)/[A-Za-z0-9._/-]{1,96}$',
        allowUnverified: config.allow_unverified === true || config.allowUnverified === true,
      },
      usage: 'Use guardrail_git_push_feature_branch only for delegated topic branches, never protected branches.',
    };
  }

  if (toolName.startsWith('guardrail_service_')) {
    const serviceList = toArray(config.services);
    const declaredServices = isObject(grant?.services) ? Object.keys(grant.services) : [];
    return {
      delegated: true,
      policy: {
        delegatedServices: serviceList,
        declaredServices,
      },
      usage: 'Use service tools only for service IDs listed here. If no service is listed, ask for the grant to declare one.',
    };
  }

  return {
    delegated: true,
    policy: {
      repoPaths: toArray(config.repo_paths ?? config.repoPaths),
    },
  };
}

function describeToolCapabilities(grant) {
  const tools = grant?.tools;
  if (Array.isArray(tools)) {
    return Object.fromEntries(tools.map((toolName) => [toolName, { delegated: true, policy: 'No additional grant-level constraints.' }]));
  }
  if (!isObject(tools)) return {};
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, config]) => [toolName, summarizeToolConfig(toolName, config, grant)]),
  );
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
    capabilities: describeToolCapabilities(grant),
    help: {
      discovery: 'Call guardrail_grant_status before autonomous work to inspect delegated tools, policies, limits, and examples. Use this status instead of guessing what is allowed.',
      moreInfo: 'Tool schemas are available from MCP tools/list. This status response summarizes the active grant. Denied tool calls include correction.expected with the next valid action.',
      failClosed: 'If the needed action is not listed here, stop and ask the operator to update the grant or provide a bounded Guardrail recipe.',
    },
    errors: grantState?.errors ?? [],
  };
}

function evaluateCommon(context, toolName, args) {
  const grantState = context.grantState;
  const grant = grantState?.grant;
  if (!grantState?.ok || !grant) {
    return decision(false, (grantState?.errors || ['Delegated grant is unavailable.']).join(' '), correction('Call guardrail_grant_status to inspect grant errors, then fix or provide a valid delegated grant.'));
  }
  const now = context.now ? new Date(context.now) : new Date();
  if (grant.expires_at && Date.parse(grant.expires_at) <= now.getTime()) {
    return decision(false, 'Delegated grant has expired.', correction('Refresh or replace the delegated grant before using Guardrail MCP tools.'));
  }
  if (grant.agent && context.agent && grant.agent !== context.agent) {
    return decision(false, `Delegated grant is for agent "${grant.agent}", not "${context.agent}".`, correction(`Use an MCP server configured for agent "${grant.agent}", or issue a grant for agent "${context.agent}".`));
  }
  const config = getToolConfig(grant, toolName);
  if (!config) {
    return decision(false, `Tool "${toolName}" is not delegated by the grant.`, correction('Call guardrail_grant_status and use one of the delegated tools, or update the grant.'));
  }
  if (config.enabled === false) {
    return decision(false, `Tool "${toolName}" is disabled by the grant.`, correction('Use an enabled delegated tool, or update the grant to enable this tool.'));
  }

  const root = resolveFrom(context.cwd || process.cwd(), grant.repo_path ?? grant.repoPath ?? '.');
  const repoPath = resolveFrom(context.cwd || process.cwd(), args?.repo_path ?? args?.repoPath ?? '.');
  if (!isPathWithin(repoPath, root)) {
    return decision(false, `Repository path "${repoPath}" is outside delegated root "${root}".`, correction('Use a repo_path inside the delegated root shown by guardrail_grant_status, usually `.` for the current repository.', { delegatedRoot: root }));
  }
  const repoPaths = toArray(config.repo_paths ?? config.repoPaths);
  if (repoPaths.length > 0) {
    const allowed = repoPaths.some((entry) => isPathWithin(repoPath, resolveFrom(root, entry)));
    if (!allowed) {
      return decision(false, `Repository path "${repoPath}" is not in the tool repo_paths allowlist.`, correction('Use one of the repo_paths listed for this tool by guardrail_grant_status.', { allowed: repoPaths }));
    }
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
