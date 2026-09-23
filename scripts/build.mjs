import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = spawnSync(process.execPath, ['--check', resolve(root, 'public/app.js')], {encoding: 'utf8'});
if (check.status !== 0) throw new Error(`JavaScript syntax check failed: ${check.stderr}`);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = {name: pkg.name, version: pkg.version, backend: 'local-sqlite', files: {}};
await mkdir(resolve(root, 'dist'), {recursive: true});
for (const name of ['index.html', 'app.js', 'styles.css']) {
  const source = resolve(root, 'public', name);
  const bytes = await readFile(source);
  await copyFile(source, resolve(root, 'dist', name));
  manifest.files[name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(resolve(root, 'dist/build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('Independent library UI built: 3 static files, JavaScript syntax checked, SHA256 manifest written.');
