import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/verify-upstream.mjs /absolute/path/to/Yuxi');
const sourceRoot = resolve(source);
const lock = JSON.parse(await readFile(resolve(moduleRoot, 'upstream.lock.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim();
if (commit !== lock.commit) throw new Error('Yuxi commit differs from the reviewed version; this optional design-reference check requires the recorded commit.');
let checked = 0;
for (const entry of lock.source_files) {
  if (isAbsolute(entry.path) || entry.path.split('/').includes('..')) throw new Error('Invalid path in source lock.');
  const bytes = await readFile(resolve(sourceRoot, entry.path));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== entry.sha256) throw new Error(`Source hash mismatch: ${entry.path}`);
  checked++;
}
const originalNotice = await readFile(resolve(sourceRoot, 'LICENSE'));
const preservedNotice = await readFile(resolve(moduleRoot, 'third-party/YUXI-LICENSE'));
if (!originalNotice.equals(preservedNotice)) throw new Error('Preserved Yuxi license differs from upstream.');
console.log(JSON.stringify({commit, checkedFiles: checked, licenseMatches: true, liveHttpVerified: false}, null, 2));
