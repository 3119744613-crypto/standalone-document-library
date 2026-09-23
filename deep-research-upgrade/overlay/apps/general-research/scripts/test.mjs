import {readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const ownPython=resolve(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(!process.env.GENERAL_PYTHON && existsSync(ownPython)) process.env.GENERAL_PYTHON=ownPython;
const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
if (!tests.length) throw new Error('No test files found.');
const result = spawnSync(process.execPath, ['--test', ...tests], {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
