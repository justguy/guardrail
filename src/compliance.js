import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Compliance Exports — JSON + CSV reporting
// ---------------------------------------------------------------------------

/**
 * Export audit log entries in a compliance-ready format.
 *
 * @param {string} auditPath  - Path to audit.jsonl.
 * @param {object} opts       - { format: 'json'|'csv', after, before, types }.
 * @returns {string} Formatted export.
 */
export function exportAuditLog(auditPath, opts = {}) {
  const entries = loadEntries(auditPath, opts);
  if (opts.format === 'csv') return toCSV(entries);
  return JSON.stringify(entries, null, 2);
}

/**
 * Export policy history.
 */
export function exportPolicies(policyDir, opts = {}) {
  const entries = [];
  if (!existsSync(policyDir)) return opts.format === 'csv' ? '' : '[]';
  const files = readdirSync(policyDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const policy = JSON.parse(readFileSync(resolve(policyDir, f), 'utf8'));
      entries.push(policy);
    } catch { /* skip */ }
  }
  if (opts.format === 'csv') return toCSV(entries);
  return JSON.stringify(entries, null, 2);
}

/**
 * Generate a compliance summary report.
 */
export function generateReport(auditPath, opts = {}) {
  const entries = loadEntries(auditPath, {});
  const report = {
    generated_at: new Date().toISOString(),
    period: { from: opts.after ?? null, to: opts.before ?? null },
    total_events: entries.length,
    executions: entries.filter(e => e.event?.includes('execution')).length,
    approvals: entries.filter(e => e.event?.includes('approv')).length,
    violations: entries.filter(e => e.event?.includes('violation') || e.event?.includes('blocked')).length,
    unique_actors: [...new Set(entries.map(e => e.actor).filter(Boolean))],
    risk_summary: {
      high: entries.filter(e => e.details?.risk_level === 'high').length,
      medium: entries.filter(e => e.details?.risk_level === 'medium').length,
      low: entries.filter(e => e.details?.risk_level === 'low').length,
    },
    sovereign_summary: {
      organization_ids: [...new Set(entries.map(e => e.organization_id).filter(Boolean))],
      workspace_ids:    [...new Set(entries.map(e => e.workspace_id).filter(Boolean))],
      retention_classes: [...new Set(entries.map(e => e.retention_class).filter(Boolean))],
      sensitivity_labels: [...new Set(entries.map(e => e.sensitivity).filter(Boolean))],
      provenance_roots: [...new Set(entries.map(e => e.source_provenance?.root).filter(Boolean))],
    },
  };
  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEntries(auditPath, opts) {
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).filter(e => {
    if (opts.after && e.timestamp < opts.after) return false;
    if (opts.before && e.timestamp > opts.before) return false;
    if (opts.types && !opts.types.includes(e.event)) return false;
    return true;
  });
}

/**
 * Flatten an audit/metrics entry for CSV export.
 * Sovereign object fields (source_provenance) are expanded to dotted keys.
 */
function flattenEntry(e) {
  const flat = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'source_provenance' && v && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        flat[`source_provenance.${sk}`] = sv;
      }
    } else if (typeof v === 'object' && v !== null) {
      flat[k] = JSON.stringify(v);
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

function toCSV(entries) {
  if (entries.length === 0) return '';
  const flattened = entries.map(flattenEntry);
  const keys = [...new Set(flattened.flatMap(e => Object.keys(e)))];
  const header = keys.join(',');
  const rows = flattened.map(e => keys.map(k => {
    const v = e[k];
    if (v === undefined || v === null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','));
  return [header, ...rows].join('\n');
}

