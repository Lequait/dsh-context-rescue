/**
 * Builds the format-1 plugin market index document for this plugin.
 *
 * Pure data: no I/O, no host imports. `scripts/make-market-index.mjs` feeds it and then
 * validates the result with the host's own `parseMarketIndex`; the unit test builds the same
 * document to assert the rules this repository controls (name, version, source shape,
 * localized text with `en`, inline icon size).
 *
 * @module dsh-context-rescue/market-index
 */

const MAX_INLINE_ICON_BYTES = 32 * 1024;

const CATEGORY = { id: 'context', en: 'Context', zh: '上下文' };
const CATEGORY_DIAGNOSTICS = { id: 'diagnostics', en: 'Diagnostics', zh: '诊断' };

const LABELS = [
  { id: 'recovery', en: 'Recovery', zh: '恢复' },
  { id: 'zero-model', en: 'Zero-model', zh: '零模型' },
  { id: 'overflow', en: 'Overflow', zh: '溢出' },
];

/**
 * @param {object} input
 * @param {string} input.name package name
 * @param {string} input.version exact SemVer version
 * @param {string} [input.author]
 * @param {string} [input.dshRange] SemVer range for `engines.dsh`
 * @param {string} [input.repo] HTTPS repository URL; omit for an npm-sourced version
 * @param {string} [input.commit] lowercase 40-hex commit for a Git-sourced version
 * @param {string} [input.iconSvg] SVG source; embedded as a `data:` URL
 * @param {number} [input.publishTimestamp] Unix seconds
 * @returns {object} the index document
 */
export function buildMarketIndexDoc(input) {
  const {
    name,
    version,
    author = 'The dsh-context-rescue authors',
    dshRange = '>=0.2.0-rc.1',
    repo,
    commit,
    iconSvg,
    publishTimestamp = Math.floor(Date.now() / 1000),
  } = input;

  const source =
    repo === undefined
      ? { type: 'npm' }
      : { type: 'git', url: repo.replace(/\/+$/u, ''), commit };

  return {
    format: 1,
    title: { en: 'Context Rescue', zh: '上下文急救' },
    description: {
      en: 'Emergency rescue for DSH sessions that are past the context window.',
      zh: '把已经越过上下文窗口、压缩也救不回来的 DSH 会话救回来的急救插件。',
    },
    metadata: {
      categories: {
        [CATEGORY.id]: { title: { en: CATEGORY.en, zh: CATEGORY.zh } },
        [CATEGORY_DIAGNOSTICS.id]: {
          title: { en: CATEGORY_DIAGNOSTICS.en, zh: CATEGORY_DIAGNOSTICS.zh },
        },
      },
      labels: Object.fromEntries(LABELS.map((label) => [label.id, { title: { en: label.en, zh: label.zh } }])),
      sortKeys: {},
    },
    plugins: [
      {
        name,
        title: { en: 'Context Rescue', zh: '上下文急救' },
        description: {
          en: 'Rescues a session that already overflowed the model window: fold tool noise, fold the surface mechanically, and retry the step. Never calls the model to do it.',
          zh: '会话已经超出模型窗口时急救：折叠工具噪声、机械折叠投影、重试本轮。整个过程不调用模型。',
        },
        ...(iconSvg === undefined
          ? {}
          : { icon: `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}` }),
        author,
        metadata: {
          category: CATEGORY.id,
          keywords: ['context-window', 'compaction', 'recovery', 'session', 'rescue'],
          labels: LABELS.map((label) => label.id),
          sortKeys: {},
        },
        versions: [
          {
            version,
            publishTimestamp,
            source,
            engines: { dsh: dshRange },
          },
        ],
      },
    ],
  };
}

/**
 * Checks the rules this repository owns, without the host validator. Used by the unit test;
 * `parseMarketIndex` remains the authority on the whole document.
 *
 * @param {object} doc
 * @returns {string[]} problems, empty when the document satisfies them
 */
export function checkMarketIndexDoc(doc) {
  const problems = [];
  if (doc?.format !== 1) problems.push('format must be 1');
  if (typeof doc?.title?.en !== 'string' || doc.title.en.trim() === '') problems.push('title must carry en');

  const plugins = Array.isArray(doc?.plugins) ? doc.plugins : [];
  if (plugins.length === 0) problems.push('plugins must not be empty');

  for (const plugin of plugins) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(String(plugin?.name))) {
      problems.push(`${String(plugin?.name)} is not a valid npm package name`);
    }
    if (plugin?.description !== undefined && typeof plugin.description.en !== 'string') {
      problems.push(`${String(plugin?.name)} description must carry en`);
    }
    if (typeof plugin?.icon === 'string' && plugin.icon.startsWith('data:')) {
      const payload = plugin.icon.slice(plugin.icon.indexOf(',') + 1);
      const bytes = Buffer.from(payload, 'base64').length;
      if (bytes > MAX_INLINE_ICON_BYTES) problems.push(`${String(plugin?.name)} icon exceeds 32 KiB`);
    }

    const versions = Array.isArray(plugin?.versions) ? plugin.versions : [];
    if (versions.length === 0) problems.push(`${String(plugin?.name)} must list a version`);
    for (const entry of versions) {
      if (typeof entry?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(entry.version)) {
        problems.push(`${String(entry?.version)} is not an exact SemVer version`);
      }
      if (!Number.isInteger(entry?.publishTimestamp) || entry.publishTimestamp < 0) {
        problems.push(`${String(entry?.version)} needs an integer publishTimestamp`);
      }
      if (entry?.source?.type === 'git') {
        if (!/^[0-9a-f]{40}$/u.test(String(entry.source.commit))) {
          problems.push(`${String(entry?.version)} git source needs a 40-hex commit`);
        }
        if (!/^https:\/\/[^/]+(?:\/[^/]+){2,}$/u.test(String(entry.source.url))) {
          problems.push(`${String(entry?.version)} git source needs a canonical https repository URL`);
        }
      } else if (entry?.source?.type !== 'npm') {
        problems.push(`${String(entry?.version)} source must be npm or git`);
      }
      if (entry?.engines?.dsh !== undefined && !/^[<>=~^0-9]/u.test(String(entry.engines.dsh))) {
        problems.push(`${String(entry?.version)} engines.dsh must be a SemVer range`);
      }
    }
  }
  return problems;
}
