import { writeFileSync } from 'node:fs';

export async function handleRecipeCatalogSubcommand(parsed) {
  if (parsed.subcommand === 'list') {
    const { buildIndex, filterRecipes, formatRecipeList, deduplicateLatest } = await import('../recipe-index.js');
    const { buildRecipeSearchDirs } = await import('../recipe-runner.js');

    const dirs = buildRecipeSearchDirs({ basePath: process.cwd(), includeDefaults: true });
    const index = buildIndex(dirs);
    const deduped = deduplicateLatest(index);
    const filtered = filterRecipes(deduped, parsed.listFilters);

    if (parsed.json) {
      console.log(JSON.stringify(filtered.map(r => ({
        id: r.id, name: r.name, version: r.version,
        category: r.category, tags: r.tags, channel: r.channel,
        risk_level: r.risk_level, approval_required: r.approval_required,
      })), null, 2));
    } else {
      if (filtered.length === 0) {
        console.log('No recipes found.');
      } else {
        console.log(`  ${'ID'.padEnd(25)} ${'VERSION'.padEnd(8)} ${'RISK'.padEnd(6)} ${'CHANNEL'.padEnd(12)} NAME`);
        console.log(`  ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(30)}`);
        console.log(formatRecipeList(filtered));
        console.log(`\n  ${filtered.length} recipe(s) found.`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'create') {
    const opts = parsed.createOpts || {};
    if (!opts.name) {
      console.error('Error: --name is required for create');
      process.exit(1);
    }

    const id = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const category = opts.category || 'custom';
    const risk = opts.risk || 'medium';
    const outputPath = parsed.outputPath || `${id}.recipe.json`;

    const skeleton = {
      id,
      name: opts.name,
      description: `TODO: Describe what ${opts.name} does`,
      version: '0.1.0',
      author: process.env.USER || 'unknown',
      category,
      tags: [category],
      channel: 'community',
      signature: null,
      inputs: {
        target: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$', description: 'TODO: describe this input' },
      },
      steps: [
        { id: 'step-1', description: 'TODO: describe this step', run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured' } },
      ],
      guardrails: {
        constraints: ['TODO: define constraints'],
        invariants: ['TODO: define invariants'],
      },
      approval_required: risk !== 'low',
      risk_level: risk,
    };

    writeFileSync(outputPath, JSON.stringify(skeleton, null, 2) + '\n');

    const riskWarnings = {
      high: '  WARNING: High-risk recipe — will require explicit approval before execution.',
      medium: '  Note: Medium-risk recipe — approval required by default.',
      low: '',
    };

    if (!parsed.json) {
      console.log(`Created recipe skeleton: ${outputPath}`);
      console.log(`  ID:       ${id}`);
      console.log(`  Category: ${category}`);
      console.log(`  Risk:     ${risk}`);
      if (riskWarnings[risk]) console.log(riskWarnings[risk]);
      console.log('\n  Edit the file to define your inputs, steps, and guardrails.');
    } else {
      console.log(JSON.stringify({ created: outputPath, id, category, risk }));
    }
    process.exit(0);
  }

  return false;
}
