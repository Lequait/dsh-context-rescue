import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildMarketIndexDoc, checkMarketIndexDoc } from '../lib/market-index.js';

const ICON = fs.readFileSync(path.join(import.meta.dirname, '../market/icon.svg'), 'utf8');
const COMMIT = 'd147a9e8b12c339f6c6ebb1408c39b7f81f2343f';

function gitDoc(overrides = {}) {
  return buildMarketIndexDoc({
    name: 'dsh-context-rescue',
    version: '0.1.0',
    repo: 'https://github.com/OWNER/dsh-context-rescue',
    commit: COMMIT,
    iconSvg: ICON,
    publishTimestamp: 1_790_000_000,
    ...overrides,
  });
}

test('a Git-sourced entry satisfies the rules this repository owns', () => {
  assert.deepEqual(checkMarketIndexDoc(gitDoc()), []);
});

test('an npm-sourced entry needs no commit', () => {
  const doc = buildMarketIndexDoc({
    name: 'dsh-context-rescue',
    version: '0.1.0',
    iconSvg: ICON,
    publishTimestamp: 1_790_000_000,
  });
  assert.deepEqual(checkMarketIndexDoc(doc), []);
  assert.deepEqual(doc.plugins[0].versions[0].source, { type: 'npm' });
});

test('the icon is an inline data URL well under the 32 KiB ceiling', () => {
  const icon = gitDoc().plugins[0].icon;
  assert.match(icon, /^data:image\/svg\+xml;base64,/u);
  assert.ok(Buffer.from(icon.split(',')[1], 'base64').length < 32 * 1024);
});

test('localized text always carries en', () => {
  const doc = gitDoc();
  assert.equal(typeof doc.title.en, 'string');
  assert.equal(typeof doc.plugins[0].title.en, 'string');
  assert.equal(typeof doc.plugins[0].description.en, 'string');
});

test('the checker rejects a short commit, a bad name, and a missing en', () => {
  const shortCommit = gitDoc();
  shortCommit.plugins[0].versions[0].source.commit = 'deadbeef';
  assert.ok(checkMarketIndexDoc(shortCommit).some((problem) => /40-hex/u.test(problem)));

  const badName = gitDoc();
  badName.plugins[0].name = 'Dsh Context Rescue';
  assert.ok(checkMarketIndexDoc(badName).some((problem) => /npm package name/u.test(problem)));

  const noEnglish = gitDoc();
  noEnglish.title = { zh: '上下文急救' };
  assert.ok(checkMarketIndexDoc(noEnglish).some((problem) => /must carry en/u.test(problem)));
});

/** The host validator is the authority; run it when an installed DSH can be found. */
test('the host parseMarketIndex accepts the document', async (t) => {
  const asar =
    process.env.DSH_APP_ASAR ??
    'C:/Users/Vashiya/AppData/Local/Programs/DSH NEXT/resources/app.asar';
  const lib = path.join(asar, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js');
  if (!fs.existsSync(lib)) {
    t.skip(`no installed host validator at ${lib}`);
    return;
  }

  const { parseMarketIndex, marketInstallTarget } = await import(
    `file://${lib.replaceAll('\\', '/')}`
  );
  const parsed = parseMarketIndex(
    gitDoc(),
    'https://github.com/OWNER/dsh-context-rescue/raw/main/market/index.json',
  );
  assert.equal(parsed.format, 1);
  assert.equal(parsed.plugins.length, 1);
  assert.equal(parsed.plugins[0].name, 'dsh-context-rescue');
  assert.equal(parsed.plugins[0].versions[0].engines.dsh, '>=0.2.0-rc.1');
  assert.equal(
    marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]).spec,
    `git+https://github.com/OWNER/dsh-context-rescue.git#${COMMIT}`,
  );
});
