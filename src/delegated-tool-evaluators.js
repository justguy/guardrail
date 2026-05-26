const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_HTTP_TIMEOUT_MS = 5000;
const TEMPLATE_ACTIONS = new Set(['describe', 'prepare', 'request_approval', 'run']);
const TEMPLATE_ACTION_FIELDS = {
  describe: new Set(['action', 'template', 'repo_path', 'templates_dir']),
  prepare: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir']),
  request_approval: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir', 'manifest_path', 'expires_in_seconds']),
  run: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir', 'manifest_path', 'approval_request_id']),
};

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

function configAllowsUnverified(config) {
  return config?.allow_unverified === true || config?.allowUnverified === true;
}

function getTemplateActionConfig(config, action) {
  if (!isObject(config)) return {};
  if (isObject(config.actions)) {
    if (!(action in config.actions)) {
      return decision(false, `Template action "${action}" is not delegated.`, correction('Use one of the template actions listed for guardrail_template by guardrail_grant_status, or ask the operator to issue an updated operator-controlled grant.'));
    }
    const actionConfig = config.actions[action];
    return actionConfig === true ? {} : actionConfig;
  }
  if (isObject(config[action])) {
    return config[action];
  }
  return config;
}

function validateTemplateActionArgs(args) {
  const action = args.action;
  if (typeof action !== 'string' || !TEMPLATE_ACTIONS.has(action)) {
    return decision(false, 'Template action must be one of describe, prepare, request_approval, or run.', correction('Call guardrail_template with an `action` of `describe`, `prepare`, `request_approval`, or `run`.'));
  }
  const allowedFields = TEMPLATE_ACTION_FIELDS[action];
  const unexpected = Object.keys(args || {}).filter((key) => !allowedFields.has(key));
  if (unexpected.length > 0) {
    return decision(false, `Unsupported argument(s) for template action "${action}": ${unexpected.join(', ')}.`, correction('Use only the fields allowed by the guardrail_template action schema from tools/list.', { unexpected, action }));
  }
  if (action !== 'describe') {
    const template = args.template ?? args.template_id ?? args.templateId;
    if (typeof template !== 'string' || !template) {
      return decision(false, `template is required for template action "${action}".`, correction('Provide the template name or repo-relative path in the `template` argument.'));
    }
  }
  return decision(true, 'allowed', { action });
}

function getDelegatedItem(config, collectionKey, itemName, label) {
  const collection = config[collectionKey];
  if (collection === true || collection === undefined) return {};
  if (Array.isArray(collection)) {
    if (!collection.includes(itemName)) {
      return decision(false, `${label} "${itemName}" is not delegated.`, correction(`Use one of the ${collectionKey} listed by guardrail_grant_status, or ask the operator to issue an updated operator-controlled grant.`));
    }
    return {};
  }
  if (isObject(collection)) {
    if (!(itemName in collection)) {
      return decision(false, `${label} "${itemName}" is not delegated.`, correction(`Use one of the ${collectionKey} listed by guardrail_grant_status, or ask the operator to issue an updated operator-controlled grant.`));
    }
    return collection[itemName] === true ? {} : collection[itemName];
  }
  return decision(false, `Tool grant must declare delegated ${collectionKey}.`, correction(`Ask the operator to add a \`${collectionKey}\` allowlist for this tool in an operator-controlled grant.`));
}

function validateConstrainedInputs(constraints, inputs, itemName, label) {
  if (!isObject(constraints) || Object.keys(constraints).length === 0) return decision(true, 'allowed');
  for (const [key, value] of Object.entries(inputs || {})) {
    if (!(key in constraints)) {
      return decision(false, `Input "${key}" is not delegated for ${label} "${itemName}".`, correction(`Use only input keys listed for this ${label} by guardrail_grant_status, or ask the operator to update the grant constraints.`));
    }
    if (!matchesValue(value, constraints[key])) {
      return decision(false, `Input "${key}" is outside delegated constraints for ${label} "${itemName}".`, correction('Change the input value to match the constraints shown by guardrail_grant_status, or ask the operator to update the grant constraints.'));
    }
  }
  return decision(true, 'allowed');
}

export function evaluateRecipeDiscovery(config, args) {
  const recipe = args.recipe ?? args.recipe_id ?? args.recipeId;
  if (recipe === undefined || recipe === null || recipe === '') {
    return decision(true, 'allowed');
  }
  const recipeConfig = getDelegatedItem(config, 'recipes', recipe, 'Recipe');
  if (recipeConfig?.allowed === false) return recipeConfig;
  const constraints = recipeConfig?.inputs ?? recipeConfig?.input_constraints ?? {};
  const inputs = isObject(args.inputs) ? args.inputs : {};
  const inputDecision = validateConstrainedInputs(constraints, inputs, recipe, 'recipe');
  if (!inputDecision.allowed) return inputDecision;
  return decision(true, 'allowed', {
    recipeHash: recipeConfig?.recipe_hash ?? recipeConfig?.recipeHash ?? null,
    allowUnverified: configAllowsUnverified(recipeConfig) || configAllowsUnverified(config),
  });
}

