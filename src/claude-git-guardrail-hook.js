#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const BLOCKED_RULES = [
  {
    id: 'git_push',
    matches: (segment) => /^git\s+push(?:\s|$)/.test(segment),
    buildMessage: (commandText, segment) => {
      const forceLike = /\s(--force(?:-with-lease)?|-f)(?:\s|$)/.test(segment);
      const recipe = forceLike ? 'git-force-push-safe' : 'git-push';
      const replacement = forceLike
        ? 'guardrail run --recipe git-force-push-safe --input repo_path=. --input remote=origin --input branch=feature/<name> --input expected_head=<sha> --input expected_remote_oid=<sha>'
        : 'guardrail run --recipe git-push --input repo_path=. --input remote=origin --input branch=feature/<name>';

      return [
        `BLOCKED: raw git push is not allowed in this Guardian project.`,
        `Command: ${commandText}`,
        `Use the bounded Guardrail recipe instead:`,
        replacement,
        `Reason: Guardrail's ${recipe} recipe constrains the remote, branch shape, and push semantics before execution.`,
      ].join('\n');
    },
  },
  {
    id: 'git_reset_hard',
    matches: (segment) => /^git\s+reset\b.*(?:^|\s)--hard(?:\s|$)/.test(segment),
    buildMessage: (commandText) => buildNoRecipeMessage(commandText, 'git reset --hard'),
  },
  {
    id: 'git_clean_force',
    matches: (segment) => /^git\s+clean\b.*(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(segment),
    buildMessage: (commandText) => buildNoRecipeMessage(commandText, 'git clean -f'),
  },
  {
    id: 'git_branch_delete',
    matches: (segment) => /^git\s+branch\b.*(?:^|\s)-D(?:\s|$)/.test(segment),
    buildMessage: (commandText) => buildNoRecipeMessage(commandText, 'git branch -D'),
  },
  {
    id: 'git_checkout_dot',
    matches: (segment) => /^git\s+checkout\b(?:.*\s)?(?:--\s+)?\.(?:\s|$)/.test(segment),
    buildMessage: (commandText) => buildNoRecipeMessage(commandText, 'git checkout .'),
  },
  {
    id: 'git_restore_dot',
    matches: (segment) => /^git\s+restore\b(?:.*\s)?(?:--\s+)?\.(?:\s|$)/.test(segment),
    buildMessage: (commandText) => buildNoRecipeMessage(commandText, 'git restore .'),
  },
];

function buildNoRecipeMessage(commandText, patternLabel) {
  return [
    `BLOCKED: raw ${patternLabel} is not allowed in this Guardian project.`,
    `Command: ${commandText}`,
    'No shipped Guardrail recipe exists for worktree or history wipe commands.',
    'Stop and ask the operator, or create a reviewed bounded recipe before retrying.',
  ].join('\n');
}

function stripLeadingAssignments(segment) {
  let out = segment.trim();

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out)) {
    const firstSpace = out.indexOf(' ');
    if (firstSpace === -1) return '';
    out = out.slice(firstSpace + 1).trim();
  }

  return out;
}

export function splitCommandSegments(commandText) {
  if (typeof commandText !== 'string' || commandText.trim() === '') return [];

  return commandText
    .split(/\r?\n|&&|\|\||[;|]/)
    .map((segment) => stripLeadingAssignments(segment))
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function detectBlockedGitCommand(commandText) {
  const normalizedCommand = typeof commandText === 'string'
    ? commandText.replace(/\s+/g, ' ').trim()
    : '';

  if (!normalizedCommand) {
    return { blocked: false, reason: null, message: '' };
  }

  for (const segment of splitCommandSegments(commandText)) {
    for (const rule of BLOCKED_RULES) {
      if (rule.matches(segment)) {
        return {
          blocked: true,
          reason: rule.id,
          message: rule.buildMessage(normalizedCommand, segment),
        };
      }
    }
  }

  return { blocked: false, reason: null, message: '' };
}

export function extractClaudeCommand(payload) {
  const toolInput = payload?.tool_input;

  if (typeof toolInput?.command === 'string') {
    return toolInput.command;
  }

  if (Array.isArray(toolInput?.command)) {
    return toolInput.command.join(' ');
  }

  if (typeof toolInput?.raw_command === 'string') {
    return toolInput.raw_command;
  }

  return '';
}

export function runClaudeGitGuardrailHook(stdinText) {
  if (typeof stdinText !== 'string' || stdinText.trim() === '') {
    return { exitCode: 0, stderr: '' };
  }

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return { exitCode: 0, stderr: '' };
  }

  const commandText = extractClaudeCommand(payload);
  const result = detectBlockedGitCommand(commandText);
  if (!result.blocked) {
    return { exitCode: 0, stderr: '' };
  }

  return {
    exitCode: 2,
    stderr: `${result.message}\n`,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function main() {
  const stdinText = await readStdin();
  const result = runClaudeGitGuardrailHook(stdinText);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
