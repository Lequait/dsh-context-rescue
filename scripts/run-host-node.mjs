#!/usr/bin/env node
/**
 * Runs the installed DSH app's own Node (Electron in `ELECTRON_RUN_AS_NODE` mode) with the
 * given arguments.
 *
 * Two gates need it: reading anything inside `app.asar` (the host validator, the host cordis
 * container) only works with Electron's patched `fs`, and running the suite there proves the
 * plugin against the same runtime the app uses. `node` alone silently skips those tests.
 *
 * Usage: node scripts/run-host-node.mjs [--test] [script.mjs ...]
 * Env:   DSH_APP_EXE  path to the app executable, when it is not in a default location
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  process.env.DSH_APP_EXE,
  'C:/Users/Vashiya/AppData/Local/Programs/DSH NEXT/DSH NEXT.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DSH NEXT/DSH NEXT.exe'),
  path.join(process.env.PROGRAMFILES ?? '', 'DSH NEXT/DSH NEXT.exe'),
  '/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT',
].filter((candidate) => typeof candidate === 'string' && candidate !== '');

const exe = CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (exe === undefined) {
  process.stderr.write(
    [
      'Cannot find an installed DSH app executable. Looked at:',
      ...CANDIDATES.map((candidate) => `  ${candidate}`),
      'Set DSH_APP_EXE to the app executable and try again.',
    ].join('\n') + '\n',
  );
  process.exit(1);
}

const child = spawn(exe, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
