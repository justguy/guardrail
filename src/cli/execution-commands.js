import { dirname, resolve } from 'node:path';

export async function handleExecutionSubcommand(parsed, { statusExitCodes }) {
  if (parsed.subcommand === 'workflow-lint') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow lint');
      process.exit(1);
    }

    const { loadWorkflowDefinition, lintWorkflowDefinition, normalizeWorkflowDefinition } = await import('../workflow.js');

    let def;
    try {
      def = loadWorkflowDefinition(parsed.definition);
      normalizeWorkflowDefinition(def, dirname(resolve(parsed.definition)), {
        recipeSearchDirs: parsed.recipeSearchDirs,
        envAllow: parsed.envAllow,
      });
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

  if (parsed.subcommand === 'workflow') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow run');
      process.exit(1);
    }

    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runWorkflowSupervisor } = await import('../workflow-supervisor.js');
    const wantStructuredResult = parsed.json || parsed.jsonStream;

    const result = await runWorkflowSupervisor({
      definitionPath: parsed.definition,
      manifestPath: parsed.manifest || '.guardrail/workflows/default.approved.json',
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      trustClass: parsed.trust,
      recipeSearchDirs: parsed.recipeSearchDirs,
      envAllow: parsed.envAllow,
      allowUnverified: parsed.allowUnverified || false,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (wantStructuredResult) {
      console.log(JSON.stringify(result, null, parsed.json ? 2 : 0));
    }

    const exitCode = statusExitCodes[result.status] ?? 1;
    process.exit(exitCode);
  }

  if (parsed.subcommand === 'run' && parsed.recipeId) {
    try {
      if (parsed.dryRunOnly) {
        const { runRecipeById } = await import('../recipe-runner.js');
        const result = await runRecipeById(parsed.recipeId, {
          inputs: parsed.inputs,
          allowUnverified: parsed.allowUnverified || false,
          dryRunOnly: true,
          cwd: process.cwd(),
        });
        if (parsed.json || parsed.jsonStream) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
          console.log(`  Steps: ${result.steps.length}`);
          console.log(`  Safe:  ${result.safe ? 'YES' : 'NO — blocked steps detected'}`);
          for (const step of result.steps) {
            const icon = step.dangerous || !step.inScope ? '✗' : '✓';
            console.log(`  ${icon} ${step.id}: ${step.command} ${step.args.join(' ')}`);
          }
        }
        process.exit(result.status === 'dry_run' ? 0 : 1);
      }

      if (parsed.nonInteractive && parsed.manifest === null) {
        console.error('Error: --non-interactive requires --approved-manifest <path>');
        process.exit(10);
      }

      const { runRecipeSupervisor } = await import('../recipe-supervisor.js');
      const result = await runRecipeSupervisor({
        specifier: parsed.recipeId,
        inputs: parsed.inputs,
        allowUnverified: parsed.allowUnverified || false,
        cwd: process.cwd(),
        envAllow: parsed.envAllow,
        manifestPath: parsed.manifest || null,
        nonInteractive: parsed.nonInteractive,
        jsonOutput: parsed.json || parsed.jsonStream,
        trustClass: parsed.trust,
        progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
      });

      if (parsed.json || parsed.jsonStream) {
        console.log(JSON.stringify(result, null, 2));
      }
      const exitCode = statusExitCodes[result.status] ?? 1;
      process.exit(exitCode);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'run' && parsed.template !== null) {
    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runTemplateSupervisor } = await import('../template-supervisor.js');
    const result = await runTemplateSupervisor({
      templatePath: parsed.template,
      inputs: parsed.inputs,
      manifestPath: parsed.manifest || null,
      cwd: process.cwd(),
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      envAllow: parsed.envAllow,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (parsed.json || parsed.jsonStream) {
      console.log(JSON.stringify(result, null, 2));
    }

    const exitCode = statusExitCodes[result.status] ?? 1;
    process.exit(exitCode);
  }

  return false;
}
