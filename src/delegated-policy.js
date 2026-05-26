import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { serializeStable } from './contract.js';
import {
  evaluateHttp,
  evaluateRecipe,
  evaluateRecipeDiscovery,
  evaluateService,
  evaluateTemplate,
  evaluateTemplateDiscovery,
  evaluateTemplateParent,
  serviceDefinitionsFromGrant,
} from './delegated-tool-evaluators.js';
import { listGuardrailMcpTools } from './mcp-tools.js';

export { serviceDefinitionsFromGrant };

const TEMPLATE_ACTIONS = ['describe', 'prepare', 'request_approval', 'run'];
const TEMPLATE_ACTION_LEGACY_TOOLS = {
  describe: 'guardrail_template_describe',
  prepare: 'guardrail_template_prepare',
  request_approval: 'guardrail_template_request_approval',
  run: 'guardrail_run_template',
};

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

function isPathTextWithin(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function findGitRoot(startPath) {
  let current = realpathExisting(startPath);
  if (!current) return null;
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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

function summarizeRecipeConfig(config, requireHash = false) {
  const recipes = config.recipes;
  if (recipes === true) return { recipes: 'all' };
  let delegatedRecipes = [];
  if (Array.isArray(recipes)) {
    delegatedRecipes = recipes.map((name) => ({ name: String(name), constraints: {} }));
  } else if (isObject(recipes)) {
    delegatedRecipes = Object.entries(recipes).map(([name, recipeConfig]) => {
      const details = recipeConfig === true ? {} : recipeConfig;
      return {
        name,
        recipeHash: details?.recipe_hash ?? details?.recipeHash ?? null,
        hashRequired: requireHash,
        approvalModes: requireHash ? ['recipe_hash', 'host_elicitation', 'approval_request_id'] : ['inspect', 'approval_request'],
        allowUnverified: details?.allow_unverified === true || details?.allowUnverified === true || config.allow_unverified === true || config.allowUnverified === true,
        inputs: details?.inputs ?? details?.input_constraints ?? {},
      };
    });
  }
  return { recipes: delegatedRecipes };
}

function summarizeTemplateConfig(config, requireHash = false) {
  const templates = config.templates;
  if (templates === true) return { templates: 'all' };
  let delegatedTemplates = [];
  if (Array.isArray(templates)) {
    delegatedTemplates = templates.map((name) => ({ name: String(name), constraints: {} }));
  } else if (isObject(templates)) {
    delegatedTemplates = Object.entries(templates).map(([name, templateConfig]) => {
      const details = templateConfig === true ? {} : templateConfig;
      return {
        name,
        templateHash: details?.template_hash ?? details?.templateHash ?? null,
        hashRequired: requireHash,
        approvalModes: requireHash ? ['template_hash', 'host_elicitation', 'approval_request_id'] : ['inspect', 'approval_request'],
        inputs: details?.inputs ?? details?.input_constraints ?? {},
        envAllow: toArray(details?.env_allow ?? details?.envAllow),
      };
    });
  }
  return { templates: delegatedTemplates };
}

function getTemplateActionConfig(config, action) {
  if (!isObject(config)) return {};
  if (isObject(config.actions)) {
    if (!(action in config.actions)) return null;
    const actionConfig = config.actions[action];
    return actionConfig === true ? {} : actionConfig;
  }
  if (isObject(config[action])) return config[action];
  return config;
}

function summarizeTemplateParentConfig(config) {
  const actions = {};
  for (const action of TEMPLATE_ACTIONS) {
    const actionConfig = getTemplateActionConfig(config, action);
    actions[action] = actionConfig === null
      ? { delegated: false, legacyAlias: TEMPLATE_ACTION_LEGACY_TOOLS[action] }
      : {
          delegated: true,
          legacyAlias: TEMPLATE_ACTION_LEGACY_TOOLS[action],
          policy: summarizeTemplateConfig(actionConfig, action === 'run'),
        };
  }
  return { actions };
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
    return {
      delegated: true,
      policy: summarizeRecipeConfig(config, true),
      usage: 'Use only delegated recipe names and inputs shown here. Pinned recipe hashes run under the grant; unpinned runs require MCP host form elicitation approval or an approved CLI approval_request_id. Ordinary tool arguments cannot approve execution.',
    };
  }

  if (toolName === 'guardrail_recipe_describe' || toolName === 'guardrail_recipe_prepare' || toolName === 'guardrail_recipe_request_approval') {
    return {
      delegated: true,
      policy: summarizeRecipeConfig(config, false),
      usage: 'Use this recipe tool to inspect recipe inputs, hashes, dry-run output, and approval options before execution. Prefer the run tool host prompt when the MCP host supports elicitation; use request_approval only for the CLI fallback.',
    };
  }

  if (toolName === 'guardrail_run_template') {
    return {
      delegated: true,
      policy: summarizeTemplateConfig(config, true),
      usage: 'Use only delegated template names and inputs shown here. Pinned template hashes run under the grant; unpinned runs require MCP host form elicitation approval or an approved CLI approval_request_id. Ordinary tool arguments cannot approve execution.',
    };
  }

  if (toolName === 'guardrail_template') {
    return {
      delegated: true,
      policy: summarizeTemplateParentConfig(config),
      usage: 'Preferred omnitool-style template surface for agents. Set action to describe, prepare, request_approval, or run. This is the parent entry point over the existing template supervisor, not a separate template runtime. Each action uses the same template allowlists, input constraints, env_allow constraints, hash checks, and approval semantics as its legacy compatibility tool.',
    };
  }

  if (toolName === 'guardrail_template_describe' || toolName === 'guardrail_template_prepare' || toolName === 'guardrail_template_request_approval') {
    return {
      delegated: true,
      policy: summarizeTemplateConfig(config, false),
      usage: 'Use this template tool to inspect template inputs, env needs, hashes, simulation output, and approval options before execution. Prefer the run tool host prompt when the MCP host supports elicitation; use request_approval only for the CLI fallback.',
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

function mcpToolInventory(grant) {
  const exposedTools = listGuardrailMcpTools().map((tool) => tool.name);
  const exposedSet = new Set(exposedTools);
  const grantDeclaredTools = isObject(grant?.tools) ? Object.keys(grant.tools) : toArray(grant?.tools);
  const grantDeclaredSet = new Set(grantDeclaredTools);
  const callableTools = grantDeclaredTools.filter((toolName) => exposedSet.has(toolName));
  const grantOnlyTools = grantDeclaredTools.filter((toolName) => !exposedSet.has(toolName));
  const exposedButNotGrantedTools = exposedTools.filter((toolName) => !grantDeclaredSet.has(toolName));
  return {
    exposedTools,
    grantDeclaredTools,
    callableTools,
    grantOnlyTools,
    exposedButNotGrantedTools,
    warning: grantOnlyTools.length > 0
      ? 'Some tools are declared by the grant but are not exposed by this MCP server. They are not callable; use tools/list or callableTools as the actionable inventory.'
      : null,
  };
}

function describeToolCapabilities(grant, callableToolNames = null) {
  const callableSet = callableToolNames ? new Set(callableToolNames) : null;
  const tools = grant?.tools;
  if (Array.isArray(tools)) {
    return Object.fromEntries(tools
      .filter((toolName) => !callableSet || callableSet.has(toolName))
      .map((toolName) => [toolName, { delegated: true, policy: 'No additional grant-level constraints.' }]));
  }
  if (!isObject(tools)) return {};
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([toolName]) => !callableSet || callableSet.has(toolName))
      .map(([toolName, config]) => [toolName, summarizeToolConfig(toolName, config, grant)]),
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

function validateGrantLocation(resolvedPath, grant, options = {}) {
  const cwdRoot = resolve(options.cwd || process.cwd());
  const delegatedRoot = resolveFrom(cwdRoot, grant.repo_path ?? grant.repoPath ?? '.');
  if (!realpathExisting(delegatedRoot)) {
    return [`Delegated repo_path does not exist or cannot be resolved: ${delegatedRoot}`];
  }
  const protectedRoots = [
    { label: 'delegated repo_path', path: delegatedRoot },
    { label: 'MCP server working directory', path: cwdRoot },
  ];
  const gitRoot = findGitRoot(delegatedRoot) ?? findGitRoot(cwdRoot);
  if (gitRoot) protectedRoots.push({ label: 'Git worktree root', path: gitRoot });

  for (const root of protectedRoots) {
    if (isPathTextWithin(resolvedPath, root.path) || isPathWithin(resolvedPath, root.path)) {
      return [
        `Delegated MCP grant file must be outside the ${root.label}.`,
        'Store MCP grants in an operator-controlled location such as ~/.guardrail/mcp-grants/<agent>.json, not in a directory an agent can edit.',
      ];
    }
  }
  return [];
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
  const locationErrors = validateGrantLocation(resolvedPath, grant, options);
  if (locationErrors.length > 0) return { ok: false, grant, hash: null, path: resolvedPath, errors: locationErrors };
  return { ok: true, grant, hash: grantHash(grant), path: resolvedPath, errors: [] };
}

export function describeDelegatedGrant(grantState, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const grant = grantState?.grant;
  const expired = !!grant?.expires_at && Date.parse(grant.expires_at) <= now.getTime();
  const inventory = mcpToolInventory(grant);
  return {
    ok: !!grantState?.ok && !expired,
    hash: grantState?.hash ?? null,
    path: grantState?.path ?? null,
    agent: grant?.agent ?? null,
    repoPath: grant?.repo_path ?? grant?.repoPath ?? '.',
    expiresAt: grant?.expires_at ?? null,
    expired,
    tools: inventory.callableTools,
    grantDeclaredTools: inventory.grantDeclaredTools,
    toolInventory: inventory,
    capabilities: describeToolCapabilities(grant, inventory.callableTools),
    help: {
      discovery: 'Call guardrail_grant_status before autonomous work to inspect delegated tools, policies, limits, and examples instead of guessing. Use `tools` or `toolInventory.callableTools` as the actionable inventory.',
      moreInfo: 'Tool schemas are available from MCP tools/list. For templates, prefer the omnitool-style parent guardrail_template tool with action=describe, prepare, request_approval, or run; legacy template tools are aliases. If guardrail_template appears under toolInventory.exposedButNotGrantedTools, the server exposes it but the active grant cannot use it yet. Use recipe/template describe and prepare actions to gather hashes, required inputs, env/auth setup, and grant snippets before execution. Unpinned run actions require MCP host form elicitation approval or an approved CLI approval_request_id.',
      failClosed: 'If the needed action is not listed here, or if host elicitation is unavailable, declined, cancelled, or malformed, execution fails closed before the supervisor runs. Ask the operator to update the grant or use the CLI approval fallback when appropriate.',
      staleGrantEntries: inventory.warning ?? 'No grant-declared tools are missing from the MCP tools/list inventory.',
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
  if (toolName === 'guardrail_recipe_describe' || toolName === 'guardrail_recipe_prepare' || toolName === 'guardrail_recipe_request_approval') return combine(common, evaluateRecipeDiscovery(config, args));
  if (toolName === 'guardrail_run_recipe') return combine(common, evaluateRecipe(config, args));
  if (toolName === 'guardrail_template') return combine(common, evaluateTemplateParent(config, args));
  if (toolName === 'guardrail_template_describe' || toolName === 'guardrail_template_prepare' || toolName === 'guardrail_template_request_approval') return combine(common, evaluateTemplateDiscovery(config, args));
  if (toolName === 'guardrail_run_template') return combine(common, evaluateTemplate(config, args));
  if (toolName === 'guardrail_http_request') return combine(common, evaluateHttp(config, args));
  if (toolName.startsWith('guardrail_service_')) return combine(common, evaluateService(config, grant, args));
  return common;
}
