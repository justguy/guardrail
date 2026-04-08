import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { inferApprovalMode } from './input-validator.js';

function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function resolveBaseDir(cwd, resolvedInputs, schema) {
  const baseInput = schema?.base_dir_input;
  if (!baseInput) return resolve(cwd);
  const baseValue = resolvedInputs?.[baseInput];
  if (!baseValue || typeof baseValue !== 'string') return resolve(cwd);
  return resolve(cwd, baseValue);
}

function hashFileAtPath(path) {
  const realPath = realpathSync(path);
  const contents = readFileSync(realPath);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  return { realPath, sha256 };
}

export function buildPromptPayload({
  prompt = '',
  inputFiles = [],
  baseDir = process.cwd(),
}) {
  const sections = [];

  if (prompt) {
    sections.push(String(prompt).trim());
  }

  for (const file of inputFiles) {
    const filePath = resolve(baseDir, file);
    const content = readFileSync(filePath, 'utf8').trimEnd();
    sections.push(
      `<input_file path="${file}">\n${content}\n</input_file>`
    );
  }

  const payload = sections.filter(Boolean).join('\n\n');
  if (!payload.trim()) {
    throw new Error('Provide prompt or input_files.');
  }
  return payload;
}

export function collectRecipeInputContentHashes(recipe, resolvedInputs, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bindings = {};

  for (const [key, schema] of Object.entries(recipe.inputs || {})) {
    if (!schema?.content_hash) continue;
    const mode = inferApprovalMode(schema);
    const rawValue = resolvedInputs?.[key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    const baseDir = resolveBaseDir(cwd, resolvedInputs, schema);
    const values = toArray(rawValue);
    const entries = values.map((value) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Input "${key}" must resolve to a non-empty file path for content hashing.`);
      }
      const requestedPath = value;
      const absolutePath = resolve(baseDir, requestedPath);
      const { realPath, sha256 } = hashFileAtPath(absolutePath);
      return { path: requestedPath, realPath, sha256 };
    });

    if (mode === 'list') {
      bindings[key] = entries;
    } else {
      bindings[key] = entries[0];
    }
  }

  return bindings;
}

export function verifyRecipeInputContentHashes(inputContentHashes = {}) {
  const errors = [];

  for (const [key, binding] of Object.entries(inputContentHashes)) {
    const entries = Array.isArray(binding) ? binding : [binding];
    for (const entry of entries) {
      try {
        const { sha256 } = hashFileAtPath(entry.realPath);
        if (sha256 !== entry.sha256) {
          errors.push(
            `Input "${key}" file content changed: ${entry.path} (${entry.sha256} -> ${sha256})`
          );
        }
      } catch (err) {
        errors.push(`Input "${key}" file check failed for ${entry.path}: ${err.message}`);
      }
    }
  }

  return {
    verified: errors.length === 0,
    errors,
  };
}
