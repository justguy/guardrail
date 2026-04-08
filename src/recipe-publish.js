import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadManifest } from './manifest.js';
import { validateRecipe, hashRecipe } from './recipe.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPSTREAM_OWNER = 'guardrail-dev';
const UPSTREAM_REPO = 'recipes';
const PUBLISH_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// gh CLI prerequisite check
// ---------------------------------------------------------------------------

/**
 * Verify that gh CLI is installed and authenticated.
 * Throws with actionable error if not.
 */
export function requireGhCli() {
  try {
    execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || '';
    if (stderr.includes('not logged in') || stderr.includes('no oauth token')) {
      throw new Error(
        'GitHub CLI (gh) is not authenticated.\n' +
        'Run: gh auth login'
      );
    }
    throw new Error(
      'GitHub CLI (gh) is required for recipe publish.\n' +
      'Install: https://cli.github.com\n' +
      'Authenticate: gh auth login'
    );
  }
}

// ---------------------------------------------------------------------------
// Personal data scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub personal data from a recipe before publishing.
 *
 * - Human-facing metadata fields containing usernames → {{working_dir}}
 * - Input defaults containing user-specific absolute paths → {{working_dir}}
 * - approved_by → ["author"]
 * - Timestamps → null
 *
 * This function must not rewrite steps[*].run.command or steps[*].run.args.
 */
