import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sovereignMeta } from './shared.js';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const EVENT_TYPES = new Set([
  'execution_start', 'execution_end', 'execution_failed', 'execution_aborted',
  'approval_granted', 'approval_denied', 'approval_required',
  'violation_detected', 'policy_violation', 'resource_exceeded',
  'recipe_blocked', 'recipe_executed',
  'drift_detected', 'manifest_saved',
  'step_completed', 'step_failed', 'step_blocked',
  'rollback_start', 'rollback_end',
  'lock_acquired', 'lock_released', 'lock_blocked',
]);

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

/**
 * Create a metrics collector.
 *
 * @param {string} logDir - Directory for metrics log files.
 * @returns {object} Metrics interface.
 */
export function createMetricsCollector(logDir) {
  const metricsPath = join(resolve(logDir), 'metrics.jsonl');
  if (!existsSync(resolve(logDir))) mkdirSync(resolve(logDir), { recursive: true });

  function emit(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      event:     event.type,
      actor:     event.actor ?? null,
      origin:    event.origin ?? 'cli',
      recipe_id: event.recipeId ?? null,
      trace_id:  event.traceId ?? null,
      details:   event.details ?? {},
      ...sovereignMeta(event.provenance),
    };
    appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  return { emit, path: metricsPath };
}

// ---------------------------------------------------------------------------
// Metrics aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate metrics from a metrics log file.
 *
 * @param {string} metricsPath - Path to metrics.jsonl.
 * @returns {object} Aggregated metrics.
 */
export function aggregateMetrics(metricsPath) {
  if (!existsSync(metricsPath)) {
    return { totalEvents: 0, byType: {}, byActor: {}, byRecipe: {}, recentEvents: [] };
  }

  const content = readFileSync(metricsPath, 'utf8').trim();
  if (!content) {
    return { totalEvents: 0, byType: {}, byActor: {}, byRecipe: {}, recentEvents: [] };
  }

  const entries = content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  const byType = {};
  const byActor = {};
  const byRecipe = {};

  for (const e of entries) {
    byType[e.event] = (byType[e.event] || 0) + 1;
    if (e.actor) byActor[e.actor] = (byActor[e.actor] || 0) + 1;
    if (e.recipe_id) byRecipe[e.recipe_id] = (byRecipe[e.recipe_id] || 0) + 1;
  }

  return {
    totalEvents: entries.length,
    byType,
    byActor,
    byRecipe,
    recentEvents: entries.slice(-20),
  };
}

/**
 * Format metrics for display.
 */
export function formatMetrics(metrics) {
  const lines = [];
  lines.push(`Total events: ${metrics.totalEvents}`);

  if (Object.keys(metrics.byType).length > 0) {
    lines.push('\nBy type:');
    for (const [type, count] of Object.entries(metrics.byType).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type.padEnd(30)} ${count}`);
    }
  }

  if (Object.keys(metrics.byActor).length > 0) {
    lines.push('\nBy actor:');
    for (const [actor, count] of Object.entries(metrics.byActor).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${actor.padEnd(30)} ${count}`);
    }
  }

  if (Object.keys(metrics.byRecipe).length > 0) {
    lines.push('\nBy recipe:');
    for (const [recipe, count] of Object.entries(metrics.byRecipe).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${recipe.padEnd(30)} ${count}`);
    }
  }

  return lines.join('\n');
}
