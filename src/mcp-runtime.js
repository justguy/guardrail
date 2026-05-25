import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { appendEntry } from './audit.js';
import { getRepoStatusSummary } from './repo-status.js';
import { runRecipeSupervisor } from './recipe-supervisor.js';
import { createServiceRegistry } from './service-registry.js';
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

function runGitDiff(repoPath, decisionResult, args = {}) {
  const maxBytes = decisionResult.maxBytes;
  const gitArgs = ['-C', repoPath, 'diff'];
  if (args.cached) gitArgs.push('--cached');
  if (args.stat) gitArgs.push('--stat');
  if (Array.isArray(args.paths) && args.paths.length > 0) gitArgs.push('--', ...args.paths.map(String));
  const result = spawnSync('git', gitArgs, { encoding: 'utf8', maxBuffer: Math.max(maxBytes * 2, 1024 * 1024) });
  const stdout = result.stdout || '';
  const output = Buffer.byteLength(stdout) > maxBytes
    ? Buffer.from(stdout).subarray(0, maxBytes).toString('utf8')
    : stdout;
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: output,
    stderr: (result.stderr || '').slice(0, 4096),
    truncated: Buffer.byteLength(stdout) > maxBytes,
  };
}

function recipeInputsForTool(toolName, args) {
  if (toolName === 'guardrail_git_commit') {
    return {
      guardrail_repo: '.',
      repo_path: args.repo_path ?? args.repoPath ?? '.',
      paths: Array.isArray(args.paths) ? args.paths : [],
      message_file: args.message_file ?? args.messageFile,
    };
  }
  if (toolName === 'guardrail_git_push_feature_branch') {
    return { repo_path: args.repo_path ?? args.repoPath ?? '.', remote: args.remote ?? 'origin', branch: args.branch };
  }
  return args.inputs || {};
}

function recipeNameForTool(toolName, args) {
  if (toolName === 'guardrail_git_commit') return 'git-commit';
  if (toolName === 'guardrail_git_push_feature_branch') return 'git-push';
  return args.recipe;
}

async function runDelegatedRecipe(context, toolName, args, delegation) {
  const recipe = recipeNameForTool(toolName, args);
  const result = await runRecipeSupervisor({
    specifier: recipe,
    inputs: recipeInputsForTool(toolName, args),
    cwd: delegation.repoPath || context.cwd,
    searchDirs: [resolve(delegation.repoPath || context.cwd, 'recipes')],
    manifestPath: args.manifest_path ?? args.manifestPath ?? null,
    nonInteractive: true,
    jsonOutput: true,
    allowUnverified: delegation.allowUnverified === true || args.allow_unverified === true || args.allowUnverified === true,
    delegatedApproval: {
      allowed: true,
      actor: context.agent,
      grantHash: context.grantState.hash,
      recipeHash: delegation.recipeHash,
      tool: toolName,
      reason: 'guardrail_mcp_delegated_grant',
    },
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

export function createGuardrailMcpRuntime(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const grantState = options.grantState ?? loadDelegatedGrant(options.grantPath, { cwd });
  const context = {
    cwd,
    agent: options.agent || process.env.GUARDRAIL_MCP_AGENT || 'unknown',
    grantState,
    auditPath: options.auditPath || resolve(cwd, '.guardrail', 'mcp-audit.jsonl'),
    serviceRegistry: createServiceRegistry(serviceDefinitionsFromGrant(grantState)),
  };

  async function callTool(name, args = {}) {
    if (name === 'guardrail_grant_status') {
      return jsonText({ ok: true, grant: describeDelegatedGrant(grantState), server: { cwd, agent: context.agent } });
    }
    const delegation = checkDelegation(context, name, args || {});
    if (!delegation.allowed) return denied(context, name, delegation);

    try {
      if (name === 'guardrail_run_recipe' || name === 'guardrail_git_commit' || name === 'guardrail_git_push_feature_branch') {
        return await runDelegatedRecipe(context, name, args, delegation);
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
      if (name === 'guardrail_git_status') return jsonText({ ok: true, result: getRepoStatusSummary(delegation.repoPath || args.repo_path || '.') });
      if (name === 'guardrail_git_diff') return jsonText({ ok: true, result: runGitDiff(delegation.repoPath || args.repo_path || '.', delegation, args) });
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
