import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializeStable } from './contract.js';

const SHA_RE = /^[a-f0-9]{40}$/i;
const HASH_RE = /^[a-f0-9]{64}$/i;
const SIG_RE = /^base64:[A-Za-z0-9+/=]+$/;
const TOOL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function canonicalizeIndex(index) {
  return serializeStable({
    version: index.version,
    generated_at: index.generated_at,
    profiles: index.profiles,
  });
}

export function validateAdapterProfileIndex(index) {
  const errors = [];
  if (index == null || typeof index !== 'object' || Array.isArray(index)) {
    return { valid: false, errors: ['Index must be a non-null object'] };
  }
  if (index.version !== 1) {
    errors.push('index.version must equal 1');
  }
  if (typeof index.generated_at !== 'string' || index.generated_at.trim() === '') {
    errors.push('index.generated_at must be a non-empty string');
  }
  if (index.signature == null || typeof index.signature !== 'object' || Array.isArray(index.signature)) {
    errors.push('index.signature must be an object');
  } else {
    if (index.signature.algorithm !== 'ed25519') {
      errors.push('index.signature.algorithm must equal "ed25519"');
    }
    if (typeof index.signature.key_id !== 'string' || index.signature.key_id.trim() === '') {
      errors.push('index.signature.key_id must be a non-empty string');
    }
    if (typeof index.signature.sig !== 'string' || !SIG_RE.test(index.signature.sig)) {
      errors.push('index.signature.sig must be a base64:... string');
    }
  }
  if (index.profiles == null || typeof index.profiles !== 'object' || Array.isArray(index.profiles)) {
    errors.push('index.profiles must be an object');
  } else {
    for (const [name, entry] of Object.entries(index.profiles)) {
      if (!TOOL_RE.test(name)) {
        errors.push(`index.profiles key "${name}" must match bare tool-name format`);
        continue;
      }
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`index.profiles.${name} must be an object`);
        continue;
      }
      if (typeof entry.owner !== 'string' || entry.owner.trim() === '') {
        errors.push(`index.profiles.${name}.owner must be a non-empty string`);
      }
      if (typeof entry.repo !== 'string' || entry.repo.trim() === '') {
        errors.push(`index.profiles.${name}.repo must be a non-empty string`);
      }
      if (typeof entry.path !== 'string' || entry.path.trim() === '') {
        errors.push(`index.profiles.${name}.path must be a non-empty string`);
      }
      if (typeof entry.sha !== 'string' || !SHA_RE.test(entry.sha)) {
        errors.push(`index.profiles.${name}.sha must be a full 40-character SHA`);
      }
      if (typeof entry.version !== 'string' || entry.version.trim() === '') {
        errors.push(`index.profiles.${name}.version must be a non-empty string`);
      }
      if (typeof entry.content_hash !== 'string' || !HASH_RE.test(entry.content_hash)) {
        errors.push(`index.profiles.${name}.content_hash must be a 64-character SHA-256 hash`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function verifyAdapterProfileIndex(index, publicKeyPem) {
  const validation = validateAdapterProfileIndex(index);
  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      reason: `Adapter profile index validation failed: ${validation.errors.join('; ')}`,
    };
  }
  if (typeof publicKeyPem !== 'string' || publicKeyPem.trim() === '') {
    return {
      valid: false,
      errors: ['Missing adapter profile index public key.'],
      reason: 'Missing adapter profile index public key.',
    };
  }

  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (err) {
    return {
      valid: false,
      errors: [`Adapter profile index public key is invalid: ${err.message}`],
      reason: `Adapter profile index public key is invalid: ${err.message}`,
    };
  }

  try {
    const payload = Buffer.from(canonicalizeIndex(index), 'utf8');
    const signature = Buffer.from(index.signature.sig.replace(/^base64:/, ''), 'base64');
    const valid = verifySignature(null, payload, key, signature);
    if (!valid) {
      return {
        valid: false,
        errors: ['Adapter profile index signature verification failed.'],
        reason: 'Adapter profile index signature verification failed.',
      };
    }
  } catch (err) {
    return {
      valid: false,
      errors: [`Adapter profile index verification failed: ${err.message}`],
      reason: `Adapter profile index verification failed: ${err.message}`,
    };
  }

  return { valid: true, errors: [], reason: null };
}

export function loadAdapterProfileIndex(indexPath) {
  const abs = resolve(indexPath);
  if (!existsSync(abs)) {
    throw new Error(`Adapter profile index not found: ${abs}`);
  }
  let index;
  try {
    index = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Adapter profile index is not valid JSON: ${err.message}`);
  }
  const validation = validateAdapterProfileIndex(index);
  if (!validation.valid) {
    throw new Error(`Adapter profile index validation failed: ${validation.errors.join('; ')}`);
  }
  return index;
}

export function resolveAdapterProfileIndexEntry(index, toolName) {
  const entry = index?.profiles?.[toolName];
  if (!entry) {
    throw new Error(`Adapter profile "${toolName}" was not found in the signed index.`);
  }
  return entry;
}

export function resolveAdapterProfileFromSignedIndex(toolName, options = {}) {
  if (!options.indexPath) {
    throw new Error(
      'Bare-name adapter install requires a signed index.\n'
      + 'Use --index <path> --index-key <pubkey.pem>, or install from github://...@sha directly.'
    );
  }
  if (!options.indexKeyPath) {
    throw new Error(
      'Bare-name adapter install requires --index-key <pubkey.pem> so Guardrail can verify the signed index.'
    );
  }

  const index = loadAdapterProfileIndex(options.indexPath);
  const keyPath = resolve(options.indexKeyPath);
  if (!existsSync(keyPath)) {
    throw new Error(`Adapter profile index public key not found: ${keyPath}`);
  }
  const publicKeyPem = readFileSync(keyPath, 'utf8');
  const signatureCheck = verifyAdapterProfileIndex(index, publicKeyPem);
  if (!signatureCheck.valid) {
    throw new Error(signatureCheck.reason);
  }

  const entry = resolveAdapterProfileIndexEntry(index, toolName);
  return {
    source: `github://${entry.owner}/${entry.repo}/${entry.path}@${entry.sha}`,
    entry,
    indexSignature: index.signature,
  };
}
