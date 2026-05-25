import { isAbsolute } from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;
const DEFAULT_MAX_HTTP_TIMEOUT_MS = 5000;

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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesValue(value, rule) {
  if (rule === true) return true;
  if (typeof rule === 'string' || typeof rule === 'number' || typeof rule === 'boolean') {
    return String(value) === String(rule);
  }
  if (Array.isArray(rule)) {
    return rule.some((entry) => String(entry) === String(value));
  }
  if (!isObject(rule)) return false;
  if ('exact' in rule && String(value) !== String(rule.exact)) return false;
  if (Array.isArray(rule.enum) && !rule.enum.some((entry) => String(entry) === String(value))) return false;
  if (typeof rule.pattern === 'string' && !new RegExp(rule.pattern).test(String(value))) return false;
  if (typeof rule.prefix === 'string' && !String(value).startsWith(rule.prefix)) return false;
  if (typeof rule.max_length === 'number' && String(value).length > rule.max_length) return false;
  return true;
}

function pathIsRelativeSafe(path) {
  return typeof path === 'string'
    && path.length > 0
    && !isAbsolute(path)
    && !path.split('/').includes('..');
}

function validateAllowedPaths(paths, allowedPaths, label) {
  for (const path of paths) {
    if (!pathIsRelativeSafe(path)) {
      return decision(false, `Path "${path}" is not a safe repo-relative path.`, correction('Use only non-empty repo-relative paths without `..` segments.'));
    }
  }
  if (allowedPaths.length === 0) return decision(true, 'allowed');
  for (const path of paths) {
    const allowed = allowedPaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
    if (!allowed) {
      return decision(false, `Path "${path}" is outside delegated ${label} paths.`, correction(`Use paths under delegated ${label} paths listed by guardrail_grant_status.`, { allowed: allowedPaths }));
    }
  }
  return decision(true, 'allowed');
}

function configAllowsUnverified(config) {
  return config?.allow_unverified === true || config?.allowUnverified === true;
}

export function evaluateRecipe(config, args) {
  const recipe = args.recipe ?? args.recipe_id ?? args.recipeId;
  if (typeof recipe !== 'string' || !recipe) {
    return decision(false, 'recipe is required.', correction('Provide the recipe name in the `recipe` argument.'));
  }
  const recipes = config.recipes;
  let recipeConfig = null;
  if (Array.isArray(recipes)) {
    if (!recipes.includes(recipe)) {
      return decision(false, `Recipe "${recipe}" is not delegated.`, correction('Use one of the recipes listed by guardrail_grant_status, or update the delegated grant.'));
    }
    recipeConfig = {};
  } else if (isObject(recipes)) {
    if (!(recipe in recipes)) {
      return decision(false, `Recipe "${recipe}" is not delegated.`, correction('Use one of the recipes listed by guardrail_grant_status, or update the delegated grant.'));
    }
    recipeConfig = recipes[recipe] === true ? {} : recipes[recipe];
  } else {
    return decision(false, 'Tool grant must declare delegated recipes.', correction('Add a `recipes` allowlist for guardrail_run_recipe in the delegated grant.'));
  }
  const recipeHash = recipeConfig?.recipe_hash ?? recipeConfig?.recipeHash;
  if (typeof recipeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(recipeHash)) {
    return decision(false, `Recipe "${recipe}" must be pinned by recipe_hash in the delegated grant.`, correction('Pin the delegated recipe with a 64-character `recipe_hash`.'));
  }

  const allowUnverified = configAllowsUnverified(recipeConfig) || configAllowsUnverified(config);
  if ((args.allow_unverified === true || args.allowUnverified === true) && !allowUnverified) {
    return decision(false, `Unverified recipe execution is not delegated for recipe "${recipe}".`, correction('Omit `allow_unverified`, or update the grant to explicitly allow unverified execution for this recipe.'));
  }

  const constraints = recipeConfig?.inputs ?? recipeConfig?.input_constraints ?? {};
  const inputs = isObject(args.inputs) ? args.inputs : {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!(key in constraints)) {
      return decision(false, `Input "${key}" is not delegated for recipe "${recipe}".`, correction('Use only input keys listed for this recipe by guardrail_grant_status, or update the delegated grant.'));
    }
    if (!matchesValue(value, constraints[key])) {
      return decision(false, `Input "${key}" is outside delegated constraints for recipe "${recipe}".`, correction('Change the input value to match the constraints shown by guardrail_grant_status, or update the delegated grant.'));
    }
  }
  return decision(true, 'allowed', { recipeHash, allowUnverified });
}

