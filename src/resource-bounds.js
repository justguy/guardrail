// ---------------------------------------------------------------------------
// Resource Bounds — runtime constraint enforcement
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ResourceBounds
 * @property {number|null} max_execution_time  - Max wall-clock time in ms.
 * @property {number|null} max_files_touched   - Max file operations allowed.
 * @property {number|null} max_network_calls   - Max outbound network calls.
 * @property {number|null} max_cost            - Max cost units (abstract).
 */

const VALID_BOUND_KEYS = new Set(['max_execution_time', 'max_files_touched', 'max_network_calls', 'max_cost']);

/**
 * Validate a resource bounds object.
 * @param {object} bounds
 * @returns {string[]} Error messages (empty = valid).
 */
export function validateBounds(bounds) {
  const errors = [];
  if (!bounds || typeof bounds !== 'object') return ['bounds must be an object'];

  for (const [key, value] of Object.entries(bounds)) {
    if (!VALID_BOUND_KEYS.has(key)) {
      errors.push(`Unknown bound: "${key}"`);
      continue;
    }
    if (value !== null && (typeof value !== 'number' || value <= 0 || !Number.isFinite(value))) {
      errors.push(`${key} must be a positive number or null, got ${JSON.stringify(value)}`);
    }
  }
  return errors;
}

/**
 * Create a runtime resource tracker.
 *
 * @param {ResourceBounds} bounds - The limits to enforce.
 * @returns {object} Tracker with check/record/status methods.
 */
export function createResourceTracker(bounds = {}) {
  const startTime = Date.now();
  let filesTouched = 0;
  let networkCalls = 0;
  let costAccrued = 0;
  const violations = [];

  function check() {
    if (bounds.max_execution_time != null) {
      const elapsed = Date.now() - startTime;
      if (elapsed > bounds.max_execution_time) {
        violations.push({ bound: 'max_execution_time', limit: bounds.max_execution_time, actual: elapsed, message: `Execution time exceeded: ${elapsed}ms > ${bounds.max_execution_time}ms` });
      }
    }
    if (bounds.max_files_touched != null && filesTouched > bounds.max_files_touched) {
      violations.push({ bound: 'max_files_touched', limit: bounds.max_files_touched, actual: filesTouched, message: `Files touched exceeded: ${filesTouched} > ${bounds.max_files_touched}` });
    }
    if (bounds.max_network_calls != null && networkCalls > bounds.max_network_calls) {
      violations.push({ bound: 'max_network_calls', limit: bounds.max_network_calls, actual: networkCalls, message: `Network calls exceeded: ${networkCalls} > ${bounds.max_network_calls}` });
    }
    if (bounds.max_cost != null && costAccrued > bounds.max_cost) {
      violations.push({ bound: 'max_cost', limit: bounds.max_cost, actual: costAccrued, message: `Cost exceeded: ${costAccrued} > ${bounds.max_cost}` });
    }
    return violations.length === 0;
  }

  function recordFile()    { filesTouched++; }
  function recordNetwork() { networkCalls++; }
  function recordCost(n)   { costAccrued += n; }

  function status() {
    return {
      elapsed:      Date.now() - startTime,
      filesTouched,
      networkCalls,
      costAccrued,
      withinBounds: violations.length === 0,
      violations,
    };
  }

  return { check, recordFile, recordNetwork, recordCost, status };
}

/**
 * Parse CLI flags into a ResourceBounds object.
 *
 * @param {object} flags - { maxTime, maxFiles, maxNetwork, maxCost }
 * @returns {ResourceBounds}
 */
export function boundsFromFlags(flags = {}) {
  return {
    max_execution_time: flags.maxTime ? Number(flags.maxTime) : null,
    max_files_touched:  flags.maxFiles ? Number(flags.maxFiles) : null,
    max_network_calls:  flags.maxNetwork ? Number(flags.maxNetwork) : null,
    max_cost:           flags.maxCost ? Number(flags.maxCost) : null,
  };
}
