import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// ---------------------------------------------------------------------------
// Key Management — encrypted storage with scoped access
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_DIR_NAME = 'keys';

/**
 * Derive an encryption key from a passphrase.
 */
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32);
}

/**
 * Encrypt a value.
 */
function encrypt(plaintext, passphrase) {
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return { salt: salt.toString('hex'), iv: iv.toString('hex'), encrypted, tag: tag.toString('hex') };
}

/**
 * Decrypt a value.
 */
function decrypt(envelope, passphrase) {
  const salt = Buffer.from(envelope.salt, 'hex');
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(envelope.iv, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  let decrypted = decipher.update(envelope.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Key store interface
// ---------------------------------------------------------------------------

/**
 * Create a key store.
 *
 * @param {string} stateDir   - Directory for key storage.
 * @param {string} passphrase - Encryption passphrase.
 */
export function createKeyStore(stateDir, passphrase) {
  const keyDir = resolve(stateDir, KEY_DIR_NAME);
  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });

  function set(name, value, scope = '*') {
    const envelope = encrypt(value, passphrase);
    const meta = { name, scope, encrypted: envelope, storedAt: new Date().toISOString() };
    writeFileSync(join(keyDir, `${name}.key.json`), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }

  function get(name, requiredScope = '*') {
    const path = join(keyDir, `${name}.key.json`);
    if (!existsSync(path)) return null;
    const meta = JSON.parse(readFileSync(path, 'utf8'));

    // Scope check
    if (meta.scope !== '*' && requiredScope !== '*' && meta.scope !== requiredScope) {
      throw new Error(`Key "${name}" is scoped to "${meta.scope}" — access from "${requiredScope}" denied`);
    }

    return decrypt(meta.encrypted, passphrase);
  }

  function listSync() {
    if (!existsSync(keyDir)) return [];
    return readdirSync(keyDir)
      .filter(f => f.endsWith('.key.json'))
      .map(f => {
        const meta = JSON.parse(readFileSync(join(keyDir, f), 'utf8'));
        return { name: meta.name, scope: meta.scope, storedAt: meta.storedAt };
      });
  }

  function remove(name) {
    const path = join(keyDir, `${name}.key.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  /**
   * Redact — return masked version for logging. Never expose raw secrets.
   */
  function redact(name) {
    const path = join(keyDir, `${name}.key.json`);
    if (!existsSync(path)) return null;
    return `[REDACTED:${name}]`;
  }

  return { set, get, listSync, remove, redact };
}
