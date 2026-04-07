#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { runSupervisor, STATUS_EXIT_CODES } from './supervisor.js';
import { hasShellMetacharacters } from './contract.js';
import { DEFAULT_MANIFEST_PATH } from './manifest.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function getVersion() {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `Usage: guardrail <command> [options]

Commands:
  run [flags] -- <command> [args...]    Run a command under Guardrail
  run --shell "<script>"                Run a shell script under Guardrail
  run --template <path> --input k=v     Run a template under Guardrail
  workflow run [flags]                  Run a workflow definition under Guardrail
  workflow lint --definition <path>     Lint a workflow definition for issues
  template lint --template <path>       Lint a template for issues
  template explain --template <path>    Explain what a template does
  template schema --template <path>     Show template input schema
  template simulate --template <path>   Simulate a template run (no execution)
  template diff --template <path>       Show diff from approved hash
  demo drift                            Run the built-in drift demo

Flags:
  --shell <text>              Shell mode with script text
  --template <path>           Template file path
  --input <key=value>         Template input (repeatable)
  --env-allow <var>           Env var to allow for template (repeatable)
  --manifest <path>           Custom manifest path
  --approved-manifest <path>  Approved manifest path (CI)
  --non-interactive           Never prompt, fail on missing approval
  --json                      Emit JSON output
  --trust <class>             Override trust class
  --validator <mode>          Validator mode: exit_code | ndjson
  --update-source <source>    Update source: none | worker_proposal | demo
  --definition <path>         Workflow definition file path
  --help                      Show this help
  --version                   Show version

