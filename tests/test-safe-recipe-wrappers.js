import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeNpmInstallSafeOptions,
  buildNpmInstallSafeArgs,
} from '../src/npm-install-safe-wrapper.js';
import {
  validateRequirementsText,
  normalizePipInstallSafeOptions,
  buildPipInstallSafeArgs,
} from '../src/pip-install-safe-wrapper.js';
import {
  isProtectedBranch,
  isTopicBranch,
  readGitRef,
  validateSafePush,
} from '../src/git-push-safe-wrapper.js';
import { validateCommitAmend, parseArgs as parseCommitAmendArgs, resolveCommitAmendOptions } from '../src/git-commit-amend-wrapper.js';
import { validateSafeForcePush, parseArgs as parseForcePushArgs } from '../src/git-force-push-safe-wrapper.js';
import {
  buildOpenclawTaskCommands,
  normalizeOpenclawTaskOptions,
  parseOpenclawTaskWrapperArgs,
} from '../src/openclaw-task-wrapper.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'gr-safe-wrap-'));
}

describe('npm-install-safe wrapper', () => {
  it('normalizes package dir and lockfile inside the package directory', () => {
    const dir = tempDir();
    const pkgDir = join(dir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), '{}\n');
    writeFileSync(join(pkgDir, 'package-lock.json'), '{}\n');

    const options = normalizeNpmInstallSafeOptions({
      packageDir: pkgDir,
      lockfile: join(pkgDir, 'package-lock.json'),
    });
    assert.equal(options.packageDir, pkgDir);
    assert.equal(options.lockfile, join(pkgDir, 'package-lock.json'));
    assert.deepEqual(buildNpmInstallSafeArgs(options), [
      'ci',
      '--ignore-scripts',
      '--fund=false',
      '--audit=false',
      '--prefix',
      pkgDir,
    ]);
  });

  it('rejects lockfiles outside package_dir', () => {
    const dir = tempDir();
    const pkgDir = join(dir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), '{}\n');
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');

    assert.throws(
      () => normalizeNpmInstallSafeOptions({
        packageDir: pkgDir,
        lockfile: join(dir, 'package-lock.json'),
      }),
      /lockfile must live inside package_dir/,
    );
  });
});

describe('pip-install-safe wrapper', () => {
  it('accepts pinned hashed requirements text and builds --require-hashes args', () => {
    const text = 'requests==2.32.3 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
    assert.deepEqual(validateRequirementsText(text), []);

    const dir = tempDir();
    const file = join(dir, 'requirements.txt');
    writeFileSync(file, text);

    const options = normalizePipInstallSafeOptions({ requirementsFile: file });
    assert.equal(options.requirementsFile, file);
    assert.deepEqual(buildPipInstallSafeArgs(options), [
      '-m',
      'pip',
      'install',
      '--require-hashes',
      '--no-deps',
      '--no-input',
      '--disable-pip-version-check',
      '-r',
      file,
    ]);
  });

  it('rejects unhashed or alternate-index requirement text', () => {
    const errors = validateRequirementsText([
      '--extra-index-url https://example.com/simple',
      'requests==2.32.3',
    ].join('\n'));
    assert.ok(errors.some((line) => line.includes('forbidden source')));
    assert.ok(errors.some((line) => line.includes('--hash=')));
  });
});

describe('git-push-safe wrapper', () => {
  it('identifies protected branch names', () => {
    assert.equal(isProtectedBranch('main'), true);
    assert.equal(isProtectedBranch('release/v1'), true);
    assert.equal(isProtectedBranch('feature/demo'), false);
    assert.equal(isTopicBranch('feature/demo'), true);
    assert.equal(isTopicBranch('refactor/clean-apis'), true);
  });

  it('rejects protected, detached, or behind-upstream states', () => {
    const errors = validateSafePush({
      remote: 'origin',
      branch: 'feature/demo',
      status: {
        branch: 'main',
        behind: 2,
        detached: false,
      },
    });
    assert.ok(errors.some((line) => line.includes('does not match')));
    assert.ok(errors.some((line) => line.includes('behind')));
    assert.ok(errors.some((line) => line.includes('protected current branch')));
  });

  it('reads refs through git rev-parse wrapper helper', () => {
    assert.equal(typeof readGitRef, 'function');
  });
});

