// ---------------------------------------------------------------------------
// Risk Trait Taxonomy — capability-aware risk classification
// ---------------------------------------------------------------------------

/**
 * Every risk trait has a severity and a human-readable capability description.
 * Capabilities are shown to users ("New capability requested: ...").
 * null capability = always block (no approvable capability).
 */
export const RISK_TRAITS = {
  // -- Execution shape --
  execution_chaining:   { severity: 'high',     capability: 'Execute multiple commands (chaining)' },
  command_substitution: { severity: 'high',     capability: 'Inject dynamic command output' },
  io_redirection:       { severity: 'medium',   capability: 'Redirect I/O to filesystem or pipe' },

  // -- Scope --
  scope_widening:       { severity: 'high',     capability: 'Expand file/target scope' },
  path_escape_attempt:  { severity: 'critical', capability: null },
  recursive_flag:       { severity: 'medium',   capability: 'Expand blast radius (recursive/global)' },

  // -- Target --
  prod_target_reference:{ severity: 'high',     capability: 'Target production environment' },
  secret_reference:     { severity: 'high',     capability: 'Access secrets or credentials' },

  // -- Cardinality --
  high_cardinality_input:{ severity: 'medium',  capability: 'Operate on broad target set' },
  unbounded_pattern:    { severity: 'medium',   capability: 'Match files with broad glob' },

  // -- Text --
  free_text_instruction:{ severity: 'medium',   capability: 'Provide free-form instructions' },
  destructive_intent:   { severity: 'high',     capability: 'Perform destructive action' },

  // -- Structure --
  unsupported_structure:{ severity: 'critical', capability: null },
  mode_transition:      { severity: 'critical', capability: null },

  // -- Limits --
  exceeds_hard_limit:   { severity: 'critical', capability: null },

  // -- Composite (emitted by escalation) --
  amplified_scope_risk: { severity: 'high',     capability: 'Broad scope combined with high cardinality or destructive action' },
};

// ---------------------------------------------------------------------------
// Bucket classification
// ---------------------------------------------------------------------------

/**
 * Classify risk traits into an action bucket.
 *
 * @param {string[]} traits - Array of trait names.
 * @returns {'allow' | 'flag' | 'block'}
 */
export function classifyBucket(traits) {
  if (!traits || traits.length === 0) return 'allow';
  if (traits.some(t => RISK_TRAITS[t]?.severity === 'critical')) return 'block';
  return 'flag';
}

// ---------------------------------------------------------------------------
// Capability summary (human-readable, for UX)
// ---------------------------------------------------------------------------

/**
 * Extract human-readable capability descriptions from traits.
 *
 * @param {string[]} traits
 * @returns {string[]} Capability descriptions (nulls filtered).
 */
export function summarizeCapabilities(traits) {
  return traits
    .map(t => RISK_TRAITS[t]?.capability)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cross-parameter escalation
// ---------------------------------------------------------------------------

/**
 * Check for dangerous trait combinations and add composite traits.
 *
 * @param {string[]} traits - All traits across all parameters.
 * @returns {string[]} Traits with composites appended.
 */
export function escalateTraits(traits) {
  const out = [...new Set(traits)];

  const has = (t) => out.includes(t);

  if (has('scope_widening') && has('high_cardinality_input') && !has('amplified_scope_risk'))
    out.push('amplified_scope_risk');
  if (has('execution_chaining') && has('destructive_intent') && !has('amplified_scope_risk'))
    out.push('amplified_scope_risk');
  if (has('prod_target_reference') && has('recursive_flag') && !has('amplified_scope_risk'))
    out.push('amplified_scope_risk');
  if (has('secret_reference') && has('prod_target_reference') && !has('amplified_scope_risk'))
    out.push('amplified_scope_risk');

  return out;
}

// ---------------------------------------------------------------------------
// Execution shape checking
// ---------------------------------------------------------------------------

/**
 * Check parsed commands against an approved execution shape.
 *
 * @param {string[][]} parsedCommands - Array of command token arrays.
 * @param {object} [approvedShape]    - { type, max_commands, allowed_binaries }.
 * @returns {string[]} Additional traits to add.
 */
export function checkExecutionShape(parsedCommands, approvedShape) {
  if (!approvedShape) return [];
  const traits = [];

  if (approvedShape.type === 'single' && parsedCommands.length > 1)
    traits.push('execution_chaining');
  if (approvedShape.max_commands && parsedCommands.length > approvedShape.max_commands)
    traits.push('execution_chaining');
  if (approvedShape.allowed_binaries) {
    const allowed = new Set(approvedShape.allowed_binaries);
    for (const cmd of parsedCommands) {
      if (cmd.length > 0 && !allowed.has(cmd[0]))
        traits.push('scope_widening');
    }
  }

  return [...new Set(traits)];
}

// ---------------------------------------------------------------------------
// Hard limits
// ---------------------------------------------------------------------------

export const HARD_LIMITS = {
  max_string_length: 4096,
  max_list_items: 100,
  max_path_depth: 20,
  max_glob_star_count: 3,
};
