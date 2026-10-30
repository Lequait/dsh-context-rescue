/**
 * Locates an installed DeepSeek Harness app without embedding anyone's home directory.
 *
 * The dev gates here run inside the app's own Node (`ELECTRON_RUN_AS_NODE`), because only
 * Electron's patched `fs` can read the host packages that live inside `app.asar`. Both
 * discovery lists are ordered: the environment override first, then the platform default.
 *
 * @module dsh-context-rescue/host-paths
 */
import path from 'node:path';

/** @returns {string[]} candidate paths of the app executable, most specific first */
export function dshAppExeCandidates() {
  const candidates = [process.env.DSH_APP_EXE];
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.PROGRAMFILES ?? '';
  if (localAppData !== '') {
    candidates.push(path.join(localAppData, 'Programs/DSH NEXT/DSH NEXT.exe'));
  }
  if (programFiles !== '') candidates.push(path.join(programFiles, 'DSH NEXT/DSH NEXT.exe'));
  candidates.push('/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT');
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate !== '');
}

/** @returns {string[]} candidate paths of `app.asar`, most specific first */
export function dshAsarCandidates() {
  const candidates = [process.env.DSH_APP_ASAR, process.env.DSH_ASAR];
  for (const exe of dshAppExeCandidates()) {
    candidates.push(path.join(path.dirname(exe), 'resources/app.asar'));
    candidates.push(path.join(exe, 'Contents/Resources/app.asar'));
  }
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate !== '');
}
