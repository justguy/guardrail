import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { createApprovalRequest, loadRequest, saveRequest } from './approval-queue.js';
import { appendEntry } from './audit.js';
import { serializeStable } from './contract.js';
import { dryRun } from './recipe-executor.js';
import { buildVersionIndex } from './recipe-index.js';
import { hashRecipe } from './recipe.js';
import { resolveInputs, resolveRecipeById } from './recipe-runner.js';
import { runRecipeSupervisor } from './recipe-supervisor.js';
import { createServiceRegistry } from './service-registry.js';
import {
  computeEnvIntersection,
  createTemplateManifest,
  describeSchema,
  evaluateTemplateRisk,
  explainTemplate,
  hashTemplateDefinition,
  hashTemplateExecution,
  listTemplates,
  loadTemplate,
  simulateTemplate,
  validateUserInputs,
} from './template.js';
import { runTemplateSupervisor } from './template-supervisor.js';
import {
  describeDelegatedGrant,
  evaluateDelegatedTool,
  loadDelegatedGrant,
  serviceDefinitionsFromGrant,
} from './delegated-policy.js';
import { errorResult, jsonText, listGuardrailMcpTools } from './mcp-tools.js';

const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;

function appendBounded(text, chunk, maxBytes) {
  const combined = `${text}${chunk}`;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  return Buffer.from(combined).subarray(0, maxBytes).toString('utf8');
}

function audit(context, event, fields = {}) {
  if (!context.auditPath) return;
  try {
    appendEntry(context.auditPath, {
      event,
      family: 'mcp',
      tool: fields.tool ?? null,
      grant_hash: context.grantState?.hash ?? null,
      decision: fields.decision ?? null,
      reason: fields.reason ?? null,
      status: fields.status ?? null,
      repo_path: fields.repoPath ?? null,
      recipe: fields.recipe ?? null,
      service_id: fields.serviceId ?? null,
      method: fields.method ?? null,
      url: fields.url ?? null,
      branch: fields.branch ?? null,
      paths: fields.paths ?? null,
      manifest_path: fields.manifestPath ?? null,
    });
  } catch {
    // MCP protocol output owns stdout; audit failure must not corrupt framing.
  }
}

function denied(context, toolName, denial) {
  const reason = denial?.reason ?? String(denial || 'Delegated tool call was denied.');
  audit(context, 'mcp_tool_denied', { tool: toolName, decision: 'denied', reason });
  return errorResult('delegation_denied', reason, {
    tool: toolName,
    grantHash: context.grantState?.hash ?? null,
    correction: denial?.correction ?? {
      expected: 'Call guardrail_grant_status to inspect delegated tools and policy limits, then retry within the active grant.',
    },
  });
}

function checkDelegation(context, toolName, args) {
  const result = evaluateDelegatedTool(context, toolName, args);
  if (!result.allowed) return result;
  audit(context, 'mcp_tool_allowed', {
    tool: toolName,
    decision: 'allowed',
    reason: result.reason,
    repoPath: result.repoPath,
    recipe: args.recipe,
    serviceId: args.service_id ?? args.serviceId,
    method: result.method,
    url: result.url,
    branch: args.branch,
    paths: args.paths,
    manifestPath: args.manifest_path ?? args.manifestPath,
  });
  return result;
}

async function performHttpRequest(decisionResult, args) {
  const url = new URL(decisionResult.url);
  const client = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = args.body === undefined || args.body === null ? '' : String(args.body);
  const headers = { ...(args.headers || {}) };
  const lowerHeaders = Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), headers[k]]));
  if (body && !('content-length' in lowerHeaders)) headers['content-length'] = Buffer.byteLength(body);

  return await new Promise((resolveRequest) => {
    let responseBody = '';
    let truncated = false;
    const req = client(url, { method: decisionResult.method, headers, timeout: decisionResult.timeoutMs }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const next = appendBounded(responseBody, chunk, MAX_HTTP_RESPONSE_BYTES);
        truncated = truncated || next.length < `${responseBody}${chunk}`.length;
        responseBody = next;
      });
      res.on('end', () => {
        resolveRequest({ ok: true, statusCode: res.statusCode, headers: res.headers, body: responseBody, truncated });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP request timed out after ${decisionResult.timeoutMs}ms.`)));
    req.on('error', (err) => resolveRequest({ ok: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function resolveRepoRelative(repoPath, value, label) {
  const raw = String(value || '.');
  if (isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be repo-relative and must not contain ".." segments.`);
  }
  return resolve(repoPath, raw);
}

function stableEqual(a, b) {
  return serializeStable(a) === serializeStable(b);
}

function stableHash(value) {
  return createHash('sha256').update(serializeStable(value)).digest('hex');
}

function defaultApprovalStateDir() {
  return resolve(homedir(), '.guardrail');
}

