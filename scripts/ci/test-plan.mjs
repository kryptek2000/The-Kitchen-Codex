#!/usr/bin/env node
/**
 * Deterministic test-plan generator for The Kitchen Codex CI.
 *
 * The full Vitest suite is split into four exclusive groups:
 *   - security: tests/security/**
 *   - heavy:    non-security Nutrition / USDA / SHISO / AI planning tests
 *   - desktop:  desktop, Vault, asset, and image pipeline tests
 *   - fast:     every remaining unit/src test
 *
 * Every *.test.* / *.spec.* file discovered by the Vitest include patterns is
 * assigned to exactly one group. `--check` fails if the union is incomplete or
 * any file is assigned more than once. Heavy/security shards are balanced with
 * measured costs where available and a conservative default otherwise.
 *
 * No test is skipped; this script only decides which CI job executes it.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_ROOTS = ['tests', 'src'];
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;
const SECURITY_PREFIX = 'tests/security/';

const HEAVY_PATTERN = /(advancedNutrition|nutrition|usda|basicNutrition|gardenHarvest|wholeRecipe|recipeNutrition|shiso)/i;
const DESKTOP_PATTERN = /(desktop|vault|sessionAssets|useVaultImageScope|pluginRecipePersistence|recipeContentPreservation|asset|editorImage|recipeImage|protectedImage|protectedPreview|representativeImage|noAutoImageGeneration|grabber|obsidian|vaultIntelligence|downloadImage|imageHealth|imageChooser|recipeEditor)/i;

// Measured costs in seconds from the preserved local marathon evidence. These
// only balance shards; they do not alter test execution or assertions.
const MEASURED_COST_SECONDS = {
  'tests/unit/advancedNutritionAi6b2PortionDisposition.test.ts': 338,
  'tests/unit/advancedNutritionAi6b3IdentityDisposition.test.ts': 322,
  'tests/unit/advancedNutritionAi6b4RankingDisposition.test.ts': 313,
  'tests/unit/advancedNutritionAi6b5CatalogDisposition.test.ts': 306,
  'tests/security/shisoH1Repairs.test.ts': 304,
  'tests/security/shisoH2Editing.test.ts': 290,
  'tests/unit/advancedNutritionAi6aRealBundle.test.ts': 249,
  'tests/security/shisoCompletion.test.ts': 238,
  'tests/security/shisoAuditRepairs.test.ts': 225,
  'tests/security/shisoH1fRepairs.test.ts': 218,
  'tests/unit/usdaBundleForgery.test.ts': 187,
  'tests/unit/advancedNutritionIdentityCorpus.test.ts': 140,
  'tests/unit/advancedNutritionPhase6Household.test.ts': 128,
  'tests/unit/advancedNutritionPhase7AiHouseholdAlignment.test.ts': 123,
  'tests/unit/advancedNutritionAutoAnalyzerSmoke.test.ts': 118,
  'tests/unit/basicNutritionServingsFix.test.tsx': 109,
  'tests/unit/advancedNutritionAiAdvancedBenchmarkFoundation.test.ts': 106,
  'tests/unit/advancedNutritionPhase1ParsingCorpus.test.ts': 104,
  'tests/unit/advancedNutritionAi4aAuthorityDifferential.test.ts': 94,
  'tests/unit/advancedNutritionBundleLoader.test.ts': 92,
  'tests/unit/basicNutrition.test.tsx': 90,
  'tests/unit/advancedNutritionIdentityParity.test.ts': 88,
  'tests/unit/advancedNutritionAi3M53RealSession.test.ts': 84,
  'tests/unit/advancedNutritionPhase2RealBundle.test.ts': 82,
  'tests/unit/advancedNutritionPhase3Corpus.test.ts': 72,
  'tests/unit/favoritesConcurrency.test.tsx': 25,
};

function walk(directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, output);
    else if (stat.isFile() && TEST_FILE.test(entry)) {
      output.push(relative(ROOT, full).replaceAll('\\', '/'));
    }
  }
}

function discoverFiles() {
  const files = [];
  for (const root of TEST_ROOTS) walk(join(ROOT, root), files);
  return [...new Set(files)].sort();
}

function categorize(file) {
  if (file.startsWith(SECURITY_PREFIX)) return 'security';
  const base = file.split('/').pop() || '';
  if (HEAVY_PATTERN.test(base)) return 'heavy';
  if (DESKTOP_PATTERN.test(base)) return 'desktop';
  return 'fast';
}

function cost(file) {
  if (MEASURED_COST_SECONDS[file] !== undefined) return MEASURED_COST_SECONDS[file];
  const category = categorize(file);
  return category === 'security' || category === 'heavy' ? 20 : 10;
}

function buildGroups(files) {
  const groups = { fast: [], heavy: [], security: [], desktop: [] };
  for (const file of files) groups[categorize(file)].push(file);
  return groups;
}

function balancedShards(files, shardCount) {
  const shards = Array.from({ length: shardCount }, () => ({ cost: 0, files: [] }));
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  for (const file of ordered) {
    let target = 0;
    for (let index = 1; index < shards.length; index += 1) {
      if (shards[index].cost < shards[target].cost) target = index;
    }
    shards[target].cost += cost(file);
    shards[target].files.push(file);
  }
  return shards.map((shard) => ({
    cost: shard.cost,
    files: shard.files.sort((a, b) => a.localeCompare(b)),
  }));
}

function printGroupSummary(groups) {
  for (const [name, files] of Object.entries(groups)) {
    console.log(`${name.padEnd(9)} ${String(files.length).padStart(3)} files  cost=${files.reduce((sum, file) => sum + cost(file), 0)}s`);
  }
  const heavyShards = balancedShards(groups.heavy, 4);
  const securityShards = balancedShards(groups.security, 2);
  console.log('heavy shards:');
  heavyShards.forEach((shard, index) => console.log(`  ${index + 1}/4 ${String(shard.files.length).padStart(3)} files cost=${shard.cost}s`));
  console.log('security shards:');
  securityShards.forEach((shard, index) => console.log(`  ${index + 1}/2 ${String(shard.files.length).padStart(3)} files cost=${shard.cost}s`));
}

function parseArgs(argv) {
  const args = { check: false, group: '', shard: '', listFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--check') args.check = true;
    else if (current === '--group') args.group = argv[++index] || '';
    else if (current === '--shard') args.shard = argv[++index] || '';
    else if (current === '--list-file') args.listFile = argv[++index] || '';
    else throw new Error(`Unknown argument: ${current}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = discoverFiles();
  if (files.length === 0) throw new Error('No test files discovered.');
  const groups = buildGroups(files);
  const assigned = Object.values(groups).flat();
  const unique = new Set(assigned);
  if (assigned.length !== files.length || unique.size !== files.length) {
    throw new Error(
      `Test plan coverage failure: discovered=${files.length} assigned=${assigned.length} unique=${unique.size}`
    );
  }
  const sortedDiscovered = [...files].sort();
  const sortedAssigned = [...unique].sort();
  if (JSON.stringify(sortedDiscovered) !== JSON.stringify(sortedAssigned)) {
    throw new Error('Test plan coverage failure: assigned set differs from discovered set.');
  }

  if (args.check && !args.group) {
    printGroupSummary(groups);
    console.log(`coverage=complete files=${files.length}`);
    return;
  }

  if (!args.group || !args.listFile) {
    throw new Error('Use --check, or --group <fast|heavy|security|desktop> --list-file <path> [--shard i/n]');
  }

  let selected;
  if (args.group === 'fast' || args.group === 'desktop') {
    if (args.shard) throw new Error(`--shard is not supported for ${args.group}`);
    selected = groups[args.group];
  } else if (args.group === 'heavy' || args.group === 'security') {
    const match = /^(\d+)\/(\d+)$/.exec(args.shard);
    if (!match) throw new Error(`--shard must be i/n for ${args.group}`);
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (index < 1 || count < 1 || index > count) throw new Error('Invalid shard index/count.');
    const shards = balancedShards(groups[args.group], count);
    selected = shards[index - 1].files;
    console.error(`${args.group} shard ${index}/${count}: ${selected.length} files, cost=${shards[index - 1].cost}s`);
  } else {
    throw new Error(`Unknown group: ${args.group}`);
  }

  const listPath = resolve(args.listFile);
  mkdirSync(dirname(listPath), { recursive: true });
  writeFileSync(listPath, selected.join('\n') + (selected.length ? '\n' : ''), 'utf8');
  console.log(`${args.group}${args.shard ? ` ${args.shard}` : ''}: ${selected.length} files -> ${listPath}`);
}

main();
