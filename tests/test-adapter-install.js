import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  installFromPath, installFromUrl, installFromGitHub, installAdapterProfile,
} from '../src/adapter-profile-install.js';
import { hashProfile } from '../src/adapter-profile.js';
import {
  verifyAdapterProfileIndex,
  resolveAdapterProfileFromSignedIndex,
  loadAdapterProfileIndex,
} from '../src/adapter-profile-index.js';
import { serializeStable } from '../src/contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolve(__dirname, '..', 'src', 'adapter-profiles');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-adapter-install-'));
}

function makeProfile(overrides = {}) {
  return {
    tool: 'testtool',
    version: '1.0.0',
    schema_target: 'adapter-result/v1',
    protocol: 'stdin-json',
    description: 'test profile',
    intercept: { command: '$.command', args: '$.args', cwd: '$.cwd' },
    response: {
      format: 'json',
      success: { status: 'success', stdout: '$.process.stdout' },
      blocked: { status: 'blocked', reason: '$.guardrail.reason' },
      failed: { status: 'failed', exit_code: '$.guardrail.exitCode' },
    },
    exit_codes: { success: 0, blocked: 12, failed: 1 },
    defaults: { non_interactive: true, json_output: true },
    ...overrides,
  };
}

function writeProfileFile(dir, profile, name = 'profile.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

function makeConfig(dir, trustedSources) {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ trusted_sources: trustedSources }));
  return path;
}

function writeOrgPolicy(dir, trustedExecutionSources) {
  const policyDir = join(dir, '.guardrail');
  mkdirSync(policyDir, { recursive: true });
  const path = join(policyDir, 'org-policy.json');
  writeFileSync(path, JSON.stringify({
    name: 'adapter-exec-policy',
    version: '1.0.0',
    trusted_execution_sources: trustedExecutionSources,
    forbidden_operations: [],
    required_approvals: [],
    allowed_actions: [],
  }));
  return path;
}