function approvalStateDir(context) {
  return resolve(context.approvalStateDir || process.env.GUARDRAIL_APPROVAL_STATE_DIR || defaultApprovalStateDir());
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function commandText(argv) {
  return argv.map(shellQuote).join(' ');
}

function inputArgv(inputs) {
  return Object.entries(inputs || {}).flatMap(([key, value]) => ['--input', `${key}=${value}`]);
}

function repoRelativePath(repoPath, absolutePath) {
  const rel = relative(repoPath, absolutePath);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolutePath;
}

function defaultRecipeManifestPath(repoPath, recipeId) {
  return resolve(repoPath, '.guardrail', 'recipes', `${recipeId}.approved.json`);
}

function defaultTemplateManifestPath(repoPath, templateName) {
  return resolve(repoPath, '.guardrail', 'templates', `${templateName}.approved.json`);
}

function approvalCliCommands(stateDir, requestId) {
  return {
    list: commandText(['guardrail', 'approve', 'list', '--state-dir', stateDir]),
    approve: commandText(['guardrail', 'approve', requestId, '--state-dir', stateDir]),
    reject: commandText(['guardrail', 'approve', requestId, '--reject', '--state-dir', stateDir]),
  };
}

function summarizePlanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 12).map((step, index) => {
    if (!isObject(step)) return { index, value: String(step) };
    return {
      id: step.id ?? null,
      description: step.description ?? step.name ?? null,
      command: step.command ?? step.run?.command ?? null,
      args: step.args ?? step.run?.args ?? null,
      mode: step.mode ?? step.run?.mode ?? null,
    };
  });
}

function hostApprovalRequest(subject) {
  return {
    mode: 'form',
    message: [
      'Guardrail MCP host approval requested.',
      '',
      'Approve only if this exact prepared execution should run. Agent-provided tool arguments cannot approve this request; this MCP host prompt is the approval boundary. Decline or cancel to fail closed before supervisor execution.',
      '',
      JSON.stringify(subject, null, 2),
    ].join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: 'Decision',
          description: 'Select approve only for the exact execution details shown above.',
          enum: ['approve', 'decline'],
          default: 'decline',
        },
      },
      required: ['decision'],
    },
  };
}

async function requestHostApproval(callContext, subject) {
  const elicitInput = callContext?.elicitInput;
  if (typeof elicitInput !== 'function') {
    return {
      ok: false,
      code: 'host_approval_unavailable',
      reason: 'MCP host elicitation is not available for this tool call.',
      subject,
    };
  }

  let result;
  try {
    result = await elicitInput(hostApprovalRequest(subject));
  } catch (err) {
    return {
      ok: false,
      code: 'host_approval_unavailable',
      reason: `MCP host elicitation failed or is unsupported: ${err.message}`,
      subject,
    };
  }

  if (result?.action !== 'accept') {
    return {
      ok: false,
      code: 'host_approval_denied',
      reason: `MCP host ${result?.action || 'did not accept'} the approval request.`,
      subject,
      response: result ?? null,
    };
  }
  const decision = String(result.content?.decision || '').toLowerCase();
  if (!['approve', 'decline'].includes(decision)) {
    return {
      ok: false,
      code: 'host_approval_invalid',
      reason: 'MCP host response did not include a valid approval decision.',
      subject,
      response: result,
    };
  }
  if (decision !== 'approve') {
    return {
      ok: false,
      code: 'host_approval_denied',
      reason: 'MCP host response did not approve this execution.',
      subject,
      response: result,
    };
  }

  return { ok: true, subject, response: result };
}

function withApprovalSubjectHash(subject) {
  return {
    ...subject,
    approval_subject_hash: stableHash(subject),
  };
}

function recipeSearchDirs(repoPath, args = {}) {
  const explicit = toStringArray(args.search_dirs ?? args.searchDirs)
    .map((entry) => resolveRepoRelative(repoPath, entry, 'search_dirs entries'));
  return [...explicit, resolve(repoPath, 'recipes')];
}

function summarizeRecipe(recipe, sourcePath) {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    version: recipe.version,
    category: recipe.category ?? 'custom',
    channel: recipe.channel ?? 'community',
    riskLevel: recipe.risk_level,
    approvalRequired: recipe.approval_required,
    requiresEnv: recipe.requires_env ?? [],
    requiresAuth: recipe.requires_auth ?? [],
    inputs: recipe.inputs ?? {},
    recipeHash: hashRecipe(recipe),
    sourcePath,
  };
}

function inputGrantConstraints(resolvedInputs) {
  return Object.fromEntries(
    Object.entries(resolvedInputs || {}).map(([key, value]) => [key, { exact: value }]),
  );
}

function describeRecipes(repoPath, args = {}) {
  const dirs = recipeSearchDirs(repoPath, args);
  const recipeName = args.recipe ?? args.recipe_id ?? args.recipeId;
  if (recipeName) {
    const { recipe, sourcePath } = resolveRecipeById(recipeName, dirs);
    return {
      ok: true,
      mode: 'recipe',
      recipe: summarizeRecipe(recipe, sourcePath),
      setup: {
        nextStep: 'Call guardrail_recipe_prepare with concrete inputs to get dry-run output and a human-reviewable grant snippet.',
      },
    };
  }
  const index = buildVersionIndex(dirs);
  const recipes = [...index.entries()].map(([id, versions]) => {
    const latest = versions[0];
    return {
      id,
      latestVersion: latest.version,
      versions: versions.map((entry) => entry.version),
      recipeHash: hashRecipe(latest.recipe),
      sourcePath: latest.source,
      name: latest.recipe.name,
      description: latest.recipe.description,
      riskLevel: latest.recipe.risk_level,
    };
  });
  return { ok: true, mode: 'list', searchDirs: dirs, recipes };
}

