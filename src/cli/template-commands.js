import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function handleTemplateSubcommand(parsed) {
  if (parsed.subcommand === 'template-create') {
    if (!parsed.manifestPath) {
      console.error('Error: --from-manifest <path> is required for template create');
      process.exit(1);
    }

    const { buildTemplateFromApprovedManifest, lintTemplate } = await import('../template.js');

    let templateDef;
    try {
      templateDef = buildTemplateFromApprovedManifest(parsed.manifestPath, {
        name: parsed.name,
        sourcePath: parsed.manifestPath,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const outputPath = resolve(parsed.outputPath || `.guardrail/templates/${templateDef.name}.json`);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(templateDef, null, 2) + '\n');

    const warnings = lintTemplate(templateDef);
    if (parsed.json) {
      console.log(JSON.stringify({ path: outputPath, template: templateDef, warnings }, null, 2));
    } else {
      console.log(`Template created: ${outputPath}`);
      if (warnings.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const warning of warnings) {
          console.log(`  - ${warning}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'template-list') {
    const { listTemplates } = await import('../template.js');

    let rows;
    try {
      rows = listTemplates(parsed.templatesDir || '.guardrail/templates');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    if (parsed.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log('No templates found.');
    } else {
      for (const row of rows) {
        const provenance = row.source
          ? `${row.source.type}${row.sourceMatch === false ? ' (modified)' : ''}`
          : 'local';
        console.log(`  ${row.name.padEnd(24)} ${row.kind.padEnd(18)} ${row.effectiveTrustClass.padEnd(18)} ${provenance}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'template-publish') {
    try {
      const { publishTemplate } = await import('../recipe-publish.js');
      const result = await publishTemplate({
        templatePath: parsed.template,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
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

  if (parsed.subcommand === 'template-lint') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template lint');
      process.exit(1);
    }

    const { loadTemplate, lintTemplate } = await import('../template.js');

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

  if (parsed.subcommand === 'template-explain') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template explain');
      process.exit(1);
    }

    const { loadTemplate, explainTemplate } = await import('../template.js');

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

  if (parsed.subcommand === 'template-schema') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template schema');
      process.exit(1);
    }

    const { loadTemplate, describeSchema } = await import('../template.js');

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

  if (parsed.subcommand === 'template-simulate') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template simulate');
      process.exit(1);
    }

    const { loadTemplate, simulateTemplate } = await import('../template.js');

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

  if (parsed.subcommand === 'template-diff') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template diff');
      process.exit(1);
    }

    const {
      loadTemplate,
      hashTemplateExecution,
      createTemplateManifest,
      diffTemplateManifests,
      evaluateTemplateRisk,
      validateUserInputs,
      computeEnvIntersection,
    } = await import('../template.js');
    const { loadManifest } = await import('../manifest.js');

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

  return false;
}
