import { existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ALLOWED_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

export function parseNpmInstallSafeArgs(argv) {
  const parsed = {
    packageDir: '.',
    lockfile: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--package-dir':
        parsed.packageDir = value;
        i += 1;
        break;
      case '--lockfile':
        parsed.lockfile = value;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return parsed;
}

export function normalizeNpmInstallSafeOptions(rawOptions = {}) {
  const packageDir = resolve(process.cwd(), rawOptions.packageDir || '.');
  const lockfile = rawOptions.lockfile
    ? resolve(process.cwd(), rawOptions.lockfile)
    : resolve(packageDir, 'package-lock.json');
  const packageJson = resolve(packageDir, 'package.json');

  if (!existsSync(packageJson)) {
    throw new Error(`package.json not found in ${packageDir}`);
  }
  if (!existsSync(lockfile)) {
    throw new Error(`Lockfile not found: ${lockfile}`);
  }
  if (!ALLOWED_LOCKFILES.has(basename(lockfile))) {
    throw new Error('lockfile must be package-lock.json or npm-shrinkwrap.json');
  }
  if (dirname(lockfile) !== packageDir) {
    throw new Error('lockfile must live inside package_dir');
  }

  return { packageDir, lockfile };
}

export function buildNpmInstallSafeArgs(options = {}) {
  return [
    'ci',
    '--ignore-scripts',
    '--fund=false',
    '--audit=false',
    '--prefix',
    options.packageDir,
  ];
}

export function runNpmInstallSafe(rawOptions = {}) {
  const options = normalizeNpmInstallSafeOptions(rawOptions);
  const result = spawnSync('npm', buildNpmInstallSafeArgs(options), {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `npm ci failed with exit code ${result.status}`).trim());
  }
}

function main(argv) {
  runNpmInstallSafe(parseNpmInstallSafeArgs(argv));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
