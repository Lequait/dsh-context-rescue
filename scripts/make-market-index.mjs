#!/usr/bin/env node
/**
 * Generates the format-1 plugin market index entry for this plugin and validates it with the
 * host's own `parseMarketIndex`, so a listing is checked by the same code DSH uses to read
 * indexes — not by a hand-written copy of the rules.
 *
 * Usage:
 *   node scripts/make-market-index.mjs --repo https://github.com/OWNER/dsh-context-rescue \
 *     --commit <40-hex> --out market/index.json
 *   node scripts/make-market-index.mjs --npm --index-url https://example.com/index.json
 *
 * `--repo`/`--commit` describe the Git source a reader installs from. `--npm` switches the
 * version source to the npm registry instead. `--repo-slug OWNER/NAME` derives the URL and the
 * index URL from a GitHub slug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildMarketIndexDoc, checkMarketIndexDoc } from '../lib/market-index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASAR_DEFAULT = 'C:/Users/Vashiya/AppData/Local/Programs/DSH NEXT/resources/app.asar';

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

/** The host package's absolute entry, so no bare specifier has to resolve. */
function marketIndexLib() {
  const asar = process.env.DSH_APP_ASAR || ASAR_DEFAULT;
  const file = path.join(asar, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Cannot find the host validator at ${file}. Set DSH_APP_ASAR to the app.asar of an installed DSH.`,
    );
  }
  return `file://${file.replaceAll('\\', '/')}`;
}

function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const useNpm = argOf('npm', false) === true;
  const slug = argOf('repo-slug', undefined);
  const repo = argOf(
    'repo',
    typeof slug === 'string' ? `https://github.com/${slug}` : undefined,
  );
  const commit = argOf('commit', useNpm ? undefined : headCommit());
  const indexUrl = argOf(
    'index-url',
    typeof repo === 'string' && repo.startsWith('https://github.com/')
      ? `${repo.replace(/\/+$/u, '')}/raw/main/market/index.json`
      : 'https://raw.githubusercontent.com/OWNER/dsh-context-rescue/main/market/index.json',
  );
  const out = argOf('out', undefined);

  if (!useNpm) {
    if (typeof repo !== 'string') {
      throw new Error('--repo <https URL> (or --repo-slug OWNER/NAME) is required unless --npm is passed');
    }
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
      throw new Error(`--commit must be a lowercase 40-hex commit SHA (got ${String(commit)})`);
    }
  }

  const doc = buildMarketIndexDoc({
    name: pkg.name,
    version: pkg.version,
    author: pkg.author?.name ?? pkg.author ?? 'The dsh-context-rescue authors',
    dshRange: pkg.engines?.dsh ?? '>=0.2.0-rc.1',
    repo: useNpm ? undefined : repo,
    commit: useNpm ? undefined : commit,
    iconSvg: fs.readFileSync(path.join(ROOT, 'market/icon.svg'), 'utf8'),
  });

  return { doc, indexUrl, out };
}

const { doc, indexUrl, out } = main();

const problems = checkMarketIndexDoc(doc);
if (problems.length > 0) {
  process.stderr.write(`index doc is invalid:\n- ${problems.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  const { parseMarketIndex, marketInstallTarget } = await import(marketIndexLib());
  const parsed = parseMarketIndex(doc, indexUrl);
  const plugin = parsed.plugins[0];
  const target = marketInstallTarget(plugin.name, plugin.versions[0]);

  process.stdout.write(
    [
      `index      ${indexUrl}`,
      `plugin     ${plugin.name} v${plugin.versions[0].version}`,
      `source     ${plugin.versions[0].source.type}`,
      `install    ${target.spec}`,
      `engines    dsh ${plugin.versions[0].engines.dsh ?? '(none)'}`,
      `icon       ${String(Buffer.from(plugin.icon.split(',')[1], 'base64').length)} bytes inline`,
      'validated  by the host parseMarketIndex',
    ].join('\n') + '\n',
  );

  if (typeof out === 'string') {
    fs.writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(parsed, undefined, 2)}\n`);
    process.stdout.write(`wrote      ${out}\n`);
  }
}
