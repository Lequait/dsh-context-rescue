/**
 * Locates an installed DeepSeek Harness app without embedding anyone's home directory.
 *
 * The dev gates here run inside the app's own Node (`ELECTRON_RUN_AS_NODE`), because only
 * Electron's patched `fs` can read the host packages that live inside `app.asar`. Some
 * builds ship the host packages unpacked instead — `resources/app/dsh/node_modules/…` —
 * so a root may be an asar file or a plain directory, and both are accepted here.
 *
 * Both discovery lists are ordered: the environment override first, then the platform
 * default, most specific first.
 *
 * @module dsh-context-rescue/host-paths
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Names the app executable has shipped under. */
const APP_NAMES = ['DSH NEXT', 'DeepSeek Harness', 'DSH'];

/** @returns {string[]} candidate paths of the app executable, most specific first */
export function dshAppExeCandidates() {
  /** @type {Array<string | undefined>} */
  const candidates = [process.env.DSH_APP_EXE];
  for (const root of [process.env.LOCALAPPDATA ?? '', process.env.PROGRAMFILES ?? '']) {
    if (root === '') continue;
    for (const name of APP_NAMES) candidates.push(path.join(root, 'Programs', name, `${name}.exe`));
  }
  for (const name of APP_NAMES) candidates.push(`/Applications/${name}.app/Contents/MacOS/${name}`);
  return /** @type {string[]} */ (candidates.filter((candidate) => typeof candidate === 'string' && candidate !== ''));
}

/** Directories inside an installation that can hold `node_modules/@deepseek-ai/*`. */
const ROOT_SUFFIXES = [
  'resources/app.asar',
  'resources/app/dsh',
  'resources/app',
  'Contents/Resources/app.asar',
  'Contents/Resources/app/dsh',
  'Contents/Resources/app',
];

/**
 * Candidate host roots: a directory or an `app.asar` file that contains
 * `node_modules/@deepseek-ai/*`. The environment overrides come first.
 * @returns {string[]}
 */
export function dshHostRootCandidates() {
  /** @type {Array<string | undefined>} */
  const candidates = [
    process.env.DSH_HOST_ROOT,
    process.env.DSH_ASAR,
    process.env.DSH_APP_ASAR,
  ];
  for (const exe of dshAppExeCandidates()) {
    const installDir = exe.endsWith('.app/Contents/MacOS/' + path.basename(exe)) || exe.includes('.app/Contents/')
      ? exe.slice(0, exe.indexOf('.app/Contents/') + 4)
      : path.dirname(exe);
    for (const suffix of ROOT_SUFFIXES) candidates.push(path.join(installDir, suffix));
  }
  return /** @type {string[]} */ (candidates.filter((candidate) => typeof candidate === 'string' && candidate !== ''));
}

/**
 * Backwards-compatible alias: the roots that look like an `app.asar` file.
 * @returns {string[]}
 */
export function dshAsarCandidates() {
  return dshHostRootCandidates().filter((candidate) => candidate.endsWith('.asar'));
}

/** The one file whose presence proves a root is a host root. */
const PROBE = 'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';

/**
 * Pick the first candidate root that actually contains the host packages.
 * @param {{explicit?: string}} [options] an explicit `--dsh-root`, tried first
 * @returns {{root: string, tried: string[]}}
 * @throws when no candidate contains the probe file; the message lists what was tried
 */
export function resolveHostRoot(options = {}) {
  const tried = [options.explicit, ...dshHostRootCandidates()].filter(
    (candidate) => typeof candidate === 'string' && candidate !== '',
  );
  for (const root of tried) {
    try {
      if (existsSync(path.join(root, PROBE))) return { root, tried };
    } catch {
      // An unreadable candidate (asar without the host's patched fs) is just a miss.
    }
  }
  const shown = tried.length === 0 ? '  (no candidates were derived from this environment)' : tried.map((root) => `  ${root}`).join('\n');
  throw new Error(
    `no DeepSeek Harness installation found: none of these roots contains ${PROBE}\n${shown}\n`
    + 'Pass --dsh-root <path> (or set DSH_HOST_ROOT / DSH_ASAR) to point at the install; '
    + 'plain Node cannot read inside an app.asar, so run that through the host\'s own Node.',
  );
}