function prepareRecipe(repoPath, args = {}, delegation = {}) {
  const recipeName = args.recipe ?? args.recipe_id ?? args.recipeId;
  const { recipe, sourcePath } = resolveRecipeById(recipeName, recipeSearchDirs(repoPath, args));
  const { resolved, flagged } = resolveInputs(recipe, isObject(args.inputs) ? args.inputs : {});
  const recipeHash = hashRecipe(recipe);
  const simulation = dryRun(recipe, resolved);
  const allowUnverified = delegation.allowUnverified === true || args.allow_unverified === true || args.allowUnverified === true;
  const manifestPath = args.manifest_path ?? args.manifestPath
    ? resolveRepoRelative(repoPath, args.manifest_path ?? args.manifestPath, 'manifest_path')
    : defaultRecipeManifestPath(repoPath, recipe.id);
  const approvalArgv = [
    'guardrail',
    'run',
    '--recipe',
    recipe.id,
    ...inputArgv(resolved),
    '--manifest',
    repoRelativePath(repoPath, manifestPath),
  ];
  if (allowUnverified) approvalArgv.push('--allow-unverified');
  return {
    ok: true,
    recipe: summarizeRecipe(recipe, sourcePath),
    resolvedInputs: resolved,
    flaggedInputs: flagged,
    dryRun: simulation,
    approval: {
      preferred: 'Call guardrail_run_recipe from an MCP host with form elicitation support, or call guardrail_recipe_request_approval for the CLI approval fallback.',
      fallbackCommand: commandText(approvalArgv),
      manifestPath,
    },
    setup: {
      requiresEnv: recipe.requires_env ?? [],
      requiresAuth: recipe.requires_auth ?? [],
      humanApproval: 'For unpinned runs, approval must come from the MCP host elicitation prompt or from a human-approved Guardrail CLI approval queue request before calling guardrail_run_recipe with approval_request_id.',
      grantSnippet: {
        tools: {
          guardrail_run_recipe: {
            recipes: {
              [recipe.id]: {
                recipe_hash: recipeHash,
                allow_unverified: allowUnverified,
                inputs: inputGrantConstraints(resolved),
              },
            },
          },
        },
      },
    },
  };
}

function requestExpiry(args = {}) {
  const seconds = Number.parseInt(args.expires_in_seconds ?? args.expiresInSeconds ?? 24 * 60 * 60, 10);
  const bounded = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 7 * 24 * 60 * 60) : 24 * 60 * 60;
  return new Date(Date.now() + bounded * 1000).toISOString();
}

function createRecipeApprovalRequest(context, repoPath, args = {}, delegation = {}) {
  const prepared = prepareRecipe(repoPath, args, delegation);
  const stateDir = approvalStateDir(context);
  const manifestPath = prepared.approval.manifestPath;
  const request = createApprovalRequest({
    kind: 'mcp_recipe_execution',
    tool: 'guardrail_run_recipe',
    agent: context.agent,
    repoPath,
    recipeId: prepared.recipe.id,
    riskLevel: prepared.recipe.riskLevel ?? 'medium',
    requester: context.agent,
    executionPlan: prepared.dryRun.steps ?? [],
    expiresAt: requestExpiry(args),
    payload: {
      recipe_id: prepared.recipe.id,
      recipe_hash: prepared.recipe.recipeHash,
      inputs: prepared.resolvedInputs,
      allow_unverified: prepared.setup.grantSnippet.tools.guardrail_run_recipe.recipes[prepared.recipe.id].allow_unverified === true,
      repo_path: repoPath,
      manifest_path: manifestPath,
      source_path: prepared.recipe.sourcePath,
    },
  });
  const path = saveRequest(request, stateDir);
  return {
    ok: true,
    request,
    requestPath: path,
    stateDir,
    commands: approvalCliCommands(stateDir, request.id),
    prepared,
    nextStep: 'Ask the human to run the approve command, then call guardrail_run_recipe with approval_request_id set to this request id.',
  };
}

function recipeHostApprovalSubject(context, repoPath, prepared, manifestPath, args = {}, delegation = {}) {
  const allowUnverified = delegation.allowUnverified === true || args.allow_unverified === true || args.allowUnverified === true;
  return withApprovalSubjectHash({
    kind: 'mcp_host_elicitation_approval',
    tool: 'guardrail_run_recipe',
    agent: context.agent,
    grant_hash: context.grantState.hash,
    repo_path: repoPath,
    recipe: prepared.recipe.id,
    recipe_name: prepared.recipe.name,
    recipe_hash: prepared.recipe.recipeHash,
    inputs: prepared.resolvedInputs,
    allow_unverified: allowUnverified,
    manifest_path: manifestPath,
    source_path: prepared.recipe.sourcePath,
    risk: {
      level: prepared.recipe.riskLevel ?? 'medium',
      approval_required: prepared.recipe.approvalRequired === true,
      flagged_inputs: prepared.flaggedInputs ?? {},
    },
    setup: {
      requires_env: prepared.setup.requiresEnv ?? [],
      requires_auth: prepared.setup.requiresAuth ?? [],
      dry_run_steps: summarizePlanSteps(prepared.dryRun?.steps),
    },
  });
}