export function evaluateHttp(config, args) {
  let url;
  try {
    url = new URL(args.url);
  } catch {
    return decision(false, 'url must be an absolute URL.', correction('Provide an absolute http or https URL, for example `http://127.0.0.1:5001/health`.'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return decision(false, 'Only http and https URLs are supported.', correction('Use an `http://` or `https://` URL.'));
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && config.allow_remote_hosts !== true && config.allowRemoteHosts !== true) {
    return decision(false, 'HTTP requests are limited to loopback hosts unless allow_remote_hosts is explicitly true.', correction('Use a loopback host such as `127.0.0.1`, `localhost`, or `::1`, or explicitly update the grant to allow remote hosts.'));
  }

  const hosts = toArray(config.hosts);
  if (hosts.length > 0 && !hosts.includes(url.hostname)) {
    return decision(false, `Host "${url.hostname}" is not delegated.`, correction('Use one of the delegated hosts listed by guardrail_grant_status.', { allowed: hosts }));
  }
  const method = String(args.method || 'GET').toUpperCase();
  const methods = toArray(config.methods).map((entry) => String(entry).toUpperCase());
  if (methods.length > 0 && !methods.includes(method)) {
    return decision(false, `Method "${method}" is not delegated.`, correction('Use one of the delegated HTTP methods listed by guardrail_grant_status.', { allowed: methods }));
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;
  const ports = toArray(config.ports).map((entry) => Number.parseInt(entry, 10));
  if (ports.length > 0 && !ports.includes(port)) {
    return decision(false, `Port "${port}" is not delegated.`, correction('Use one of the delegated ports listed by guardrail_grant_status, or update the grant.', { allowed: ports }));
  }

  const body = args.body === undefined || args.body === null ? '' : String(args.body);
  const maxBodyBytes = Number.parseInt(config.max_body_bytes ?? config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 10);
  if (Buffer.byteLength(body) > maxBodyBytes) {
    return decision(false, `HTTP request body exceeds ${maxBodyBytes} bytes.`, correction(`Send a request body of ${maxBodyBytes} bytes or less, or update max_body_bytes in the grant.`));
  }
  const requestedTimeout = Number.parseInt(args.timeout_ms ?? args.timeoutMs ?? DEFAULT_MAX_HTTP_TIMEOUT_MS, 10);
  const maxTimeoutMs = Number.parseInt(config.max_timeout_ms ?? config.maxTimeoutMs ?? DEFAULT_MAX_HTTP_TIMEOUT_MS, 10);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    return decision(false, 'timeout_ms must be a positive number.', correction(`Set timeout_ms to a positive number no greater than ${maxTimeoutMs}.`));
  }
  if (requestedTimeout > maxTimeoutMs) {
    return decision(false, `timeout_ms exceeds delegated limit ${maxTimeoutMs}.`, correction(`Set timeout_ms to ${maxTimeoutMs} or less, or update max_timeout_ms in the grant.`));
  }

  const headers = isObject(args.headers) ? Object.keys(args.headers) : [];
  const allowedHeaders = toArray(config.allowed_headers ?? config.allowedHeaders).map((h) => String(h).toLowerCase());
  if (headers.length > 0 && allowedHeaders.length === 0) {
    return decision(false, 'Custom headers are not delegated.', correction('Remove custom headers, or add allowed_headers to the delegated grant.'));
  }
  for (const header of headers) {
    if (!allowedHeaders.includes(header.toLowerCase())) {
      return decision(false, `Header "${header}" is not delegated.`, correction('Use only delegated headers listed by guardrail_grant_status, or update allowed_headers in the grant.', { allowed: allowedHeaders }));
    }
  }
  return decision(true, 'allowed', { method, url: url.toString(), maxBodyBytes, timeoutMs: requestedTimeout });
}

export function evaluateService(config, grant, args) {
  const serviceId = args.service_id ?? args.serviceId;
  if (typeof serviceId !== 'string' || !serviceId) {
    return decision(false, 'service_id is required.', correction('Provide a service_id listed by guardrail_grant_status.'));
  }
  const serviceList = toArray(config.services);
  const declared = isObject(grant.services) && isObject(grant.services[serviceId]);
  if (serviceList.length > 0 && !serviceList.includes(serviceId)) {
    return decision(false, `Service "${serviceId}" is not delegated.`, correction('Use one of the delegated service IDs listed by guardrail_grant_status.', { allowed: serviceList }));
  }
  if (!declared) return decision(false, `Service "${serviceId}" is not declared by the grant.`, correction('Use a service declared in the grant `services` map, or update the grant.'));
  return decision(true, 'allowed');
}

export function evaluateGitCommit(config, args) {
  const recipeHash = config.recipe_hash ?? config.recipeHash;
  if (typeof recipeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(recipeHash)) {
    return decision(false, 'guardrail_git_commit must be pinned by recipe_hash in the delegated grant.', correction('Pin the git-commit recipe with a 64-character `recipe_hash`.'));
  }
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) {
    return decision(false, 'paths must include at least one repo-relative path.', correction('Provide at least one safe repo-relative path in the `paths` array.'));
  }
  const allowedPaths = toArray(config.allowed_paths ?? config.allowedPaths);
  const pathDecision = validateAllowedPaths(paths, allowedPaths, 'commit');
  if (!pathDecision.allowed) return pathDecision;
  const messageFile = args.message_file ?? args.messageFile;
  if (!pathIsRelativeSafe(messageFile)) {
    return decision(false, 'message_file must be a safe repo-relative path.', correction('Provide `message_file` as a non-empty repo-relative path without `..` segments.'));
  }
  if ((args.allow_unverified === true || args.allowUnverified === true) && !configAllowsUnverified(config)) {
    return decision(false, 'Unverified git commit recipe execution is not delegated.', correction('Omit `allow_unverified`, or update the git commit grant to allow unverified execution.'));
  }
  return decision(true, 'allowed', { recipeHash, allowUnverified: configAllowsUnverified(config) });
}

export function evaluateGitDiff(config, args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  const allowedPaths = toArray(config.allowed_paths ?? config.allowedPaths);
  const pathDecision = validateAllowedPaths(paths, allowedPaths, 'diff');
  if (!pathDecision.allowed) return pathDecision;
  const requestedMax = Number.parseInt(args.max_bytes ?? args.maxBytes ?? DEFAULT_MAX_DIFF_BYTES, 10);
  const delegatedMax = Number.parseInt(config.max_bytes ?? config.maxBytes ?? DEFAULT_MAX_DIFF_BYTES, 10);
  if (!Number.isFinite(requestedMax) || requestedMax < 0) {
    return decision(false, 'max_bytes must be a non-negative number.', correction(`Set max_bytes to a non-negative number no greater than ${delegatedMax}.`));
  }
  if (requestedMax > delegatedMax) {
    return decision(false, `max_bytes exceeds delegated limit ${delegatedMax}.`, correction(`Set max_bytes to ${delegatedMax} or less, or update max_bytes in the grant.`));
  }
  return decision(true, 'allowed', { maxBytes: requestedMax });
}

export function evaluateGitPush(config, args) {
  const recipeHash = config.recipe_hash ?? config.recipeHash;
  if (typeof recipeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(recipeHash)) {
    return decision(false, 'guardrail_git_push_feature_branch must be pinned by recipe_hash in the delegated grant.', correction('Pin the git-push recipe with a 64-character `recipe_hash`.'));
  }
  const remote = args.remote ?? 'origin';
  const allowedRemote = config.remote ?? 'origin';
  if (remote !== allowedRemote) {
    return decision(false, `Remote "${remote}" is not delegated.`, correction(`Use remote "${allowedRemote}", or update the delegated grant.`));
  }
  const branch = args.branch;
  if (typeof branch !== 'string' || !branch) {
    return decision(false, 'branch is required.', correction('Provide a branch matching the branch_pattern listed by guardrail_grant_status.'));
  }
  const pattern = config.branch_pattern ?? config.branchPattern ?? '^(feature|bugfix|chore|docs|refactor|test|ci)/[A-Za-z0-9._/-]{1,96}$';
  if (/^(main|master|production|prod|staging|release\/.+)$/.test(branch)) {
    return decision(false, `Branch "${branch}" is protected.`, correction('Use a non-protected feature, bugfix, chore, docs, refactor, test, or ci branch.'));
  }
  if (!new RegExp(pattern).test(branch)) {
    return decision(false, `Branch "${branch}" is outside delegated branch pattern.`, correction('Use a branch matching the delegated branch_pattern.', { pattern }));
  }
  if ((args.allow_unverified === true || args.allowUnverified === true) && !configAllowsUnverified(config)) {
    return decision(false, 'Unverified git push recipe execution is not delegated.', correction('Omit `allow_unverified`, or update the git push grant to allow unverified execution.'));
  }
  return decision(true, 'allowed', { allowUnverified: configAllowsUnverified(config) });
}

export function serviceDefinitionsFromGrant(grantState) {
  const services = grantState?.grant?.services;
  if (!isObject(services)) return [];
  return Object.entries(services).map(([id, definition]) => ({ id, ...definition }));
}
