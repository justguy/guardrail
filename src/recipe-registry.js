import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildIndex, deduplicateLatest } from './recipe-index.js';

function sortRecipes(recipes) {
  return [...recipes].sort((a, b) => (
    a.category.localeCompare(b.category)
    || a.id.localeCompare(b.id)
    || a.version.localeCompare(b.version)
  ));
}

function compareSemverDesc(left, right) {
  const a = (left || '0.0.0').split('.').map(Number);
  const b = (right || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) - (a[i] || 0);
  }
  return 0;
}

function recipeSummary(entry, versions = []) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category ?? 'custom',
    latest_version: entry.version,
    versions,
    risk_level: entry.risk_level,
    channel: entry.channel ?? 'community',
    approval_required: entry.approval_required === true,
    tags: entry.tags ?? [],
  };
}

export function buildRecipeRegistrySnapshot(searchDirs = []) {
  const allEntries = sortRecipes(buildIndex(searchDirs));
  const latestEntries = sortRecipes(deduplicateLatest(allEntries));
  const versionMap = new Map();
  const entryMap = new Map();

  for (const entry of allEntries) {
    const key = `${entry.category ?? 'custom'}:${entry.id}`;
    if (!versionMap.has(key)) versionMap.set(key, []);
    versionMap.get(key).push({
      version: entry.version,
      channel: entry.channel ?? 'community',
      risk_level: entry.risk_level,
      approval_required: entry.approval_required === true,
      tags: entry.tags ?? [],
    });
    entryMap.set(`${key}:${entry.version}`, entry);
  }

  const recipes = latestEntries.map((entry) => {
    const key = `${entry.category ?? 'custom'}:${entry.id}`;
    const versions = (versionMap.get(key) || []).sort((a, b) => compareSemverDesc(a.version, b.version));
    return {
      summary: recipeSummary(entry, versions.map((version) => version.version)),
      latest: entry,
      versions,
    };
  });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    count: recipes.length,
    recipes,
    entryMap,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function exportRecipeRegistry(outputDir, searchDirs = []) {
  const outDir = resolve(outputDir);
  const snapshot = buildRecipeRegistrySnapshot(searchDirs);
  const recipesRoot = join(outDir, 'v1', 'recipes');

  writeJson(join(recipesRoot, 'index.json'), {
    version: snapshot.version,
    generated_at: snapshot.generated_at,
    count: snapshot.count,
    recipes: snapshot.recipes.map((recipe) => recipe.summary),
  });

  for (const recipe of snapshot.recipes) {
    const recipeRoot = join(recipesRoot, recipe.summary.category, recipe.summary.id);
    writeJson(join(recipeRoot, 'index.json'), {
      ...recipe.summary,
      versions_path: `/v1/recipes/${recipe.summary.category}/${recipe.summary.id}/versions`,
      latest_path: `/v1/recipes/${recipe.summary.category}/${recipe.summary.id}/versions/${recipe.summary.latest_version}.json`,
    });
    writeJson(join(recipeRoot, 'versions', 'index.json'), {
      id: recipe.summary.id,
      category: recipe.summary.category,
      latest_version: recipe.summary.latest_version,
      versions: recipe.versions,
    });

    for (const version of recipe.versions) {
      const entry = snapshot.entryMap.get(`${recipe.summary.category}:${recipe.summary.id}:${version.version}`);
      if (entry) {
        writeJson(join(recipeRoot, 'versions', `${version.version}.json`), entry);
      }
    }
  }

  return {
    outputDir: outDir,
    generatedAt: snapshot.generated_at,
    count: snapshot.count,
  };
}