function validateApprovedRecipeRequest(context, args, delegation, repoPath) {
  const requestId = delegation.approvalRequestId;
  const stateDir = approvalStateDir(context);
  let request;
  try {
    request = loadRequest(requestId, stateDir);
  } catch (err) {
    return { ok: false, reason: err.message, stateDir };
  }
  if (request.status !== 'approved') return { ok: false, reason: `Approval request "${requestId}" is ${request.status}, not approved.`, request, stateDir };
  if (request.expires_at && Date.parse(request.expires_at) <= Date.now()) return { ok: false, reason: `Approval request "${requestId}" has expired.`, request, stateDir };
  const prepared = prepareRecipe(repoPath, args, delegation);
  const expectedManifestPath = args.manifest_path ?? args.manifestPath
    ? resolveRepoRelative(repoPath, args.manifest_path ?? args.manifestPath, 'manifest_path')
    : defaultRecipeManifestPath(repoPath, prepared.recipe.id);
  const payload = request.payload || {};
  const checks = [
    ['kind', request.kind, 'mcp_recipe_execution'],
    ['tool', request.tool, 'guardrail_run_recipe'],
    ['agent', request.agent, context.agent],
    ['repo_path', payload.repo_path, repoPath],
    ['recipe_id', payload.recipe_id, prepared.recipe.id],
    ['recipe_hash', payload.recipe_hash, prepared.recipe.recipeHash],
    ['manifest_path', payload.manifest_path, expectedManifestPath],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) return { ok: false, reason: `Approval request ${label} mismatch.`, request, prepared, stateDir, expected, actual };
  }
  if (!stableEqual(payload.inputs || {}, prepared.resolvedInputs || {})) {
    return { ok: false, reason: 'Approval request inputs do not match this recipe run.', request, prepared, stateDir };
  }
  const allowUnverified = delegation.allowUnverified === true || args.allow_unverified === true || args.allowUnverified === true;
  if ((payload.allow_unverified === true) !== allowUnverified) {
    return { ok: false, reason: 'Approval request allow_unverified does not match this recipe run.', request, prepared, stateDir };
  }
  return {
    ok: true,
    request,
    prepared,
    stateDir,
    manifestPath: expectedManifestPath,
    delegatedApproval: {
      allowed: true,
      actor: request.approvals?.at(-1)?.approver || 'cli_approval',
      grantHash: context.grantState.hash,
      recipeHash: prepared.recipe.recipeHash,
      tool: 'guardrail_run_recipe',
      reason: `guardrail_mcp_cli_approval_request:${request.id}`,
    },
  };
}

async function runDelegatedRecipe(context, toolName, args, delegation, callContext = {}) {
  const recipe = args.recipe;
  const repoPath = delegation.repoPath || context.cwd;
  let delegatedApproval = {
    allowed: true,
    actor: context.agent,
    grantHash: context.grantState.hash,
    recipeHash: delegation.recipeHash,
    tool: 'guardrail_run_recipe',
    reason: 'guardrail_mcp_delegated_grant',
  };
  let manifestPath = args.manifest_path ?? args.manifestPath ?? null;
  if (delegation.approvalMode === 'approval_request') {
    const approvedRequest = validateApprovedRecipeRequest(context, args, delegation, repoPath);
    if (!approvedRequest.ok) {
      return errorResult('approval_request_denied', approvedRequest.reason, {
        tool: toolName,
        approvalRequestId: delegation.approvalRequestId,
        correction: {
          expected: 'Call guardrail_recipe_request_approval, have a human approve it with guardrail approve, then retry with the same inputs and approval_request_id.',
          stateDir: approvedRequest.stateDir,
        },
      });
    }
    delegatedApproval = approvedRequest.delegatedApproval;
    manifestPath = approvedRequest.manifestPath;
  } else if (delegation.approvalMode === 'host_elicitation') {
    const prepared = prepareRecipe(repoPath, args, delegation);
    const expectedManifestPath = args.manifest_path ?? args.manifestPath
      ? resolveRepoRelative(repoPath, args.manifest_path ?? args.manifestPath, 'manifest_path')
      : defaultRecipeManifestPath(repoPath, prepared.recipe.id);
    const subject = recipeHostApprovalSubject(context, repoPath, prepared, expectedManifestPath, args, delegation);
    const hostApproval = await requestHostApproval(callContext, subject);
    if (!hostApproval.ok) {
      return errorResult(hostApproval.code, hostApproval.reason, {
        tool: toolName,
        approvalMode: 'host_elicitation',
        approvalSubject: hostApproval.subject,
        correction: {
          expected: 'Use an MCP host with form elicitation support and approve the exact host prompt, or use guardrail_recipe_request_approval plus approval_request_id as the CLI fallback.',
        },
      });
    }
    delegatedApproval = {
      allowed: true,
      actor: 'mcp_host_elicitation',
      grantHash: context.grantState.hash,
      recipeHash: prepared.recipe.recipeHash,
      tool: 'guardrail_run_recipe',
      reason: `guardrail_mcp_host_elicitation:${subject.approval_subject_hash}`,
    };
    manifestPath = expectedManifestPath;
  } else if (manifestPath) {
    manifestPath = resolveRepoRelative(repoPath, manifestPath, 'manifest_path');
  }
  const result = await runRecipeSupervisor({
    specifier: recipe,
    inputs: args.inputs || {},
    cwd: repoPath,
    searchDirs: recipeSearchDirs(repoPath, args),
    manifestPath,
    nonInteractive: true,
    jsonOutput: true,
    allowUnverified: delegation.allowUnverified === true || args.allow_unverified === true || args.allowUnverified === true,
    delegatedApproval,
  });
  audit(context, 'mcp_tool_completed', {
    tool: toolName,
    status: result.status,
    repoPath: delegation.repoPath,
    recipe,
    manifestPath: result.manifestPath ?? args.manifest_path ?? args.manifestPath,
  });
  return jsonText({ ok: result.status === 'success', result });
}

