import {
  buildSessionContract,
  loadSessionContract,
  saveSessionContract,
  defaultSessionContractPath,
  compareSessionContracts,
  VALID_SESSION_LIFECYCLES,
} from './agent-session.js';
import { evaluateSessionLifecycle } from './agent-session-lifecycle.js';

// ---------------------------------------------------------------------------
// Recipe-supervisor integration for agent session contracts
// ---------------------------------------------------------------------------
//
// These helpers are invoked from `src/recipe-supervisor.js` ONLY when a
// session-capable recipe (claude-exec / codex-exec) is running with a
// declared `lifecycle` input. When the recipe does not declare a lifecycle,
// all helpers short-circuit so the existing recipe-manifest flow is
// untouched. The recipe-manifest drift check still runs in addition to this
// contract enforcement — session contracts constrain identity, not content.

const SESSION_CAPABLE_RECIPES = {
  'claude-exec': 'claude',
  'codex-exec': 'codex',
};

/**
 * Parse a comma-separated add_dirs string (the shape the wrappers accept)
 * into a trimmed, non-empty array. Arrays pass through unchanged.
 */
function normalizeAddDirsInput(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.filter(v => typeof v === 'string' && v.trim() !== '');
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/**
 * Decide whether session-contract enforcement applies. Returns `null` when
 * enforcement should be skipped. This is intentionally defensive — if the
 * recipe is not one of the known session-capable wrappers, or the recipe
 * does not pass a `lifecycle` input, enforcement is off.
 */
export function resolveSessionEnforcementTool(recipe, resolvedInputs) {
  if (!recipe || typeof recipe !== 'object') return null;
  const tool = SESSION_CAPABLE_RECIPES[recipe.id];
  if (!tool) return null;
  const lifecycle = resolvedInputs?.lifecycle;
  if (typeof lifecycle !== 'string' || !VALID_SESSION_LIFECYCLES.has(lifecycle)) return null;
  return tool;
}

/**
 * Build a candidate session contract from a recipe + resolved inputs.
 * Throws on validation errors, letting the caller convert them into the
 * usual fail-closed supervisor branch.
 */
export function buildCandidateSessionContract(recipe, resolvedInputs, resolvedCwd, recipeVersion) {
  const tool = resolveSessionEnforcementTool(recipe, resolvedInputs);
  if (!tool) return null;

  const workingDirInput = resolvedInputs.working_dir;
  const baseWorkingDir = (typeof workingDirInput === 'string' && workingDirInput.trim() !== '')
    ? workingDirInput
    : resolvedCwd;

  const addDirs = normalizeAddDirsInput(resolvedInputs.add_dirs);

  return buildSessionContract({
    tool,
    recipeId: recipe.id,
    recipeVersion,
    workingDir: baseWorkingDir,
    addDirs,
    sessionName: resolvedInputs.session_name ?? null,
    sessionId: resolvedInputs.session_id ?? null,
    lifecycle: resolvedInputs.lifecycle,
  });
}

/**
 * Pre-execution check. Loads the on-disk session contract (if any), runs
 * `evaluateSessionLifecycle`, and also reports whether the candidate differs
 * from the approved identity fields (so the caller can treat it as drift and
 * fall back to the existing approval flow).
 *
 * Return shape:
 *   {
 *     enforced: true,
 *     contractPath,
 *     candidate,
 *     approved,
 *     evaluation: { ok, code?, reason?, diffs? },
 *     drift: boolean,
 *   }
 * or { enforced: false } when enforcement does not apply.
 */
export function prepareSessionEnforcement({
  recipe,
  resolvedInputs,
  resolvedCwd,
  recipeVersion,
  stateDir,
}) {
  const tool = resolveSessionEnforcementTool(recipe, resolvedInputs);
  if (!tool) return { enforced: false };

  const candidate = buildCandidateSessionContract(
    recipe,
    resolvedInputs,
    resolvedCwd,
    recipeVersion,
  );
  const contractPath = defaultSessionContractPath(
    stateDir,
    recipe.id,
    candidate.sessionName,
  );

  let approved = null;
  let loadError = null;
  try {
    approved = loadSessionContract(contractPath);
  } catch (err) {
    loadError = err.message || String(err);
  }

  if (loadError) {
    return {
      enforced: true,
      contractPath,
      candidate,
      approved: null,
      evaluation: {
        ok: false,
        code: 'session_drift',
        reason: `session contract load failed: ${loadError}`,
      },
      drift: true,
    };
  }

  const evaluation = evaluateSessionLifecycle(candidate, approved, candidate.lifecycle);
  const drift = approved !== null && !compareSessionContracts(candidate, approved).matches;

  return {
    enforced: true,
    contractPath,
    candidate,
    approved,
    evaluation,
    drift,
  };
}

/**
 * Persist the candidate session contract after successful execution. Safe
 * to call even when enforcement is off (no-op). Never throws — persistence
 * failures surface as `{ persisted: false, error }` so the caller can log
 * them without breaking the recipe-supervisor success path.
 */
export function persistSessionContractAfterSuccess(preparation) {
  if (!preparation || !preparation.enforced) return { persisted: false, skipped: true };
  try {
    const stored = saveSessionContract(preparation.candidate, preparation.contractPath);
    return { persisted: true, stored };
  } catch (err) {
    return { persisted: false, error: err.message || String(err) };
  }
}
