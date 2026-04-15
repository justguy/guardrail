export async function handleGenericRunSubcommand(parsed, { defaultManifestPath, statusExitCodes, runSupervisor }) {
  if (parsed.subcommand !== 'run') return false;
  if (parsed.recipeId || parsed.template !== null) return false;

  if (parsed.nonInteractive && parsed.manifest === null) {
    console.error('Error: --non-interactive requires --approved-manifest <path>');
    process.exit(10);
  }

  const options = {
    manifestPath: parsed.manifest ?? defaultManifestPath,
    nonInteractive: parsed.nonInteractive,
    jsonOutput: parsed.json || parsed.jsonStream,
    trustClass: parsed.trust,
    validator: parsed.validator,
    updateSource: parsed.updateSource,
    cwd: process.cwd(),
    progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
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

  if (parsed.json || parsed.jsonStream) {
    console.log(JSON.stringify(result, null, 2));
  }

  const exitCode = statusExitCodes[result.status] ?? 1;
  process.exit(exitCode);
}
