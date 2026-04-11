import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const FORBIDDEN_REQUIREMENT_PATTERNS = [
  /^(-i|--index-url)\b/i,
  /^--extra-index-url\b/i,
  /^(-e|--editable)\b/i,
  /^--find-links\b/i,
  /^git\+/i,
  /^https?:\/\//i,
];

export function parsePipInstallSafeArgs(argv) {
  const parsed = {
    requirementsFile: '',
    workingDir: '.',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--requirements-file':
        parsed.requirementsFile = value;
        i += 1;
        break;
      case '--working-dir':
        parsed.workingDir = value;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return parsed;
}

export function validateRequirementsText(content) {
  const errors = [];
  const lines = content.split('\n');
  let sawRequirement = false;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (FORBIDDEN_REQUIREMENT_PATTERNS.some((pattern) => pattern.test(line))) {
      errors.push(`Line ${index + 1} uses a forbidden source or editable option: ${line}`);
      continue;
    }

    if (line.startsWith('--')) {
      if (line !== '--require-hashes') {
        errors.push(`Line ${index + 1} uses an unsupported global option: ${line}`);
      }
      continue;
    }

    sawRequirement = true;

    if (!line.includes('==')) {
      errors.push(`Line ${index + 1} must pin the package with ==`);
    }
    if (!line.includes('--hash=')) {
      errors.push(`Line ${index + 1} must include at least one --hash= entry`);
    }
  }

  if (!sawRequirement) {
    errors.push('requirements file must contain at least one pinned requirement');
  }

  return errors;
}

export function validatePinnedRequirementsFile(filePath) {
  return validateRequirementsText(readFileSync(filePath, 'utf8'));
}

export function normalizePipInstallSafeOptions(rawOptions = {}) {
  const workingDir = rawOptions.workingDir
    ? resolve(process.cwd(), rawOptions.workingDir)
    : process.cwd();
  const requirementsFile = rawOptions.requirementsFile
    ? resolve(workingDir, rawOptions.requirementsFile)
    : '';

  if (!requirementsFile) {
    throw new Error('--requirements-file is required');
  }
  if (!existsSync(requirementsFile)) {
    throw new Error(`requirements file not found: ${requirementsFile}`);
  }
  const name = basename(requirementsFile);
  if (!(name.endsWith('.txt') || name.endsWith('.lock'))) {
    throw new Error('requirements file must end in .txt or .lock');
  }

  const errors = validatePinnedRequirementsFile(requirementsFile);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  return { requirementsFile, workingDir };
}

export function buildPipInstallSafeArgs(options = {}) {
  return [
    '-m',
    'pip',
    'install',
    '--require-hashes',
    '--no-deps',
    '--no-input',
    '--disable-pip-version-check',
    '-r',
    options.requirementsFile,
  ];
}

export function runPipInstallSafe(rawOptions = {}) {
  const options = normalizePipInstallSafeOptions(rawOptions);
  const result = spawnSync('python3', buildPipInstallSafeArgs(options), {
    cwd: options.workingDir,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `pip install failed with exit code ${result.status}`).trim());
  }
}

function main(argv) {
  runPipInstallSafe(parsePipInstallSafeArgs(argv));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
