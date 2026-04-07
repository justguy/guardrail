// ---------------------------------------------------------------------------
// Learning Mode — step-by-step explanation engine
// ---------------------------------------------------------------------------

const RISK_EXPLANATIONS = {
  low:    'This action is low-risk. It reads data or makes local changes only.',
  medium: 'This action is medium-risk. It may modify files or install packages.',
  high:   'This action is HIGH-RISK. It may affect production, delete data, or access secrets.',
};

/**
 * Create a learning mode context.
 *
 * @param {{ enabled: boolean, skipExplanations: boolean }} opts
 * @returns {object} Learning mode interface.
 */
export function createLearningMode(opts = {}) {
  const enabled = opts.enabled ?? false;
  const skipExplanations = opts.skipExplanations ?? false;

  /**
   * Explain a step before execution.
   * Returns the explanation text (caller decides whether to print/pause).
   */
  function explainStep(step, context = {}) {
    if (!enabled) return null;

    const lines = [];
    lines.push(`\n  LEARNING MODE — Step: "${step.id || step.description || 'unknown'}"`);
    lines.push('  ─'.repeat(28));

    // What will happen
    lines.push('  What will happen:');
    if (step.run?.command) {
      const cmd = [step.run.command, ...(step.run.args || [])].join(' ');
      lines.push(`    Command: ${cmd}`);
    }
    if (step.description) {
      lines.push(`    Purpose: ${step.description}`);
    }

    // Why it is safe
    lines.push('  Why it is safe:');
    const mode = step.run?.mode || 'structured';
    if (mode === 'structured') {
      lines.push('    - Runs in structured mode (no shell injection possible)');
    }
    if (context.scopeRestricted) {
      lines.push('    - File scope restricted to project directory');
    }
    if (context.approved) {
      lines.push('    - This action was previously approved via manifest');
    }
    if (!context.hasSecrets) {
      lines.push('    - No secret env vars are being passed');
    }

    // What could go wrong
    lines.push('  What could go wrong:');
    if (context.riskLevel === 'high') {
      lines.push('    - This step modifies external state that may be hard to reverse');
    } else if (context.riskLevel === 'medium') {
      lines.push('    - This step modifies local files; changes may need manual rollback');
    } else {
      lines.push('    - This step is read-only; no side effects expected');
    }

    if (context.riskLevel) {
      lines.push(`  Risk: ${RISK_EXPLANATIONS[context.riskLevel] || context.riskLevel}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Explain a recipe before execution.
   */
  function explainRecipe(recipe) {
    if (!enabled) return null;

    const lines = [];
    lines.push(`\n  LEARNING MODE — Recipe: "${recipe.name}"`);
    lines.push('  ─'.repeat(28));
    lines.push(`  ID:          ${recipe.id}`);
    lines.push(`  Version:     ${recipe.version}`);
    lines.push(`  Risk:        ${RISK_EXPLANATIONS[recipe.risk_level] || recipe.risk_level}`);
    lines.push(`  Approval:    ${recipe.approval_required ? 'Required before execution' : 'Not required'}`);
    lines.push(`  Steps:       ${recipe.steps?.length || 0}`);

    if (recipe.guardrails?.constraints?.length) {
      lines.push('  Constraints:');
      for (const c of recipe.guardrails.constraints) {
        lines.push(`    - ${c}`);
      }
    }
    if (recipe.guardrails?.invariants?.length) {
      lines.push('  Invariants (must always hold):');
      for (const inv of recipe.guardrails.invariants) {
        lines.push(`    - ${inv}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Explain why an action was blocked.
   */
  function explainBlock(reason, context = {}) {
    if (!enabled) return null;

    const lines = [];
    lines.push(`\n  LEARNING MODE — Action Blocked`);
    lines.push('  ─'.repeat(28));
    lines.push(`  Reason: ${reason}`);

    if (context.suggestion) {
      lines.push(`  Suggestion: ${context.suggestion}`);
    }

    lines.push('  Guardrail blocks unsafe actions by default. This is intentional.');
    lines.push('  To proceed, address the issue above or use --force with caution.');
    lines.push('');
    return lines.join('\n');
  }

  return {
    enabled,
    skipExplanations,
    explainStep,
    explainRecipe,
    explainBlock,
  };
}
