import { existsSync } from 'node:fs';

export async function handleRecipeManagementSubcommand(parsed) {
  if (parsed.subcommand === 'pack') {
    const { loadRecipe, packRecipe, writePackedRecipe } = await import('../recipe.js');

    let recipe;
    try {
      recipe = loadRecipe(parsed.recipePath);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const packed = packRecipe(recipe);
    const outputPath = parsed.outputPath || parsed.recipePath.replace(/\.recipe\.json$/, '.packed.json').replace(/\.json$/, '.packed.json');

    writePackedRecipe(packed, outputPath);

    if (parsed.json) {
      console.log(JSON.stringify({ status: 'packed', outputPath, contentHash: packed.content_hash, version: recipe.version }, null, 2));
    } else {
      console.log(`Packed recipe "${recipe.name}" v${recipe.version}`);
      console.log(`  Hash:   ${packed.content_hash}`);
      console.log(`  Output: ${outputPath}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'adapter') {
    const { runAdapterCli } = await import('../adapter-cli.js');
    await runAdapterCli(parsed.adapterArgv || [], { jsonOutput: parsed.json });
    process.exit(0);
  }

  if (parsed.subcommand === 'recipe-validate') {
    const { loadRecipe } = await import('../recipe.js');

    try {
      const recipe = loadRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify({ valid: true, id: recipe.id, version: recipe.version }));
      } else {
        console.log(`Recipe "${recipe.name}" v${recipe.version} is valid.`);
        console.log(`  ID:       ${recipe.id}`);
        console.log(`  Risk:     ${recipe.risk_level}`);
        console.log(`  Approval: ${recipe.approval_required ? 'required' : 'not required'}`);
        console.log(`  Steps:    ${recipe.steps.length}`);
        console.log(`  Inputs:   ${Object.keys(recipe.inputs).length}`);
      }
      process.exit(0);
    } catch (err) {
      if (parsed.json) {
        console.log(JSON.stringify({ valid: false, errors: err.errors || [err.message] }));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-inspect') {
    const { loadPackedRecipe } = await import('../recipe.js');

    try {
      const result = loadPackedRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
        console.log(`  ID:       ${result.recipe.id}`);
        console.log(`  Hash:     ${result.contentHash}`);
        console.log(`  Verified: ${result.verified ? 'YES — content matches hash' : 'FAILED — content tampered'}`);
        console.log(`  Packed:   ${result.packedAt}`);
        console.log(`  Risk:     ${result.recipe.risk_level}`);
        console.log(`  Steps:    ${result.recipe.steps.length}`);
      }
      process.exit(result.verified ? 0 : 1);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-versions') {
    const { listVersions } = await import('../recipe-install.js');
    const recipeId = parsed.recipePath;
    const versions = listVersions(recipeId);
    if (parsed.json) {
      console.log(JSON.stringify({ id: recipeId, versions }));
    } else if (versions.length === 0) {
      console.log(`No installed versions of "${recipeId}".`);
    } else {
      console.log(`Versions of "${recipeId}":`);
      for (const v of versions) {
        console.log(`  ${v}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'recipe-install') {
    const source = parsed.recipePath;
    try {
      let result;
      if (parsed.registry) {
        const { installFromRegistry } = await import('../recipe-install.js');
        result = await installFromRegistry(source, parsed.registry, { force: parsed.force });
      } else if (source.startsWith('github://')) {
        const { installFromGitHub } = await import('../recipe-install.js');
        result = await installFromGitHub(source, { force: parsed.force });
      } else if (source.startsWith('http://') || source.startsWith('https://')) {
        const { installFromUrl } = await import('../recipe-install.js');
        result = await installFromUrl(source, { force: parsed.force });
      } else if (/^[a-z][a-z0-9-]*$/.test(source) && !existsSync(source)) {
        console.error(
          `Recipe "${source}" is not a local path, URL, or github:// source.\n` +
          'To install from the public registry, use the full GitHub URL:\n' +
          `  guardrail recipe install github://guardrail-dev/recipes/<category>/${source}.json@<sha>\n` +
          'Browse available recipes at: https://github.com/guardrail-dev/recipes'
        );
        process.exit(1);
      } else {
        const { installFromPath } = await import('../recipe-install.js');
        result = installFromPath(source, { force: parsed.force });
      }
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Installed recipe "${result.id}" v${result.version}`);
        console.log(`  Path: ${result.path}`);
        console.log(`  Hash: ${result.hash}`);
        if (result.pin) {
          console.log(`  SHA:  ${result.pin.sha}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-compose') {
    try {
      const { composeRecipeArtifact } = await import('../recipe-compose.js');
      const result = composeRecipeArtifact({
        transportSpecifier: parsed.transportRecipe,
        execSpecifier: parsed.execRecipe,
        transportStepId: parsed.transportStep || null,
        searchDirs: parsed.recipeSearchDirs || [],
        outputPath: parsed.outputPath,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Wrote composed recipe: ${result.outputPath}`);
        console.log(`  Transport: ${result.transport.specifier}`);
        console.log(`  Exec:      ${result.exec.specifier}`);
        console.log(`  Recipe id: ${result.recipe.id}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-export') {
    try {
      const { exportRecipeRegistry } = await import('../recipe-registry.js');
      const { buildRecipeSearchDirs } = await import('../recipe-runner.js');
      const searchDirs = buildRecipeSearchDirs({
        explicitSearchDirs: parsed.recipeSearchDirs || [],
        projectRoot: process.cwd(),
        basePath: process.cwd(),
        includeDefaults: true,
      });
      const result = exportRecipeRegistry(parsed.outputPath, searchDirs);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Exported recipe registry snapshot to ${result.outputDir}`);
        console.log(`  Recipes: ${result.count}`);
        console.log(`  Generated: ${result.generatedAt}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-list') {
    try {
      const { listRegistryRecipes } = await import('../recipe-install.js');
      const result = await listRegistryRecipes(parsed.registry, {});
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe registry: ${result.registry}`);
        console.log(`  Recipes: ${result.count}`);
        if (result.generated_at) {
          console.log(`  Generated: ${result.generated_at}`);
        }
        for (const recipe of result.recipes) {
          console.log(`  ${recipe.category}/${recipe.id}@${recipe.latest_version}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-publish') {
    try {
      const { publishRecipe } = await import('../recipe-publish.js');
      const result = await publishRecipe({
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
        manifestPath: parsed.manifestPath,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  return false;
}
