import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if (Number(process.versions.node.split('.')[0])<24) throw new Error('Node.js 24+ is required.');
const python=process.env.GENERAL_PYTHON || (process.platform==='win32'?'python':'python3');
function run(command,args) {
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`Setup failed with exit ${result.status}. Existing application files were preserved.`);
}
run(python,['-c','import sys; assert sys.version_info >= (3,11), "Python 3.11+ is required"']);
const venv=resolve(root,'.venv');
const localPython=resolve(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(!existsSync(localPython)) run(python,['-m','venv',venv]);
run(localPython,['-m','pip','install','--disable-pip-version-check','-r','requirements-parser.txt']);
run(process.execPath,['scripts/build.mjs']);
console.log('Setup complete. Copy .env.example to .env.general and fill your own model/search configuration when ready. Then run npm start.');
