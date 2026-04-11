import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { serializeStable } from './contract.js';
import { resolveRecipeById } from './recipe-runner.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function riskRank(level) {
  return { low: 0, medium: 1, high: 2 }[level] ?? 1;
}

function mergeInputs(transportRecipe, execRecipe) {
  const merged = clone(transportRecipe.inputs || {});
  for (const [key, schema] of Object.entries(execRecipe.inputs || {})) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = clone(schema);
      continue;
    }
    if (serializeStable(merged[key]) !== serializeStable(schema)) {
      throw new Error(
        `Input schema conflict for "${key}" between transport recipe "${transportRecipe.id}" and exec recipe "${execRecipe.id}". ` +
        'Author the composed recipe manually or rename one side before composing.',
      );
    }
  }
  return merged;
}

function mergeUniqueObjects(left = [], right = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...left, ...right]) {
    const key = serializeStable(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(clone(item));
  }
  return merged;
}

function resolveTransportStep(transportRecipe, transportStepId) {
  if (transportStepId) {
    const step = (transportRecipe.steps || []).find((entry) => entry.id === transportStepId);
    if (!step) {
      throw new Error(`Transport recipe "${transportRecipe.id}" does not contain step "${transportStepId}".`);
    }
    return step.id;
  }
  if ((transportRecipe.steps || []).length !== 1) {
    throw new Error(
      `Transport recipe "${transportRecipe.id}" has ${(transportRecipe.steps || []).length} steps. ` +
      'Provide --transport-step <id> to choose which step should host the composed exec contract.',
    );
  }
  return transportRecipe.steps[0].id;
}

export function buildComposedRecipe({
  transportRecipe,
  transportSpecifier,
  execRecipe,
  execSpecifier,
  transportStepId,
  name,
  category,
  description,
  version,
}) {
  const outputId = name || `${transportRecipe.id}-${execRecipe.id}`;
  const targetStepId = resolveTransportStep(transportRecipe, transportStepId);
  const requiresEnv = [...new Set([...(transportRecipe.requires_env || []), ...(execRecipe.requires_env || [])])];
  const requiresAuth = mergeUniqueObjects(transportRecipe.requires_auth || [], execRecipe.requires_auth || []);
  const steps = clone(transportRecipe.steps || []).map((step) => {
    if (step.id !== targetStepId) return step;
    if (step.composed_recipe) {
      throw new Error(`Transport step "${targetStepId}" already contains composed_recipe metadata.`);
    }
    return {
      ...step,
      composed_recipe: {
        recipe: execSpecifier || `${execRecipe.id}@${execRecipe.version}`,
        inputs: Object.fromEntries(
          Object.keys(execRecipe.inputs || {}).map((key) => [key, `{{inputs.${key}}}`]),
        ),
      },
    };
  });

  const recipe = {
    id: outputId,
    name: outputId.replace(/-/g, ' '),
    description: description || `Composed ${transportRecipe.id} transport with ${execRecipe.id} exec under one Guardrail approval.`,
    version: version || '1.0.0',
    author: transportRecipe.author || execRecipe.author || 'Guardrail Team',
    category: category || transportRecipe.category || execRecipe.category || 'custom',
    tags: [...new Set([...(transportRecipe.tags || []), ...(execRecipe.tags || []), 'composed'])],
    channel: transportRecipe.channel === 'verified' && execRecipe.channel === 'verified' ? 'verified' : 'community',
    approval_required: transportRecipe.approval_required !== false || execRecipe.approval_required !== false,
    risk_level: riskRank(transportRecipe.risk_level) >= riskRank(execRecipe.risk_level)
      ? transportRecipe.risk_level
      : execRecipe.risk_level,
    inputs: mergeInputs(transportRecipe, execRecipe),
    steps,
    guardrails: {
      constraints: [
        ...(transportRecipe.guardrails?.constraints || []),
        ...(execRecipe.guardrails?.constraints || []),
        `composed transport recipe: ${transportSpecifier || `${transportRecipe.id}@${transportRecipe.version}`}`,
        `composed exec recipe: ${execSpecifier || `${execRecipe.id}@${execRecipe.version}`}`,
      ],
      invariants: [
        ...(transportRecipe.guardrails?.invariants || []),
        ...(execRecipe.guardrails?.invariants || []),
        'No nested inner `guardrail run` is used for the composed exec path.',
      ],
    },
  };

  if (requiresEnv.length > 0) {
    recipe.requires_env = requiresEnv;
  }
  if (transportRecipe.preserve_runtime_env === true || execRecipe.preserve_runtime_env === true) {
    recipe.preserve_runtime_env = true;
  }
  if (requiresAuth.length > 0) {
    recipe.requires_auth = requiresAuth;
  }

  return recipe;
}

export function composeRecipeArtifact({
  transportSpecifier,
  execSpecifier,
  transportStepId = null,
  searchDirs = null,
  outputPath,
  name = '',
  category = '',
  description = '',
  version = '',
}) {
  if (!transportSpecifier) throw new Error('--transport <recipe-id[@version]> is required.');
  if (!execSpecifier) throw new Error('--exec <recipe-id[@version]> is required.');
  if (!outputPath) throw new Error('--output <path> is required.');

  const transportResolved = resolveRecipeById(transportSpecifier, searchDirs);
  const execResolved = resolveRecipeById(execSpecifier, searchDirs);
  const recipe = buildComposedRecipe({
    transportRecipe: transportResolved.recipe,
    transportSpecifier,
    execRecipe: execResolved.recipe,
    execSpecifier,
    transportStepId,
    name,
    category,
    description,
    version,
  });

  const resolvedOutput = resolve(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');

  return {
    outputPath: resolvedOutput,
    recipe,
    transport: {
      specifier: transportSpecifier,
      sourcePath: transportResolved.sourcePath,
      version: transportResolved.version,
    },
    exec: {
      specifier: execSpecifier,
      sourcePath: execResolved.sourcePath,
      version: execResolved.version,
    },
  };
}