function resolveTemplatePath(repoPath, args = {}) {
  const rawTemplate = args.template ?? args.template_id ?? args.templateId;
  const templatesDir = resolveRepoRelative(repoPath, args.templates_dir ?? args.templatesDir ?? '.guardrail/templates', 'templates_dir');
  if (!rawTemplate) return { templatesDir, templatePath: null };
  const template = String(rawTemplate);
  const candidates = [];
  if (template.endsWith('.json') || template.includes('/')) {
    candidates.push(resolveRepoRelative(repoPath, template, 'template'));
  }
  candidates.push(resolve(templatesDir, template.endsWith('.json') ? template : `${template}.json`));
  candidates.push(resolve(templatesDir, template));
  const templatePath = candidates.find((candidate) => existsSync(candidate));
  if (!templatePath) {
    throw new Error(`Template "${template}" not found in ${templatesDir}.`);
  }
  return { templatesDir, templatePath };
}

function summarizeTemplate(def, templatePath, resolvedInputs = null, envIntersection = null) {
  const summary = {
    name: def.name,
    kind: def.kind,
    description: def.description,
    trustClass: def.trust_class,
    risk: def.risk,
    riskReasons: def.risk_reasons ?? [],
    requiresEnv: def.requires_env ?? [],
    inputs: def.inputs ?? {},
    templateDefHash: hashTemplateDefinition(def),
    sourcePath: templatePath,
  };
  if (resolvedInputs && envIntersection) {
    summary.templateHash = hashTemplateExecution(def, resolvedInputs, envIntersection);
  }
  return summary;
}

function describeTemplates(repoPath, args = {}) {
  const { templatesDir, templatePath } = resolveTemplatePath(repoPath, args);
  if (!templatePath) {
    const templates = listTemplates(templatesDir).map((entry) => {
      const def = loadTemplate(entry.path);
      return summarizeTemplate(def, entry.path);
    });
    return { ok: true, mode: 'list', templatesDir, templates };
  }
  const def = loadTemplate(templatePath);
  return {
    ok: true,
    mode: 'template',
    template: summarizeTemplate(def, templatePath),
    explanation: explainTemplate(def),
    schema: describeSchema(def),
    setup: {
      nextStep: 'Call guardrail_template_prepare with concrete inputs and env_allow to get simulation output and a human-reviewable grant snippet.',
    },
  };
}

function prepareTemplate(repoPath, args = {}) {
  const { templatePath } = resolveTemplatePath(repoPath, args);
  const def = loadTemplate(templatePath);
  const inputs = isObject(args.inputs) ? args.inputs : {};
  const envAllow = toStringArray(args.env_allow ?? args.envAllow);
  const validation = validateUserInputs(def.inputs || {}, inputs);
  const simulation = simulateTemplate(def, inputs, envAllow);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'template_validation_failed',
      template: summarizeTemplate(def, templatePath),
      errors: validation.errors,
      simulation,
    };
  }
  const envResult = computeEnvIntersection(def.requires_env || [], envAllow);
  const templateHash = hashTemplateExecution(def, validation.values, envResult.intersection);
  const riskAssessment = evaluateTemplateRisk(def, envResult.intersection);
  const manifest = createTemplateManifest(def, templateHash, riskAssessment, validation.values, envResult.intersection);
  const manifestPath = args.manifest_path ?? args.manifestPath
    ? resolveRepoRelative(repoPath, args.manifest_path ?? args.manifestPath, 'manifest_path')
    : defaultTemplateManifestPath(repoPath, def.name);
  const templateArg = repoRelativePath(repoPath, templatePath);
  const approvalArgv = [
    'guardrail',
    'run',
    '--template',
    templateArg,
    ...inputArgv(validation.values),
    ...envAllow.flatMap((entry) => ['--env-allow', entry]),
    '--manifest',
    repoRelativePath(repoPath, manifestPath),
  ];
  return {
    ok: envResult.denied.length === 0,
    code: envResult.denied.length === 0 ? undefined : 'template_env_not_allowed',
    template: summarizeTemplate(def, templatePath, validation.values, envResult.intersection),
    resolvedInputs: validation.values,
    env: envResult,
    riskAssessment,
    simulation,
    manifestPreview: manifest,
    approval: {
      preferred: 'Call guardrail_run_template from an MCP host with form elicitation support, or call guardrail_template_request_approval for the CLI approval fallback.',
      fallbackCommand: commandText(approvalArgv),
      manifestPath,
    },
    setup: {
      humanApproval: 'For unpinned runs, approval must come from the MCP host elicitation prompt or from a human-approved Guardrail CLI approval queue request before calling guardrail_run_template with approval_request_id.',
      grantSnippet: {
        tools: {
          guardrail_template: {
            actions: {
              run: {
                templates: {
                  [def.name]: {
                    template_hash: templateHash,
                    inputs: inputGrantConstraints(validation.values),
                    env_allow: envAllow,
                  },
                },
              },
            },
          },
          guardrail_run_template: {
            templates: {
              [def.name]: {
                template_hash: templateHash,
                inputs: inputGrantConstraints(validation.values),
                env_allow: envAllow,
              },
            },
          },
        },
      },
    },
  };
}

