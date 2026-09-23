import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, '../web');
const stage = resolve(root, '.build/web');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
await mkdir(stage, {recursive:true});
await rm(resolve(stage,'src'), {recursive:true,force:true});
// Explicit dependency closure: no original App, business routes, databases, or .env.
const inputs = ['package.json','package-lock.json','general.html','vite.general.config.js',
  'src/general-main.jsx','src/styles.css','src/responsive-nav.css','src/theme.css','src/ux.jsx',
  'src/features/general-research','src/features/deep-thinking/deep-event-stream.js'];
for (const name of inputs) {
  await mkdir(dirname(resolve(stage,name)), {recursive:true});
  await cp(resolve(web,name), resolve(stage,name), {recursive:true});
}
function run(command,args,options={}) {
  const child = spawnSync(command,args,{cwd:stage,stdio:'inherit',env:{...process.env,npm_config_cache:resolve(root,'.build/npm-cache'),npm_config_update_notifier:'false'},...options});
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Build command exited ${child.status}`);
}
// npm run build provides npm_execpath; direct launches may specify GENERAL_NPM_CLI.
const npmCli = process.env.GENERAL_NPM_CLI || process.env.npm_execpath;
if (npmCli) run(process.execPath,[npmCli,'ci','--ignore-scripts','--no-audit','--no-fund']);
else if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe',['/d','/s','/c','npm.cmd ci --ignore-scripts --no-audit --no-fund']);
else run('npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
const target=resolve(web,'dist-general');
if (!existsSync(resolve(stage,'node_modules/vite/bin/vite.js'))) throw new Error('Vite dependency is missing.');
run(process.execPath,['node_modules/vite/bin/vite.js','build','--config','vite.general.config.js','--outDir',target,'--emptyOutDir']);
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
await writeFile(resolve(target,'build-manifest.json'),JSON.stringify({version:pkg.version,entry:'general.html',
  lockSha256:createHash('sha256').update(await readFile(resolve(web,'package-lock.json'))).digest('hex'),
  isolatedFromOriginalEntry:true},null,2)+'\n');
console.log('General workbench built. Original dependencies and configuration were not modified.');