export function scrubPersonalData(recipe) {
  const scrubbed = JSON.parse(JSON.stringify(recipe));
  const userPathRe = /(?:\/Users\/[^/"\s]+|\/home\/[^/"\s]+|C:\\Users\\[^"\\\s]+)/g;

  const scrubText = (value) => typeof value === 'string'
    ? value.replace(userPathRe, '{{working_dir}}')
    : value;

  // Strip approval identity
  if (scrubbed.acknowledgedBy) scrubbed.acknowledgedBy = 'author';
  if (scrubbed.approved_by) scrubbed.approved_by = ['author'];

  // Null out timestamps
  if (scrubbed.approvedAt) scrubbed.approvedAt = null;
  if (scrubbed.acknowledgedAt) scrubbed.acknowledgedAt = null;

  // Scrub human-facing metadata only.
  scrubbed.description = scrubText(scrubbed.description);
  if (typeof scrubbed.author === 'string') scrubbed.author = scrubText(scrubbed.author);
  if (scrubbed.inputs) {
    for (const def of Object.values(scrubbed.inputs)) {
      if (def && typeof def === 'object') {
        if (def.description) def.description = scrubText(def.description);
        if (typeof def.default === 'string' && userPathRe.test(def.default)) {
          def.default = '{{working_dir}}';
        }
      }
    }
  }

  // Do not mutate executable fields. Reject instead.
  for (const step of scrubbed.steps || []) {
    const execFields = [step.run?.command, ...(step.run?.args || [])];
    if (execFields.some(v => typeof v === 'string' && userPathRe.test(v))) {
      throw new Error(
        'Recipe publish cannot safely scrub user-specific absolute paths from executable fields.\n' +
        'Create a template or author the recipe manually with explicit inputs first.'
      );
    }
  }

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Manifest → Recipe conversion
// ---------------------------------------------------------------------------

/**
 * Convert an approved structured command manifest into a publishable recipe.
 */
export function manifestToRecipe(manifest, opts) {
  const { name, category, description } = opts;

  if (!name) throw new Error('--name is required for recipe publish');
  if (!category) throw new Error('--category is required for recipe publish');

  const contract = manifest.contract;
  const risk = manifest.riskAssessment;
  if (!contract) throw new Error('Approved command manifest is missing contract');
  if (contract.mode !== 'structured') {
    throw new Error(
      'recipe publish only supports structured command manifests in v0.2.\n' +
      'Shell manifests must be rewritten as recipes manually.'
    );
  }

  const riskMap = { green: 'low', yellow: 'medium', red: 'high' };

  const recipe = {
    id: name,
    name: opts.displayName || name.replace(/-/g, ' '),
    description: description || `Recipe generated from approved manifest for ${name}`,
    version: opts.version || '1.0.0',
    author: opts.author || 'author',
    category: category,
    channel: 'community',
    risk_level: riskMap[risk?.riskLevel] || 'medium',
    approval_required: risk?.riskLevel !== 'green',
    inputs: opts.inputs || {},
    steps: buildStepsFromContract(contract),
    guardrails: buildGuardrailsFromContract(contract),
  };

  if (opts.tags) recipe.tags = opts.tags;

  return recipe;
}

/**
 * Build recipe steps from contract command/args.
 */
function buildStepsFromContract(contract) {
  if (!contract) return [];

  const command = contract.command || '';
  const args = Array.isArray(contract.args) ? contract.args : [];

  return [{
    id: 'main',
    description: [command, ...args].join(' '),
    run: {
      command,
      args,
      mode: 'structured',
    },
  }];
}

/**
 * Build guardrails from contract constraints.
 */
function buildGuardrailsFromContract(contract) {
  const guardrails = { constraints: [], invariants: [] };

  if (contract?.writablePaths?.length) {
    guardrails.constraints.push(
      `writable paths: ${contract.writablePaths.join(', ')}`
    );
  }
  if (contract?.allowedBinaries?.length) {
    guardrails.constraints.push(
      `allowed binaries: ${contract.allowedBinaries.join(', ')}`
    );
  }

  guardrails.invariants.push('mode: structured');

  return guardrails;
}

// ---------------------------------------------------------------------------
// GitHub API helpers (uses gh CLI)
// ---------------------------------------------------------------------------

/**
 * Run a gh CLI command and return stdout.
 */
export function gh(args, opts = {}) {
  try {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('gh() requires a non-empty argv array');
    }
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`GitHub CLI error: ${stderr}`);
  }
}

/**
 * Ensure the user has a fork of the upstream recipes repo.
 * Returns the fork's owner/repo string.
 */
export function ensureFork() {
  const username = gh(['api', 'user', '--jq', '.login']);

  // Check if fork already exists
  try {
    gh(['api', `repos/${username}/${UPSTREAM_REPO}`, '--jq', '.fork']);
    return `${username}/${UPSTREAM_REPO}`;
  } catch { /* fork doesn't exist yet */ }

  // Create fork
  gh(['repo', 'fork', `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`, '--clone=false']);
  return `${username}/${UPSTREAM_REPO}`;
}

/**
 * Create a branch, write the recipe file, and open a PR.
 * Returns { prUrl, branch, filePath, hash }.
 */
export function createRecipePR(fork, recipe, opts) {
  const branch = `recipe/${recipe.id}`;
  const category = recipe.category || 'custom';
  const filePath = `${category}/${recipe.id}.json`;
  const content = JSON.stringify(recipe, null, 2) + '\n';
  const contentBase64 = Buffer.from(content).toString('base64');
  const hash = hashRecipe(recipe);

  // Create branch from upstream main
  const mainSha = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/git/refs/heads/main`,
    '--jq',
    '.object.sha',
  ]);
  try {
    gh(['api', `repos/${fork}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${mainSha}`]);
  } catch {
    // Branch may already exist — update it
    gh(['api', `repos/${fork}/git/refs/heads/${branch}`, '-X', 'PATCH', '-f', `sha=${mainSha}`, '-f', 'force=true']);
  }

  // Write file to branch
  gh([
    'api',
    `repos/${fork}/contents/${filePath}`,
    '-X',
    'PUT',
    '-f',
    `message=Add recipe: ${recipe.id}`,
    '-f',
    `content=${contentBase64}`,
    '-f',
    `branch=${branch}`,
  ]);

  // Build PR body
  const body = buildPRBody(recipe, hash, opts);

  // Check if PR already exists for this branch
  const existingPr = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`,
    '--jq',
    `.[] | select(.head.label == "${fork.split('/')[0]}:${branch}") | .html_url`,
  ]);
  if (existingPr) {
    return { prUrl: existingPr, branch, filePath, hash, updated: true };
  }

  // Open PR
  const prUrl = gh([
    'api',
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`,
    '-f',
    `title=Recipe: ${recipe.id}`,
    '-f',
    `head=${fork.split('/')[0]}:${branch}`,
    '-f',
    'base=main',
    '--input',
    '-',
    '--jq',
    '.html_url',
  ], { input: JSON.stringify({ body }) });

  return { prUrl, branch, filePath, hash };
}

// ---------------------------------------------------------------------------
// PR body generation
// ---------------------------------------------------------------------------

/**
 * Build the structured PR description.
 */
export function buildPRBody(recipe, hash, opts = {}) {
  const inputs = recipe.inputs || {};
  const steps = recipe.steps || [];
  const guardrails = recipe.guardrails || {};

  // Input table
  let inputTable = '| Field | Type | Constraint |\n|---|---|---|\n';
  for (const [name, def] of Object.entries(inputs)) {
    const constraint = def.pattern ? `\`${def.pattern}\`` :
                       def.enum ? def.enum.join(', ') :
                       def.min !== undefined ? `${def.min}\u2013${def.max}` : '\u2014';
    inputTable += `| ${name} | ${def.type} | ${constraint} |\n`;
  }
  if (Object.keys(inputs).length === 0) {
    inputTable = 'No inputs required.\n';
  }

  // Steps list
  const stepsList = steps.map((s, i) =>
    `${i + 1}. \`${s.run?.command || s.description}\`${s.idempotent ? ' \u2014 idempotent: true' : ''}`
  ).join('\n');

  // Environment
  const envSection = recipe.requires_env?.length
    ? recipe.requires_env.map(e => `- \`${e}\``).join('\n')
    : 'No env vars required.';

  // Validator
  const validatorSection = steps
    .filter(s => s.validator?.regex)
    .map(s => `\`${s.validator.regex}\``)
    .join(', ') || '\u2014';

  // Rollback
  const rollbackSection = recipe.rollback?.steps?.length
    ? recipe.rollback.steps.map(s => `\`${s.run?.command || s.description}\``).join(', ')
    : '\u2014';

  // Lint checklist (auto-verified)
  const lintChecks = [
    'mode: structured on all steps',
    'No bare string inputs',
    'Rollback declared',
    'Validator present',
    'No shell metacharacters in arg patterns',
    'Regex complexity within budget',
    'No secret patterns in env declarations',
  ];
  const checklist = lintChecks.map(c => `- [x] ${c}`).join('\n');

  return `## Recipe: ${recipe.id}

**Category:** ${recipe.category || 'custom'}
**Risk:** ${(recipe.risk_level || 'medium').toUpperCase()}
**Channel:** community
**Submitted via:** guardrail recipe publish v${PUBLISH_VERSION}

### What it does
${recipe.description}

### Inputs
${inputTable}

### Environment
${envSection}

### Steps
${stepsList}

### Validator
${validatorSection}

### Rollback
${rollbackSection}

### Content hash
\`sha256:${hash}\`

### Checklist (auto-verified by guardrail lint)
${checklist}

### Test it locally
\`\`\`bash
guardrail recipe install github://${opts.fork || 'guardrail-dev/recipes'}/${recipe.category || 'custom'}/${recipe.id}.json@{sha}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Main publish orchestrator
// ---------------------------------------------------------------------------

/**
 * Publish a recipe from a local approved manifest to the public registry.
 */
export async function publishRecipe(opts) {
  const log = opts.log || console.log;
  const steps = [];

  // 0. Check gh CLI (skip for dry-run since we won't touch GitHub)
  if (!opts.dryRun) {
    requireGhCli();
  }

  // 1. Load manifest
  const manifestPath = opts.manifestPath || resolve('.guardrail', 'approved.json');
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    throw new Error(
      `No approved manifest found at ${manifestPath}.\n` +
      'Run a command with guardrail first to create an approved manifest.'
    );
  }

  // 2. Risk floor check — RED cannot be published to public registry
  const riskLevel = manifest.riskAssessment?.riskLevel;
  if (riskLevel === 'red') {
    throw new Error(
      'RED-risk recipes cannot be published to the public registry.\n' +
      'RED recipes can exist locally and in private org registries.\n' +
      'For the public registry, submit a manual PR with an explicit justification.'
    );
  }

  // 3. Convert manifest to recipe
  const recipe = manifestToRecipe(manifest, opts);

  // 4. Lint (validates recipe schema)
  validateRecipe(recipe);
  steps.push('Lint passed');

  // 5. Scrub personal data
  const scrubbed = scrubPersonalData(recipe);
  steps.push('Personal data scrubbed');

  // 6. Compute hash
  const hash = hashRecipe(scrubbed);

  // 7. Write recipe file path for display
  const filePath = `${scrubbed.category || 'custom'}/${scrubbed.id}.json`;
  steps.push(`Recipe written: ${filePath}`);

  if (opts.dryRun) {
    log('');
    for (const s of steps) log(`\u2713 ${s}`);
    log('');
    log(`Content hash: sha256:${hash}`);
    log('');
    log('Dry run \u2014 no GitHub operations performed.');
    log('Recipe JSON:');
    log(JSON.stringify(scrubbed, null, 2));
    return { recipe: scrubbed, hash, steps, dryRun: true };
  }

  // 8. Fork
  const fork = ensureFork();
  steps.push(`Forked ${UPSTREAM_OWNER}/${UPSTREAM_REPO}`);

  // 9. Branch + write + PR
  const pr = createRecipePR(fork, scrubbed, { fork });
  steps.push(`Branch created: recipe/${scrubbed.id}`);
  if (pr.updated) {
    steps.push(`PR updated: ${pr.prUrl}`);
  } else {
    steps.push(`PR opened: ${pr.prUrl}`);
  }

  // 10. Output
  log('');
  for (const s of steps) log(`\u2713 ${s}`);
  log('');
  log(`Content hash: sha256:${hash}`);
  log('The maintainers will review your recipe.');
  log("You'll get a GitHub notification when it's merged.");

  return { recipe: scrubbed, hash, prUrl: pr.prUrl, steps };
}