Examples:
  guardrail run -- npm test
  guardrail run "npm test"
  guardrail run --shell "npm test && npm run lint"
  guardrail run --template ./templates/npm-publish.json --input package_dir=packages/my-lib --input tag=beta
  guardrail template lint --template ./templates/npm-publish.json
  guardrail template explain --template ./templates/npm-publish.json
  guardrail template simulate --template ./templates/npm-publish.json --input package_dir=packages/my-lib
  guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
  guardrail demo drift`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {
    subcommand: null,
    shell: null,
    template: null,
    inputs: {},
    envAllow: [],
    manifest: null,
    nonInteractive: false,
    json: false,
    trust: null,
    validator: null,
    updateSource: null,
    definition: null,
    command: null,
    args: [],
    demoTarget: null,
  };

  let i = 0;

  // --- Subcommand -----------------------------------------------------------

  if (i >= argv.length) {
    return { error: 'usage' };
  }

  const sub = argv[i++];

  if (sub === '--help') {
    return { help: true };
  }
  if (sub === '--version') {
    return { version: true };
  }

  // --- template subcommand --------------------------------------------------

  if (sub === 'template') {
    if (i >= argv.length || !['lint', 'explain', 'schema', 'simulate', 'diff'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `template-${action}`;

    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help') return { help: true };
      if (arg === '--version') return { version: true };

      if (arg === '--template') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.template = argv[i++];
        continue;
      }
      if (arg === '--input') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        const kv = argv[i++];
        const eq = kv.indexOf('=');
        if (eq < 1) return { error: 'usage' };
        result.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
        continue;
      }
      if (arg === '--env-allow') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.envAllow.push(argv[i++]);
        continue;
      }
      if (arg === '--manifest') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.manifest = argv[i++];
        continue;
      }
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      if (arg.startsWith('--')) return { error: 'usage' };
      return { error: 'usage' };
    }
    return result;
  }

  // --- workflow subcommand --------------------------------------------------

  if (sub === 'workflow') {
    if (i >= argv.length || !['run', 'lint'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const workflowAction = argv[i];
    i++;
    result.subcommand = workflowAction === 'lint' ? 'workflow-lint' : 'workflow';

    // Parse workflow flags
    while (i < argv.length) {
      const arg = argv[i];

      if (arg === '--help') {
        return { help: true };
      }

      if (arg === '--version') {
        return { version: true };
      }

      if (arg === '--definition') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.definition = argv[i++];
        continue;
      }

      if (arg === '--manifest') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.manifest = argv[i++];
        continue;
      }

      if (arg === '--approved-manifest') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.manifest = argv[i++];
        continue;
      }

      if (arg === '--non-interactive') {
        result.nonInteractive = true;
        i++;
        continue;
      }

      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }

      if (arg === '--trust') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.trust = argv[i++];
        continue;
      }

      if (arg === '--validator') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.validator = argv[i++];
        continue;
      }

      if (arg === '--update-source') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.updateSource = argv[i++];
        continue;
      }

      // Unknown flag
      if (arg.startsWith('--')) {
        return { error: 'usage' };
      }

      // No positional args for workflow
      return { error: 'usage' };
    }

    return result;
  }

  if (sub !== 'run' && sub !== 'demo') {
    return { error: 'usage' };
  }

  result.subcommand = sub;

  // --- demo subcommand ------------------------------------------------------

  if (sub === 'demo') {
    if (i >= argv.length) {
      return { error: 'usage' };
    }
    result.demoTarget = argv[i++];
    if (result.demoTarget !== 'drift') {
      return { error: 'usage' };
    }
    return result;
  }

  // --- run subcommand: parse flags then command -----------------------------

  let foundSeparator = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      foundSeparator = true;
      i++;
      break;
    }

    if (arg === '--help') {
      return { help: true };
    }

    if (arg === '--version') {
      return { version: true };
    }

    if (arg === '--shell') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.shell = argv[i++];
      continue;
    }

    if (arg === '--template') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.template = argv[i++];
      continue;
    }

    if (arg === '--input') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      const kv = argv[i++];
      const eq = kv.indexOf('=');
      if (eq < 1) {
        return { error: 'usage' };
      }
      result.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }

    if (arg === '--env-allow') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.envAllow.push(argv[i++]);
      continue;
    }

    if (arg === '--manifest') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.manifest = argv[i++];
      continue;
    }

    if (arg === '--approved-manifest') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.manifest = argv[i++];
      continue;
    }

    if (arg === '--non-interactive') {
      result.nonInteractive = true;
      i++;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      i++;
      continue;
    }

    if (arg === '--trust') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.trust = argv[i++];
      continue;
    }

    if (arg === '--validator') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.validator = argv[i++];
      continue;
    }

    if (arg === '--update-source') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.updateSource = argv[i++];
      continue;
    }

    // Unknown flag
    if (arg.startsWith('--')) {
      return { error: 'usage' };
    }

    // Positional argument (shorthand string mode): "npm test"
    result.command = arg;
    i++;
    break;
  }

  // After `--` separator, everything is the command + args
  if (foundSeparator) {
    if (i >= argv.length) {
      return { error: 'usage' };
    }
    result.command = argv[i++];
    result.args = argv.slice(i);
  }

  // Template mode: command comes from --template, nothing else needed
  if (result.template !== null) {
    return result;
  }

  // Shell mode: command comes from --shell, nothing else needed
  if (result.shell !== null) {
    return result;
  }

  // Must have a command by now
  if (result.command === null) {
    return { error: 'usage' };
  }

  // Shorthand string mode (no `--` separator, no --shell):
  // tokenize the quoted string and check for metacharacters
  if (!foundSeparator) {
    const text = result.command;
    if (hasShellMetacharacters(text)) {
      return {
        error: 'shell_meta',
        text,
      };
    }
    // Tokenize by whitespace
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { error: 'usage' };
    }
    result.command = tokens[0];
    result.args = tokens.slice(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  // --- Help / version ------------------------------------------------------

  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (parsed.version) {
    console.log(getVersion());
    process.exit(0);
  }

  // --- Errors --------------------------------------------------------------

  if (parsed.error === 'usage') {
    console.error(USAGE);
    process.exit(1);
  }

  if (parsed.error === 'shell_meta') {
    console.error(
      `Error: Shell metacharacters detected in command: ${parsed.text}\n` +
      `Use --shell to run shell scripts:\n` +
      `  guardrail run --shell "${parsed.text}"`
    );
    process.exit(1);
  }

  // --- demo drift ----------------------------------------------------------

  if (parsed.subcommand === 'demo') {
    const { default: runDemoDrift } = await import('./demo-drift.js');
    await runDemoDrift();
    process.exit(0);
  }

  // --- template lint -------------------------------------------------------

  if (parsed.subcommand === 'template-lint') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template lint');
      process.exit(1);
    }

    const { loadTemplate, lintTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const warnings = lintTemplate(def);

    if (warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
    for (const w of warnings) {
      console.error(`  ⚠ ${w}`);
    }
    process.exit(1);
  }

  // --- template explain ----------------------------------------------------

  if (parsed.subcommand === 'template-explain') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template explain');
      process.exit(1);
    }

    const { loadTemplate, explainTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(explainTemplate(def));
    process.exit(0);
  }

  // --- template schema -----------------------------------------------------

  if (parsed.subcommand === 'template-schema') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template schema');
      process.exit(1);
    }

    const { loadTemplate, describeSchema } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(describeSchema(def));
    process.exit(0);
  }

  // --- template simulate ---------------------------------------------------

  if (parsed.subcommand === 'template-simulate') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template simulate');
      process.exit(1);
    }

    const { loadTemplate, simulateTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const result = simulateTemplate(def, parsed.inputs, parsed.envAllow);
    if (result.errors.length > 0) {
      console.error('Simulation failed:');
      for (const e of result.errors) {
        console.error(`  - ${e}`);
      }
      process.exit(1);
    }

    console.log(result.output);
    process.exit(0);
  }

  // --- template diff -------------------------------------------------------

  if (parsed.subcommand === 'template-diff') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template diff');
      process.exit(1);
    }

    const { resolve } = await import('node:path');
    const { loadTemplate, hashTemplateExecution, createTemplateManifest, diffTemplateManifests, evaluateTemplateRisk, validateUserInputs, computeEnvIntersection } = await import('./template.js');
    const { loadManifest } = await import('./manifest.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const manifestPath = resolve(parsed.manifest || `.guardrail/templates/${def.name}.approved.json`);
    const approved = loadManifest(manifestPath);

    if (!approved) {
      console.log('No approved manifest found. Nothing to diff against.');
      process.exit(0);
    }

    // Rebuild candidate with the same inputs from the approved manifest
    const savedInputs = approved.resolvedInputs || {};
    const savedEnv = approved.envIntersection || [];

    const inputValidation = validateUserInputs(def.inputs, { ...savedInputs, ...parsed.inputs });
    const inputs = inputValidation.valid ? inputValidation.values : savedInputs;
    const callerAllow = parsed.envAllow.length > 0 ? parsed.envAllow : savedEnv;
    const envResult = computeEnvIntersection(def.requires_env || [], callerAllow);
    const templateHash = hashTemplateExecution(def, inputs, envResult.intersection);
    const riskAssessment = evaluateTemplateRisk(def, envResult.intersection);
    const candidate = createTemplateManifest(def, templateHash, riskAssessment, inputs, envResult.intersection);

    const diffs = diffTemplateManifests(candidate, approved);

    if (diffs.length === 0) {
      console.log('No changes detected. Template matches approved hash.');
      process.exit(0);
    }

    console.log(`Template: ${def.name}`);
    console.log(`Approved hash: ${approved.templateHash?.slice(0, 12)}...`);
    console.log(`Current hash:  ${candidate.templateHash?.slice(0, 12)}...`);
    console.log('');
    console.log('Changes:');
    for (const diff of diffs) {
      console.log(`  ${diff}`);
    }
    process.exit(12);
  }

  // --- workflow lint --------------------------------------------------------

  if (parsed.subcommand === 'workflow-lint') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow lint');
      process.exit(1);
    }

    const { loadWorkflowDefinition, lintWorkflowDefinition } = await import('./workflow.js');

    let def;
    try {
      def = loadWorkflowDefinition(parsed.definition);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const { errors, warnings } = lintWorkflowDefinition(def);

    if (errors.length === 0 && warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    if (errors.length > 0) {
      console.error(`${errors.length} error${errors.length > 1 ? 's' : ''} (block approval):\n`);
      for (const e of errors) {
        console.error(`  ✗ ${e}`);
      }
    }
    if (warnings.length > 0) {
      console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
      for (const w of warnings) {
        console.error(`  ⚠ ${w}`);
      }
    }
    process.exit(errors.length > 0 ? 1 : 0);
  }

  // --- workflow run ---------------------------------------------------------

  if (parsed.subcommand === 'workflow') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow run');
      process.exit(1);
    }

    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runWorkflowSupervisor } = await import('./workflow-supervisor.js');

    const result = await runWorkflowSupervisor({
      definitionPath: parsed.definition,
      manifestPath: parsed.manifest || '.guardrail/workflows/default.approved.json',
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json,
      trustClass: parsed.trust,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
  }

  // --- run --template ------------------------------------------------------

  if (parsed.subcommand === 'run' && parsed.template !== null) {
    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runTemplateSupervisor } = await import('./template-supervisor.js');

    const result = await runTemplateSupervisor({
      templatePath: parsed.template,
      inputs: parsed.inputs,
      manifestPath: parsed.manifest || null,
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json,
      envAllow: parsed.envAllow,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
  }

  // --- run -----------------------------------------------------------------

  // Validate --non-interactive requires --approved-manifest
  if (parsed.nonInteractive && parsed.manifest === null) {
    console.error(
      'Error: --non-interactive requires --approved-manifest <path>'
    );
    process.exit(10);
  }

  const options = {
    manifestPath: parsed.manifest ?? DEFAULT_MANIFEST_PATH,
    nonInteractive: parsed.nonInteractive,
    jsonOutput: parsed.json,
    trustClass: parsed.trust,
    validator: parsed.validator,
    updateSource: parsed.updateSource,
    cwd: process.cwd(),
  };

  if (parsed.shell !== null) {
    options.shell = parsed.shell;
    options.command = parsed.shell;
    options.args = [];
  } else {
    options.command = parsed.command;
    options.args = parsed.args;
  }

  const result = await runSupervisor(options);

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
