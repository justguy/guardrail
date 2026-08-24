import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Approval Queue — centralized approval with multi-stage chains
// ---------------------------------------------------------------------------

const APPROVAL_STATES = new Set(['pending', 'approved', 'rejected', 'changes_requested', 'expired']);

/**
 * Create an approval request.
 */
export function createApprovalRequest(opts) {
  return {
    id:            opts.id || randomBytes(8).toString('hex'),
    status:        'pending',
    recipe_id:     opts.recipeId ?? null,
    template_name: opts.templateName ?? null,
    kind:          opts.kind ?? 'generic',
    tool:          opts.tool ?? null,
    agent:         opts.agent ?? null,
    repo_path:     opts.repoPath ?? null,
    command:       opts.command ?? null,
    risk_level:    opts.riskLevel ?? 'medium',
    requester:     opts.requester ?? 'unknown',
    execution_plan: opts.executionPlan ?? [],
    diff_preview:  opts.diffPreview ?? null,
    payload:       opts.payload ?? null,
    expires_at:    opts.expiresAt ?? null,
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    approvals:     [],
    chain:         opts.chain ?? null,  // Multi-stage: { stages: ['dev', 'lead', 'security'], current: 0 }
    history:       [],
  };
}

/**
 * Approve a request. Advances the chain if multi-stage.
 */
export function approveRequest(request, approver) {
  if (request.status !== 'pending') {
    return { success: false, reason: `Cannot approve: status is "${request.status}"` };
  }

  request.approvals.push({ approver, action: 'approved', at: new Date().toISOString() });
  request.history.push({ action: 'approved', by: approver, at: new Date().toISOString() });
  request.updated_at = new Date().toISOString();

  // Multi-stage chain
  if (request.chain) {
    request.chain.current += 1;
    if (request.chain.current < request.chain.stages.length) {
      // More stages needed
      return { success: true, status: 'pending', nextStage: request.chain.stages[request.chain.current] };
    }
  }

  request.status = 'approved';
  return { success: true, status: 'approved' };
}

/**
 * Reject a request.
 */
export function rejectRequest(request, rejector, reason) {
  if (request.status !== 'pending') {
    return { success: false, reason: `Cannot reject: status is "${request.status}"` };
  }
  request.status = 'rejected';
  request.history.push({ action: 'rejected', by: rejector, reason, at: new Date().toISOString() });
  request.updated_at = new Date().toISOString();
  return { success: true, status: 'rejected' };
}

/**
 * Request changes on a pending request.
 */
export function requestChanges(request, reviewer, feedback) {
  if (request.status !== 'pending') {
    return { success: false, reason: `Cannot request changes: status is "${request.status}"` };
  }
  request.status = 'changes_requested';
  request.history.push({ action: 'changes_requested', by: reviewer, feedback, at: new Date().toISOString() });
  request.updated_at = new Date().toISOString();
  return { success: true, status: 'changes_requested' };
}

// ---------------------------------------------------------------------------
// Queue persistence
// ---------------------------------------------------------------------------

function queueDir(stateDir) {
  return resolve(stateDir, 'approval-queue');
}

export function saveRequest(request, stateDir) {
  const dir = queueDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${request.id}.json`);
  writeFileSync(path, JSON.stringify(request, null, 2) + '\n', 'utf8');
  return path;
}

export function loadRequest(id, stateDir) {
  const path = join(queueDir(stateDir), `${id}.json`);
  if (!existsSync(path)) throw new Error(`Approval request "${id}" not found`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function listRequests(stateDir, filter = {}) {
  const dir = queueDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .filter(r => !filter.status || r.status === filter.status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ---------------------------------------------------------------------------
// Multi-stage approval chain
// ---------------------------------------------------------------------------

/**
 * Create a multi-stage approval chain.
 * @param {string[]} stages - Ordered stage names (e.g. ['dev', 'lead', 'security']).
 */
export function createApprovalChain(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('Approval chain requires at least one stage');
  }
  return { stages, current: 0 };
}

/**
 * Check if a multi-stage chain is fully approved.
 */
export function isChainComplete(chain) {
  if (!chain) return true;
  return chain.current >= chain.stages.length;
}

/**
 * Get the current stage of a chain.
 */
export function currentStage(chain) {
  if (!chain || chain.current >= chain.stages.length) return null;
  return chain.stages[chain.current];
}

/**
 * Format an approval request for display.
 */
export function formatRequest(req) {
  const lines = [];
  lines.push(`[${req.id}] ${req.status.toUpperCase()} — ${req.recipe_id || req.template_name || req.command || 'unknown'}`);
  lines.push(`  Risk: ${req.risk_level}  Requester: ${req.requester}  Created: ${req.created_at}`);
  if (req.kind && req.kind !== 'generic') lines.push(`  Kind: ${req.kind}`);
  if (req.tool) lines.push(`  Tool: ${req.tool}`);
  if (req.repo_path) lines.push(`  Repo: ${req.repo_path}`);
  if (req.expires_at) lines.push(`  Expires: ${req.expires_at}`);
  if (req.chain) {
    const stage = currentStage(req.chain) || 'complete';
    lines.push(`  Chain: ${req.chain.stages.join(' → ')}  Current: ${stage}`);
  }
  if (req.approvals.length > 0) {
    lines.push(`  Approvals: ${req.approvals.map(a => a.approver).join(', ')}`);
  }
  return lines.join('\n');
}