const TEMPLATE_PARENT_ACTIONS = new Set(['describe', 'prepare', 'request_approval', 'run']);
const TEMPLATE_PARENT_FIELDS = {
  describe: new Set(['action', 'template', 'repo_path', 'templates_dir']),
  prepare: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir']),
  request_approval: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir', 'manifest_path', 'expires_in_seconds']),
  run: new Set(['action', 'template', 'inputs', 'env_allow', 'repo_path', 'templates_dir', 'manifest_path', 'approval_request_id']),
};

function normalizeTemplateParentArgs(args = {}) {
  const action = args.action;
  if (typeof action !== 'string' || !TEMPLATE_PARENT_ACTIONS.has(action)) {
    return {
      ok: false,
      code: 'invalid_template_action',
      message: 'guardrail_template requires action to be one of describe, prepare, request_approval, or run.',
    };
  }
  const unexpected = Object.keys(args).filter((key) => !TEMPLATE_PARENT_FIELDS[action].has(key));
  if (unexpected.length > 0) {
    return {
      ok: false,
      code: 'invalid_template_action_args',
      message: `Unsupported argument(s) for template action "${action}": ${unexpected.join(', ')}.`,
      unexpected,
    };
  }
  if (action !== 'describe' && (typeof args.template !== 'string' || !args.template)) {
    return {
      ok: false,
      code: 'missing_template',
      message: `template is required for template action "${action}".`,
    };
  }
  const { action: _action, ...actionArgs } = args;
  return { ok: true, action, args: actionArgs };
}

function createTemplateApprovalRequest(context, repoPath, args = {}) {
  const prepared = prepareTemplate(repoPath, args);
  if (!prepared.ok) return prepared;
  const stateDir = approvalStateDir(context);
  const request = createApprovalRequest({
    kind: 'mcp_template_execution',
    tool: 'guardrail_run_template',
    agent: context.agent,
    repoPath,
    templateName: prepared.template.name,
    riskLevel: prepared.riskAssessment.riskLevel ?? 'medium',
    requester: context.agent,
    executionPlan: prepared.simulation.steps ?? [],
    expiresAt: requestExpiry(args),
    payload: {
      template: args.template ?? args.template_id ?? args.templateId,
      template_name: prepared.template.name,
      template_hash: prepared.template.templateHash,
      inputs: prepared.resolvedInputs,
      env_allow: toStringArray(args.env_allow ?? args.envAllow),
      repo_path: repoPath,
      manifest_path: prepared.approval.manifestPath,
      source_path: prepared.template.sourcePath,
    },
  });
  const path = saveRequest(request, stateDir);
  return {
    ok: true,
    request,
    requestPath: path,
    stateDir,
    commands: approvalCliCommands(stateDir, request.id),
    prepared,
    nextStep: 'Ask the human to run the approve command, then call guardrail_run_template with approval_request_id set to this request id.',
  };
}

function templateHostApprovalSubject(context, repoPath, prepared, args = {}) {
  return withApprovalSubjectHash({
    kind: 'mcp_host_elicitation_approval',
    tool: 'guardrail_run_template',
    agent: context.agent,
    grant_hash: context.grantState.hash,
    repo_path: repoPath,
    template: args.template ?? args.template_id ?? args.templateId,
    template_name: prepared.template.name,
    template_definition_hash: prepared.template.templateDefHash,
    template_hash: prepared.template.templateHash,
    inputs: prepared.resolvedInputs,
    env_allow: toStringArray(args.env_allow ?? args.envAllow),
    env: prepared.env,
    manifest_path: prepared.approval.manifestPath,
    source_path: prepared.template.sourcePath,
    risk: prepared.riskAssessment,
    setup: {
      requires_env: prepared.template.requiresEnv ?? [],
      simulation_steps: summarizePlanSteps(prepared.simulation?.steps),
    },
  });
}