function makeSignedAdapterIndex(profiles, keyPair = generateKeyPairSync('ed25519')) {
  const unsigned = {
    version: 1,
    generated_at: '2026-04-10T00:00:00.000Z',
    profiles,
  };
  const payload = Buffer.from(serializeStable(unsigned), 'utf8');
  const signature = signBytes(null, payload, keyPair.privateKey).toString('base64');
  return {
    index: {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        key_id: 'test-key',
        sig: `base64:${signature}`,
      },
    },
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// ---------------------------------------------------------------------------
// 1. Local path install — full coverage
// ---------------------------------------------------------------------------

describe('adapter installFromPath — local coverage', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('installs a valid profile and returns a populated result', () => {
    const src = writeProfileFile(work, makeProfile());
    const profileDir = join(work, 'store');
    const result = installFromPath(src, { profileDir });

    assert.equal(result.installed, true);
    assert.equal(result.tool, 'testtool');
    assert.equal(result.version, '1.0.0');
    assert.equal(result.path, join(profileDir, 'testtool', '1.0.0.json'));
    assert.ok(typeof result.hash === 'string' && result.hash.length === 64);
    assert.ok(existsSync(result.path), 'profile file should be written');
  });

  it('re-installing identical content is a no-op with idempotent note', () => {
    const src = writeProfileFile(work, makeProfile());
    const profileDir = join(work, 'store');

    const first = installFromPath(src, { profileDir });
    const second = installFromPath(src, { profileDir });

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.equal(second.hash, first.hash);
    assert.ok(
      second.note && second.note.includes('already installed (identical)'),
      `expected idempotent note, got: ${second.note}`
    );
  });

  it('different content at same (tool, version) throws immutability error', () => {
    const src1 = writeProfileFile(work, makeProfile(), 'p1.json');
    const src2 = writeProfileFile(
      work,
      makeProfile({ description: 'CHANGED' }),
      'p2.json'
    );
    const profileDir = join(work, 'store');

    installFromPath(src1, { profileDir });

    assert.throws(
      () => installFromPath(src2, { profileDir }),
      (err) => {
        assert.ok(err.message.includes('already installed with different content'));
        assert.ok(err.message.includes('testtool'));
        assert.ok(err.message.includes('1.0.0'));
        return true;
      }
    );
  });

  it('force: true overwrites and returns new hash', () => {
    const src1 = writeProfileFile(work, makeProfile(), 'p1.json');
    const src2 = writeProfileFile(
      work,
      makeProfile({ description: 'CHANGED v2' }),
      'p2.json'
    );
    const profileDir = join(work, 'store');

    const first = installFromPath(src1, { profileDir });
    const second = installFromPath(src2, { profileDir, force: true });

    assert.equal(second.installed, true);
    assert.notEqual(second.hash, first.hash);

    // File on disk should contain the overwritten description
    const onDisk = JSON.parse(readFileSync(second.path, 'utf8'));
    assert.equal(onDisk.description, 'CHANGED v2');
    // Hash of file matches returned hash
    assert.equal(hashProfile(onDisk), second.hash);
  });

  it('invalid profile errors use stable "Adapter profile validation failed:" prefix with ; joined errors', () => {
    // Multiple independent violations so the "; " joining is exercised
    const bad = makeProfile({ tool: 'BAD NAME', protocol: 'http' });
    const src = writeProfileFile(work, bad);
    const profileDir = join(work, 'store');

    assert.throws(
      () => installFromPath(src, { profileDir }),
      (err) => {
        assert.ok(
          err.message.startsWith('Adapter profile validation failed:'),
          `expected stable prefix, got: ${err.message}`
        );
        assert.ok(err.message.includes('tool must match'));
        assert.ok(err.message.includes('protocol'));
        assert.ok(
          err.message.includes('; '),
          `expected errors joined by "; ", got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('non-existent file throws "Profile not found:"', () => {
    const missing = join(work, 'does-not-exist.json');
    assert.throws(
      () => installFromPath(missing, { profileDir: join(work, 'store') }),
      /Profile not found:/
    );
  });
});

// ---------------------------------------------------------------------------
// 2. URL install — trust enforcement
// ---------------------------------------------------------------------------

describe('adapter installFromUrl — trust enforcement', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const url = 'https://example.com/profiles/testtool.json';

  it('rejects when no trusted_sources configured', async () => {
    const configPath = makeConfig(work, []);
    const profileDir = join(work, 'store');

    await assert.rejects(
      () => installFromUrl(url, {
        configPath,
        profileDir,
        fetchJson: async () => makeProfile(),
      }),
      (err) => {
        assert.ok(err.message.includes('trusted_sources'));
        assert.ok(err.message.includes('~/.guardrail/config.json'));
        return true;
      }
    );
  });

  it('rejects URL outside trusted prefix with "is not in trusted sources"', async () => {
    const configPath = makeConfig(work, ['https://other.example.com/']);
    const profileDir = join(work, 'store');

    await assert.rejects(
      () => installFromUrl(url, {
        configPath,
        profileDir,
        fetchJson: async () => makeProfile(),
      }),
      (err) => {
        assert.ok(
          err.message.includes('is not in trusted sources'),
          `expected trusted-source message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('installs successfully with matching trusted prefix + stub fetcher', async () => {
    const configPath = makeConfig(work, ['https://example.com/profiles/']);
    const profileDir = join(work, 'store');

    let fetched = 0;
    const result = await installFromUrl(url, {
      configPath,
      profileDir,
      fetchJson: async (u) => {
        fetched += 1;
        assert.equal(u, url);
        return makeProfile();
      },
    });

    assert.equal(fetched, 1);
    assert.equal(result.installed, true);
    assert.equal(result.tool, 'testtool');
    assert.ok(existsSync(result.path));
  });

  it('URL install surfaces validation failures with the stable prefix', async () => {
    const configPath = makeConfig(work, ['https://example.com/profiles/']);
    const profileDir = join(work, 'store');

    await assert.rejects(
      () => installFromUrl(url, {
        configPath,
        profileDir,
        fetchJson: async () => makeProfile({ schema_target: 'other/v9' }),
      }),
      /Adapter profile validation failed:/
    );
  });
});

// ---------------------------------------------------------------------------
// 2b. Signed index groundwork
// ---------------------------------------------------------------------------

describe('adapter profile signed index groundwork', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('verifies a signed adapter profile index and resolves an entry by tool', () => {
    const { index, publicKeyPem } = makeSignedAdapterIndex({
      openclaw: {
        owner: 'guardrail-dev',
        repo: 'adapter-profiles',
        path: 'openclaw.json',
        sha: 'a'.repeat(40),
        version: '1.0.0',
        content_hash: 'b'.repeat(64),
      },
      cline: {
        owner: 'guardrail-dev',
        repo: 'adapter-profiles',
        path: 'cline.json',
        sha: 'c'.repeat(40),
        version: '1.0.0',
        content_hash: 'd'.repeat(64),
      },
    });

    const verify = verifyAdapterProfileIndex(index, publicKeyPem);
    assert.equal(verify.valid, true, verify.errors.join('; '));

    const indexPath = join(work, 'adapter-index.json');
    const keyPath = join(work, 'adapter-index.pub.pem');
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    writeFileSync(keyPath, publicKeyPem);

    const resolved = resolveAdapterProfileFromSignedIndex('cline', {
      indexPath,
      indexKeyPath: keyPath,
    });
    assert.equal(resolved.entry.path, 'cline.json');
    assert.equal(resolved.source, `github://guardrail-dev/adapter-profiles/cline.json@${'c'.repeat(40)}`);
  });

  it('fails closed when the signature is missing or invalid', () => {
    const { index, publicKeyPem } = makeSignedAdapterIndex({
      openclaw: {
        owner: 'guardrail-dev',
        repo: 'adapter-profiles',
        path: 'openclaw.json',
        sha: 'a'.repeat(40),
        version: '1.0.0',
        content_hash: 'b'.repeat(64),
      },
    });
    const missing = verifyAdapterProfileIndex({
      version: index.version,
      generated_at: index.generated_at,
      profiles: index.profiles,
    }, publicKeyPem);
    assert.equal(missing.valid, false);
    assert.ok(missing.reason.includes('validation failed') || missing.reason.includes('signature'));

    const tampered = {
      ...index,
      signature: {
        ...index.signature,
        sig: `base64:${'A'.repeat(88)}`,
      },
    };
    const invalid = verifyAdapterProfileIndex(tampered, publicKeyPem);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.reason.includes('verification failed'));
  });

  it('loadAdapterProfileIndex rejects invalid entry sources', () => {
    const path = join(work, 'adapter-index.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      generated_at: '2026-04-10T00:00:00.000Z',
      profiles: {
        openclaw: {
          owner: 'guardrail-dev',
          repo: 'adapter-profiles',
          path: '',
          sha: 'a'.repeat(40),
          version: '1.0.0',
          content_hash: 'b'.repeat(64),
        },
      },
      signature: {
        algorithm: 'ed25519',
        key_id: 'test-key',
        sig: `base64:${'A'.repeat(88)}`,
      },
    }, null, 2));

    assert.throws(
      () => loadAdapterProfileIndex(path),
      /validation failed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. GitHub SHA-pinned install
// ---------------------------------------------------------------------------

describe('adapter installFromGitHub — SHA pinning + pin metadata', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const fullSha = 'a'.repeat(40);
  const source =
    `github://guardrail-dev/adapter-profiles/testtool.json@${fullSha}`;

  it('rejects non-40-character SHA with full-SHA error', async () => {
    const shortSource =
      'github://guardrail-dev/adapter-profiles/testtool.json@abc1234';
    const configPath = makeConfig(work, ['github://guardrail-dev/adapter-profiles/']);

    await assert.rejects(
      () => installFromGitHub(shortSource, {
        configPath,
        profileDir: join(work, 'store'),
        fetchJson: async () => makeProfile(),
      }),
      (err) => {
        assert.ok(
          err.message.includes('full 40-character SHA'),
          `expected full-SHA guidance, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('writes profile + pin metadata with all expected fields', async () => {
    const configPath = makeConfig(work, ['github://guardrail-dev/adapter-profiles/']);
    const profileDir = join(work, 'store');

    const profile = makeProfile();
    let seenUrl = null;
    const result = await installFromGitHub(source, {
      configPath,
      profileDir,
      fetchJson: async (u) => { seenUrl = u; return profile; },
    });

    assert.ok(seenUrl && seenUrl.startsWith('https://raw.githubusercontent.com/'));
    assert.equal(result.installed, true);
    assert.equal(result.tool, 'testtool');
    assert.equal(result.path, join(profileDir, 'testtool', '1.0.0.json'));

    // Pin file location
    const pinPath = join(profileDir, 'testtool', '.pins', '1.0.0.json');
    assert.ok(existsSync(pinPath), 'pin metadata file must exist');

    const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
    assert.equal(pin.source, source);
    assert.equal(pin.owner, 'guardrail-dev');
    assert.equal(pin.repo, 'adapter-profiles');
    assert.equal(pin.path, 'testtool.json');
    assert.equal(pin.sha, fullSha);
    assert.ok(pin.rawUrl.startsWith('https://raw.githubusercontent.com/'));
    assert.equal(pin.content_hash, result.hash);
    assert.ok(typeof pin.installed_at === 'string' && pin.installed_at.length > 0);

    // The returned result should also carry the pin object
    assert.deepEqual(result.pin, pin);
  });

  it('re-install of identical GitHub content is idempotent', async () => {
    const configPath = makeConfig(work, ['github://guardrail-dev/adapter-profiles/']);
    const profileDir = join(work, 'store');

    const opts = {
      configPath,
      profileDir,
      fetchJson: async () => makeProfile(),
    };
    const first = await installFromGitHub(source, opts);
    const second = await installFromGitHub(source, opts);

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.ok(second.note && second.note.includes('already installed (identical)'));
  });
});

// ---------------------------------------------------------------------------
// 4. installAdapterProfile routing
// ---------------------------------------------------------------------------

describe('installAdapterProfile — source routing', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('routes github:// sources through installFromGitHub (pin written)', async () => {
    const fullSha = 'b'.repeat(40);
    const source =
      `github://guardrail-dev/adapter-profiles/testtool.json@${fullSha}`;
    const configPath = makeConfig(work, ['github://guardrail-dev/adapter-profiles/']);
    const profileDir = join(work, 'store');

    const result = await installAdapterProfile(source, {
      configPath,
      profileDir,
      fetchJson: async () => makeProfile(),
    });

    assert.ok(result.pin, 'github route must produce pin metadata');
    assert.equal(result.pin.sha, fullSha);
  });

  it('routes https:// sources through installFromUrl (no pin)', async () => {
    const url = 'https://example.com/profiles/testtool.json';
    const configPath = makeConfig(work, ['https://example.com/profiles/']);
    const profileDir = join(work, 'store');

    const result = await installAdapterProfile(url, {
      configPath,
      profileDir,
      fetchJson: async () => makeProfile(),
    });

    assert.equal(result.installed, true);
    assert.equal(result.pin, undefined, 'URL route must not produce pin metadata');
  });

  it('enforces trusted_execution_sources for URL installs via active org policy', async () => {
    const url = 'https://example.com/profiles/testtool.json';
    const configPath = makeConfig(work, ['https://example.com/profiles/']);
    writeOrgPolicy(work, ['https://other.example.com/']);

    await assert.rejects(
      () => installFromUrl(url, {
        configPath,
        profileDir: join(work, 'store'),
        orgPolicyDir: work,
        fetchJson: async () => makeProfile(),
      }),
      /trusted execution sources/
    );

    writeOrgPolicy(work, ['https://example.com/']);
    const result = await installFromUrl(url, {
      configPath,
      profileDir: join(work, 'store'),
      orgPolicyDir: work,
      fetchJson: async () => makeProfile(),
    });
    assert.equal(result.installed, true);
  });

  it('routes local paths through installFromPath', async () => {
    const src = writeProfileFile(work, makeProfile());
    const profileDir = join(work, 'store');

    const result = await installAdapterProfile(src, { profileDir });
    assert.equal(result.installed, true);
    assert.equal(result.tool, 'testtool');
  });

  it('rejects a bare tool name with helpful github URL guidance', async () => {
    await assert.rejects(
      () => installAdapterProfile('aider', { profileDir: join(work, 'store') }),
      (err) => {
        assert.ok(err.message.includes('Bare-name adapter install requires a signed index.'));
        return true;
      }
    );
  });

  it('resolves a bare tool name through a verified signed index when index inputs are provided', async () => {
    const { index, publicKeyPem } = makeSignedAdapterIndex({
      aider: {
        owner: 'guardrail-dev',
        repo: 'adapter-profiles',
        path: 'aider.json',
        sha: 'a'.repeat(40),
        version: '1.0.0',
        content_hash: 'b'.repeat(64),
      },
    });
    const indexPath = join(work, 'adapter-profiles.index.json');
    const keyPath = join(work, 'adapter-profiles.index.pub.pem');
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    writeFileSync(keyPath, publicKeyPem);

    let seenUrl = null;
    const result = await installAdapterProfile('aider', {
      profileDir: join(work, 'store'),
      configPath: makeConfig(work, ['github://guardrail-dev/adapter-profiles/']),
      indexPath,
      indexKeyPath: keyPath,
      fetchJson: async (url) => {
        seenUrl = url;
        return makeProfile({ tool: 'aider' });
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.tool, 'aider');
    assert.ok(seenUrl && seenUrl.includes('/adapter-profiles/'));
  });

  it('enforces trusted_execution_sources for GitHub installs via active org policy', async () => {
    const fullSha = 'd'.repeat(40);
    const source =
      `github://guardrail-dev/adapter-profiles/testtool.json@${fullSha}`;
    const configPath = makeConfig(work, ['github://guardrail-dev/adapter-profiles/']);
    writeOrgPolicy(work, ['github://other-org/']);

    await assert.rejects(
      () => installFromGitHub(source, {
        configPath,
        profileDir: join(work, 'store'),
        orgPolicyDir: work,
        fetchJson: async () => makeProfile(),
      }),
      /trusted execution sources/
    );
  });

  it('enforces trusted_execution_sources for bare-name signed-index installs', async () => {
    const { index, publicKeyPem } = makeSignedAdapterIndex({
      aider: {
        owner: 'guardrail-dev',
        repo: 'adapter-profiles',
        path: 'aider.json',
        sha: 'a'.repeat(40),
        version: '1.0.0',
        content_hash: 'b'.repeat(64),
      },
    });
    const indexPath = join(work, 'adapter-profiles.index.json');
    const keyPath = join(work, 'adapter-profiles.index.pub.pem');
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    writeFileSync(keyPath, publicKeyPem);
    writeOrgPolicy(work, ['github://other-org/']);

    await assert.rejects(
      () => installAdapterProfile('aider', {
        profileDir: join(work, 'store'),
        configPath: makeConfig(work, ['github://guardrail-dev/adapter-profiles/']),
        indexPath,
        indexKeyPath: keyPath,
        orgPolicyDir: work,
        fetchJson: async () => makeProfile({ tool: 'aider' }),
      }),
      /trusted execution sources/
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Bundled profiles round-trip through installFromPath
// ---------------------------------------------------------------------------

describe('bundled adapter profiles install cleanly', () => {
  let work;
  beforeEach(() => { work = tmpDir(); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  for (const tool of ['openclaw', 'aider', 'cline']) {
    it(`installs bundled ${tool}.json end-to-end`, () => {
      const src = join(BUNDLED_DIR, `${tool}.json`);
      assert.ok(existsSync(src), `bundled profile must exist at ${src}`);

      const profileDir = join(work, 'store');
      const result = installFromPath(src, { profileDir });

      assert.equal(result.installed, true);
      assert.equal(result.tool, tool);
      assert.ok(result.path.endsWith(`${tool}/${result.version}.json`));
      assert.ok(existsSync(result.path));

      // Disk content round-trips
      const onDisk = JSON.parse(readFileSync(result.path, 'utf8'));
      assert.equal(onDisk.tool, tool);
      assert.equal(hashProfile(onDisk), result.hash);
    });
  }
});