describe('git-commit-amend wrapper', () => {
  it('parses required wrapper args', () => {
    const parsed = parseCommitAmendArgs([
      '--repo-path', '.',
      '--message-file', '.guardrail/commit-message.txt',
      '--expected-head', 'cafefeed',
    ]);
    assert.equal(parsed.repoPath, '.');
    assert.equal(parsed.messageFile, '.guardrail/commit-message.txt');
    assert.equal(parsed.expectedHead, 'cafefeed');
  });

  it('requires commit amend preconditions when expected head mismatches', () => {
    assert.throws(
      () => resolveCommitAmendOptions({
        repoPath: '.',
        messageFile: 'README.md',
        expectedHead: 'zz',
      }),
      /7-40/,
    );

    const errors = validateCommitAmend({
      repoPath: process.cwd(),
      expectedHead: 'cafefeed',
      status: { detached: false },
    });
    assert.ok(errors.some((line) => line.includes('expected_head')));
  });
});

describe('git-force-push-safe wrapper', () => {
  it('parses required wrapper args', () => {
    const parsed = parseForcePushArgs([
      '--repo-path', '.',
      '--remote', 'origin',
      '--branch', 'feature/demo',
      '--expected-head', 'cafefeed',
      '--expected-remote-oid', '1'.repeat(40),
    ]);
    assert.equal(parsed.remote, 'origin');
    assert.equal(parsed.branch, 'feature/demo');
    assert.equal(parsed.expectedHead, 'cafefeed');
    assert.equal(parsed.expectedRemoteOid, '1'.repeat(40));
  });

  it('requires explicit expected preconditions during force validation', () => {
    const parsed = parseForcePushArgs([
      '--repo-path', '.',
      '--remote', 'origin',
      '--branch', 'feature/demo',
    ]);
    assert.equal(parsed.expectedHead, null);
    assert.equal(parsed.expectedRemoteOid, null);

    const errors = validateSafeForcePush({
      repoPath: '.',
      remote: 'origin',
      branch: 'feature/demo',
      expectedHead: 'cafefeed',
      expectedRemoteOid: '1'.repeat(39),
      status: {
        detached: false,
        branch: 'feature/demo',
      },
    });
    assert.ok(errors.some((line) => line.includes('expected_remote_oid')));
  });
});

describe('openclaw-task-wrapper', () => {
  it('parses command-line flags for fixed task execution', () => {
    const parsed = parseOpenclawTaskWrapperArgs([
      '--flow',
      'fix-tests',
      '--scope',
      'write',
      '--no-escalate',
    ]);
    assert.equal(parsed.flow, 'fix-tests');
    assert.equal(parsed.scope, 'write');
    assert.equal(parsed.noEscalate, true);
  });

  it('rejects unknown task flow identifiers', () => {
    assert.throws(() => normalizeOpenclawTaskOptions({
      flow: 'terraform-apply',
      scope: 'admin',
    }), /Unsupported OpenClaw task/);
  });

  it('enforces task-bound scope by flow contract', () => {
    assert.throws(() => normalizeOpenclawTaskOptions({
      flow: 'fix-tests',
      scope: 'read',
    }), /bounded to scope "write"/);
  });

  it('builds the fixed sequence for fix-tests', () => {
    const commands = buildOpenclawTaskCommands({
      flow: 'fix-tests',
      scope: 'write',
      noEscalate: true,
    });
    assert.deepEqual(commands, {
      scopeCheck: ['scope', 'check', '--flow', 'fix-tests', '--scope', 'write'],
      run: ['run', '--flow', 'fix-tests', '--scope', 'write', '--no-escalate'],
      verify: ['verify', '--flow', 'fix-tests', '--check-scope', 'write', '--check-output'],
    });
  });

  it('requires bounded deploy metadata and threads it into commands', () => {
    assert.throws(() => normalizeOpenclawTaskOptions({
      flow: 'deploy',
      scope: 'write',
      environment: 'prod',
    }), /preview\|staging/);

    const commands = buildOpenclawTaskCommands({
      flow: 'deploy',
      scope: 'write',
      environment: 'staging',
      serviceManifest: 'services/api.json',
      releaseFile: 'releases/api.json',
      noEscalate: true,
    });
    assert.deepEqual(commands, {
      scopeCheck: ['scope', 'check', '--flow', 'deploy', '--scope', 'write', '--environment', 'staging'],
      run: ['run', '--flow', 'deploy', '--scope', 'write', '--environment', 'staging', '--service-manifest', 'services/api.json', '--release-file', 'releases/api.json', '--no-escalate'],
      verify: ['verify', '--flow', 'deploy', '--check-scope', 'write', '--check-output', '--check-environment', 'staging', '--service-manifest', 'services/api.json', '--release-file', 'releases/api.json'],
    });
  });
});