function validateApprovedTemplateRequest(context, args, delegation, repoPath) {
  const requestId = delegation.approvalRequestId;
  const stateDir = approvalStateDir(context);
  let request;
  try {
    request = loadRequest(requestId, stateDir);
  } catch (err) {
    return { ok: false, reason: err.message, stateDir };
  }
  if (request.status !== 'approved') return { ok: false, reason: `Approval request "${requestId}" is ${request.status}, not approved.`, request, stateDir };
  if (request.expires_at && Date.parse(request.expires_at) <= Date.now()) return { ok: false, reason: `Approval request "${requestId}" has expired.`, request, stateDir };
  const prepared = prepareTemplate(repoPath, args);
  if (!prepared.ok) return { ok: false, reason: prepared.code || 'Template preparation failed.', request, prepared, stateDir };
  const payload = request.payload || {};
  const checks = [
    ['kind', request.kind, 'mcp_template_execution'],
    ['tool', request.tool, 'guardrail_run_template'],
    ['agent', request.agent, context.agent],
    ['repo_path', payload.repo_path, repoPath],
    ['template_name', payload.template_name, prepared.template.name],
    ['template_hash', payload.template_hash, prepared.template.templateHash],
    ['manifest_path', payload.manifest_path, prepared.approval.manifestPath],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) return { ok: false, reason: `Approval request ${label} mismatch.`, request, prepared, stateDir, expected, actual };
  }
  if (!stableEqual(payload.inputs || {}, prepared.resolvedInputs || {})) {
    return { ok: false, reason: 'Approval request inputs do not match this template run.', request, prepared, stateDir };
  }
  if (!stableEqual(payload.env_allow || [], toStringArray(args.env_allow ?? args.envAllow))) {
    return { ok: false, reason: 'Approval request env_allow does not match this template run.', request, prepared, stateDir };
  }
  return {
    ok: true,
    request,
    prepared,
    stateDir,
    manifestPath: prepared.approval.manifestPath,
    delegatedApproval: {
      allowed: true,
      actor: request.approvals?.at(-1)?.approver || 'cli_approval',
      grantHash: context.grantState.hash,
      templateHash: prepared.template.templateHash,
      tool: 'guardrail_run_template',
      reason: `guardrail_mcp_cli_approval_request:${request.id}`,
    },
  };
}

async function runDelegatedTemplate(context, args, delegation, callContext = {}) {
  const repoPath = delegation.repoPath || context.cwd;
  const { templatePath } = resolveTemplatePath(repoPath, args);
  const def = loadTemplate(templatePath);
  let manifestPath = args.manifest_path ?? args.manifestPath
    ? resolveRepoRelative(repoPath, args.manifest_path ?? args.manifestPath, 'manifest_path')
    : resolve(repoPath, '.guardrail', 'templates', `${def.name}.approved.json`);
  let delegatedApproval = {
    allowed: true,
    actor: context.agent,
    grantHash: context.grantState.hash,
    templateHash: delegation.templateHash,
    tool: 'guardrail_run_template',
    reason: 'guardrail_mcp_delegated_grant',
  };
  if (delegation.approvalMode === 'approval_request') {
    const approvedRequest = validateApprovedTemplateRequest(context, args, delegation, repoPath);
    if (!approvedRequest.ok) {
      return errorResult('approval_request_denied', approvedRequest.reason, {
        tool: 'guardrail_run_template',
        approvalRequestId: delegation.approvalRequestId,
        correction: {
          expected: 'Call guardrail_template_request_approval, have a human approve it with guardrail approve, then retry with the same inputs and approval_request_id.',
          stateDir: approvedRequest.stateDir,
        },
      });
    }
    delegatedApproval = approvedRequest.delegatedApproval;
    manifestPath = approvedRequest.manifestPath;
  } else if (delegation.approvalMode === 'host_elicitation') {
    const prepared = prepareTemplate(repoPath, args);
    if (!prepared.ok) {
      return errorResult(prepared.code || 'template_prepare_failed', 'Template preparation failed before host approval.', {
        tool: 'guardrail_run_template',
        approvalMode: 'host_elicitation',
        prepared,
      });
    }
    const subject = templateHostApprovalSubject(context, repoPath, prepared, args);
    const hostApproval = await requestHostApproval(callContext, subject);
    if (!hostApproval.ok) {
      return errorResult(hostApproval.code, hostApproval.reason, {
        tool: 'guardrail_run_template',
        approvalMode: 'host_elicitation',
        approvalSubject: hostApproval.subject,
        correction: {
          expected: 'Use an MCP host with form elicitation support and approve the exact host prompt, or use guardrail_template_request_approval plus approval_request_id as the CLI fallback.',
        },
      });
    }
    delegatedApproval = {
      allowed: true,
      actor: 'mcp_host_elicitation',
      grantHash: context.grantState.hash,
      templateHash: prepared.template.templateHash,
      tool: 'guardrail_run_template',
      reason: `guardrail_mcp_host_elicitation:${subject.approval_subject_hash}`,
    };
    manifestPath = prepared.approval.manifestPath;
  }
  const result = await runTemplateSupervisor({
    templatePath,
    inputs: args.inputs || {},
    manifestPath,
    cwd: repoPath,
    nonInteractive: true,
    jsonOutput: true,
    envAllow: toStringArray(args.env_allow ?? args.envAllow),
    delegatedApproval,
  });
  audit(context, 'mcp_tool_completed', {
    tool: 'guardrail_run_template',
    status: result.status,
    repoPath: delegation.repoPath,
    manifestPath: result.manifestPath ?? manifestPath,
  });
  return jsonText({ ok: result.status === 'success', result });
}

