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
  validateSafePush,
} from '../src/git-push-safe-wrapper.js';

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
});