export function evaluateRecipe(config, args) {
  const recipe = args.recipe ?? args.recipe_id ?? args.recipeId;
  if (typeof recipe !== 'string' || !recipe) {
    return decision(false, 'recipe is required.', correction('Provide the recipe name in the `recipe` argument.'));
  }
  const approvalRequestId = args.approval_request_id ?? args.approvalRequestId;
  const recipeConfig = getDelegatedItem(config, 'recipes', recipe, 'Recipe');
  if (recipeConfig?.allowed === false) return recipeConfig;

  const allowUnverified = configAllowsUnverified(recipeConfig) || configAllowsUnverified(config);
  if ((args.allow_unverified === true || args.allowUnverified === true) && !allowUnverified) {
    return decision(false, `Unverified recipe execution is not delegated for recipe "${recipe}".`, correction('Omit `allow_unverified`, or ask the operator to update the grant to explicitly allow unverified execution for this recipe.'));
  }

  const constraints = recipeConfig?.inputs ?? recipeConfig?.input_constraints ?? {};
  const inputs = isObject(args.inputs) ? args.inputs : {};
  const inputDecision = validateConstrainedInputs(constraints, inputs, recipe, 'recipe');
  if (!inputDecision.allowed) return inputDecision;
  if (approvalRequestId !== undefined && approvalRequestId !== null && String(approvalRequestId) !== '') {
    return decision(true, 'allowed', {
      approvalMode: 'approval_request',
      approvalRequestId: String(approvalRequestId),
      recipeHash: null,
      allowUnverified,
    });
  }
  const recipeHash = recipeConfig?.recipe_hash ?? recipeConfig?.recipeHash;
  if (typeof recipeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(recipeHash)) {
    return decision(true, 'allowed', {
      approvalMode: 'host_elicitation',
      recipeHash: null,
      allowUnverified,
    });
  }
  return decision(true, 'allowed', { recipeHash, allowUnverified });
}

export function evaluateTemplateDiscovery(config, args) {
  const template = args.template ?? args.template_id ?? args.templateId;
  if (template === undefined || template === null || template === '') {
    return decision(true, 'allowed');
  }
  const templateConfig = getDelegatedItem(config, 'templates', template, 'Template');
  if (templateConfig?.allowed === false) return templateConfig;
  const constraints = templateConfig?.inputs ?? templateConfig?.input_constraints ?? {};
  const inputs = isObject(args.inputs) ? args.inputs : {};
  const inputDecision = validateConstrainedInputs(constraints, inputs, template, 'template');
  if (!inputDecision.allowed) return inputDecision;
  const envAllow = toArray(args.env_allow ?? args.envAllow).map(String);
  const allowedEnv = toArray(templateConfig?.env_allow ?? templateConfig?.envAllow).map(String);
  if (envAllow.length > 0 && allowedEnv.length > 0) {
    const denied = envAllow.filter((entry) => !allowedEnv.includes(entry));
    if (denied.length > 0) {
      return decision(false, `Environment access is outside delegated template env_allow for "${template}".`, correction('Use only env_allow entries listed for this template by guardrail_grant_status, or ask the operator to update the grant constraints.', { denied, allowed: allowedEnv }));
    }
  }
  return decision(true, 'allowed', {
    templateHash: templateConfig?.template_hash ?? templateConfig?.templateHash ?? null,
    envAllow: allowedEnv,
  });
}