export function createGuardrailMcpRuntime(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const grantState = options.grantState ?? loadDelegatedGrant(options.grantPath, {
    cwd,
  });
  const context = {
    cwd,
    agent: options.agent || process.env.GUARDRAIL_MCP_AGENT || 'unknown',
    grantState,
    auditPath: options.auditPath || resolve(cwd, '.guardrail', 'mcp-audit.jsonl'),
    approvalStateDir: options.approvalStateDir,
    serviceRegistry: createServiceRegistry(serviceDefinitionsFromGrant(grantState)),
  };

  async function callTool(name, args = {}, callContext = {}) {
    if (name === 'guardrail_grant_status') {
      return jsonText({ ok: true, grant: describeDelegatedGrant(grantState), server: { cwd, agent: context.agent } });
    }
    const delegation = checkDelegation(context, name, args || {});
    if (!delegation.allowed) return denied(context, name, delegation);

    try {
      if (name === 'guardrail_recipe_describe') return jsonText(describeRecipes(delegation.repoPath || cwd, args || {}));
      if (name === 'guardrail_recipe_prepare') return jsonText(prepareRecipe(delegation.repoPath || cwd, args || {}, delegation));
      if (name === 'guardrail_recipe_request_approval') return jsonText(createRecipeApprovalRequest(context, delegation.repoPath || cwd, args || {}, delegation));
      if (name === 'guardrail_run_recipe') {
        return await runDelegatedRecipe(context, name, args, delegation, callContext);
      }
      if (name === 'guardrail_template_describe') return jsonText(describeTemplates(delegation.repoPath || cwd, args || {}));
      if (name === 'guardrail_template_prepare') return jsonText(prepareTemplate(delegation.repoPath || cwd, args || {}));
      if (name === 'guardrail_template_request_approval') return jsonText(createTemplateApprovalRequest(context, delegation.repoPath || cwd, args || {}));
      if (name === 'guardrail_run_template') return await runDelegatedTemplate(context, args || {}, delegation, callContext);
      if (name === 'guardrail_template') {
        const normalized = normalizeTemplateParentArgs(args || {});
        if (!normalized.ok) {
          return errorResult(normalized.code, normalized.message, {
            tool: name,
            action: args?.action ?? null,
            correction: {
              expected: 'Call guardrail_template with action describe, prepare, request_approval, or run, using only the fields shown for that action in tools/list.',
              unexpected: normalized.unexpected,
            },
          });
        }
        if (normalized.action === 'describe') return jsonText(describeTemplates(delegation.repoPath || cwd, normalized.args));
        if (normalized.action === 'prepare') return jsonText(prepareTemplate(delegation.repoPath || cwd, normalized.args));
        if (normalized.action === 'request_approval') return jsonText(createTemplateApprovalRequest(context, delegation.repoPath || cwd, normalized.args));
        if (normalized.action === 'run') return await runDelegatedTemplate(context, normalized.args, delegation, callContext);
      }
      if (name === 'guardrail_service_start') {
        const serviceId = args.service_id ?? args.serviceId;
        const def = serviceDefinitionsFromGrant(grantState).find((entry) => entry.id === serviceId);
        const result = await context.serviceRegistry.startService(def);
        audit(context, 'mcp_tool_completed', { tool: name, status: result.success ? 'success' : 'failed', reason: result.error, serviceId });
        return jsonText({ ok: result.success, result });
      }
      if (name === 'guardrail_service_stop') {
        const serviceId = args.service_id ?? args.serviceId;
        const result = await context.serviceRegistry.stopService(serviceId);
        audit(context, 'mcp_tool_completed', { tool: name, status: result.success ? 'success' : 'failed', reason: result.error, serviceId });
        return jsonText({ ok: result.success, result });
      }
      if (name === 'guardrail_service_status') {
        const serviceId = args.service_id ?? args.serviceId;
        return jsonText({ ok: true, result: { serviceId, running: context.serviceRegistry.isRunning(serviceId), handle: context.serviceRegistry.getService(serviceId) } });
      }
      if (name === 'guardrail_http_request') return jsonText({ ok: true, result: await performHttpRequest(delegation, args || {}) });
      return errorResult('unknown_tool', `Unknown tool: ${name}`, {
        correction: {
          expected: 'Call tools/list or guardrail_grant_status and use one of the advertised Guardrail MCP tools.',
        },
      });
    } catch (err) {
      audit(context, 'mcp_tool_failed', { tool: name, status: 'failed', reason: err.message });
      return errorResult('tool_failed', err.message, {
        tool: name,
        correction: {
          expected: 'Fix the reported tool failure while staying inside the active grant. If the required action is not granted, stop and ask for a new grant.',
        },
      });
    }
  }

  return {
    context,
    listTools: listGuardrailMcpTools,
    callTool,
    async close() {
      await context.serviceRegistry.cleanupAll();
    },
  };
}
