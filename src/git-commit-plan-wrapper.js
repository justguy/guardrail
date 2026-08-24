import { resolve } from 'node:path';
import { normalizePath } from './input-validator.js';
import { loadCommitPlan } from './commit-plan.js';
import { runGitCommit } from './git-commit-wrapper.js';

export function parseWrapperArgs(argv) {
  const options = {
    planFile: '',
    messageFile: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--plan-file':
        options.planFile = value;
        i += 1;
        break;
      case '--message-file':
        options.messageFile = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function normalizeOptions(rawOptions) {
  const planFile = String(rawOptions.planFile || '').trim();
  const messageFile = String(rawOptions.messageFile || '').trim();
  if (!planFile) {
    throw new Error('Provide --plan-file.');
  }
  if (!messageFile) {
    throw new Error('Provide --message-file.');
  }
  return {
    planFile,
    messageFile: normalizePath(messageFile),
  };
}

export async function runGitCommitFromPlan(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const plan = loadCommitPlan(options.planFile);
  const repoPath = resolve(process.cwd(), plan.repo_path);
  const normalizedPlanMessage = normalizePath(plan.message_file);

  if (normalizedPlanMessage !== options.messageFile) {
    throw new Error(
      `plan.message_file mismatch: ${plan.message_file} != ${options.messageFile}`,
    );
  }

  await runGitCommit({
    repoPath,
    paths: plan.paths,
    messageFile: resolve(repoPath, normalizedPlanMessage),
  });
}

async function main() {
  await runGitCommitFromPlan(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