export function evaluateTemplate(config, args) {
  const template = args.template ?? args.template_id ?? args.templateId;
  if (typeof template !== 'string' || !template) {
    return decision(false, 'template is required.', correction('Provide the template name or repo-relative path in the `template` argument.'));
  }
  const approvalRequestId = args.approval_request_id ?? args.approvalRequestId;
  const templateConfig = getDelegatedItem(config, 'templates', template, 'Template');
  if (templateConfig?.allowed === false) return templateConfig;
  const constraints = templateConfig?.inputs ?? templateConfig?.input_constraints ?? {};
  const inputs = isObject(args.inputs) ? args.inputs : {};
  const inputDecision = validateConstrainedInputs(constraints, inputs, template, 'template');
  if (!inputDecision.allowed) return inputDecision;
  const envAllow = toArray(args.env_allow ?? args.envAllow).map(String);
  const allowedEnv = toArray(templateConfig?.env_allow ?? templateConfig?.envAllow).map(String);
  if (envAllow.length > 0 && allowedEnv.length > 0) {
    const denied = envAllow.filter((entry) => !allowedEnv.includes(entry));
    if (denied.length > 0) {
      return decision(false, `Environment access is outside delegated template env_allow for "${template}".`, correction('Use only env_allow entries listed for this template by guardrail_grant_status, or ask the operator to update the grant constraints.', { denied, allowed: allowedEnv }));
    }
  }
  if (approvalRequestId !== undefined && approvalRequestId !== null && String(approvalRequestId) !== '') {
    return decision(true, 'allowed', {
      approvalMode: 'approval_request',
      approvalRequestId: String(approvalRequestId),
      templateHash: null,
      envAllow: allowedEnv,
    });
  }
  const templateHash = templateConfig?.template_hash ?? templateConfig?.templateHash;
  if (typeof templateHash !== 'string' || !/^[a-f0-9]{64}$/i.test(templateHash)) {
    return decision(true, 'allowed', {
      approvalMode: 'host_elicitation',
      templateHash: null,
      envAllow: allowedEnv,
    });
  }
  return decision(true, 'allowed', { templateHash, envAllow: allowedEnv });
}

export function evaluateTemplateParent(config, args) {
  const actionDecision = validateTemplateActionArgs(args || {});
  if (!actionDecision.allowed) return actionDecision;
  const action = actionDecision.action;
  const actionConfig = getTemplateActionConfig(config, action);
  if (actionConfig?.allowed === false) return actionConfig;
  if (action === 'run') {
    const runDecision = evaluateTemplate(actionConfig, args);
    return runDecision.allowed ? { ...runDecision, action } : runDecision;
  }
  const discoveryDecision = evaluateTemplateDiscovery(actionConfig, args);
  return discoveryDecision.allowed ? { ...discoveryDecision, action } : discoveryDecision;
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
    return decision(false, 'HTTP requests are limited to loopback hosts unless allow_remote_hosts is explicitly true.', correction('Use a loopback host such as `127.0.0.1`, `localhost`, or `::1`, or ask the operator to explicitly update the grant to allow remote hosts.'));
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
    return decision(false, `Port "${port}" is not delegated.`, correction('Use one of the delegated ports listed by guardrail_grant_status, or ask the operator to update the grant.', { allowed: ports }));
  }

  const body = args.body === undefined || args.body === null ? '' : String(args.body);
  const maxBodyBytes = Number.parseInt(config.max_body_bytes ?? config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 10);
  if (Buffer.byteLength(body) > maxBodyBytes) {
    return decision(false, `HTTP request body exceeds ${maxBodyBytes} bytes.`, correction(`Send a request body of ${maxBodyBytes} bytes or less, or ask the operator to update max_body_bytes in the grant.`));
  }
  const requestedTimeout = Number.parseInt(args.timeout_ms ?? args.timeoutMs ?? DEFAULT_MAX_HTTP_TIMEOUT_MS, 10);
  const maxTimeoutMs = Number.parseInt(config.max_timeout_ms ?? config.maxTimeoutMs ?? DEFAULT_MAX_HTTP_TIMEOUT_MS, 10);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    return decision(false, 'timeout_ms must be a positive number.', correction(`Set timeout_ms to a positive number no greater than ${maxTimeoutMs}.`));
  }
  if (requestedTimeout > maxTimeoutMs) {
    return decision(false, `timeout_ms exceeds delegated limit ${maxTimeoutMs}.`, correction(`Set timeout_ms to ${maxTimeoutMs} or less, or ask the operator to update max_timeout_ms in the grant.`));
  }

  const headers = isObject(args.headers) ? Object.keys(args.headers) : [];
  const allowedHeaders = toArray(config.allowed_headers ?? config.allowedHeaders).map((h) => String(h).toLowerCase());
  if (headers.length > 0 && allowedHeaders.length === 0) {
    return decision(false, 'Custom headers are not delegated.', correction('Remove custom headers, or ask the operator to add allowed_headers to the delegated grant.'));
  }
  for (const header of headers) {
    if (!allowedHeaders.includes(header.toLowerCase())) {
      return decision(false, `Header "${header}" is not delegated.`, correction('Use only delegated headers listed by guardrail_grant_status, or ask the operator to update allowed_headers in the grant.', { allowed: allowedHeaders }));
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
  if (!declared) return decision(false, `Service "${serviceId}" is not declared by the grant.`, correction('Use a service declared in the grant `services` map, or ask the operator to update the grant.'));
  return decision(true, 'allowed');
}

export function serviceDefinitionsFromGrant(grantState) {
  const services = grantState?.grant?.services;
  if (!isObject(services)) return [];
  return Object.entries(services).map(([id, definition]) => ({ id, ...definition }));
}
