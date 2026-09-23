import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const result = {node: process.versions.node, platform: `${process.platform}/${process.arch}`, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24, sqliteWritable: false, externalServicesRequiredForResearch: true};
let scratch;
try {
  if (!result.nodeSupported) throw new Error('Node.js 24 or newer is required.');
  const {DatabaseSync} = await import('node:sqlite');
  scratch = await mkdtemp(join(tmpdir(), 'library-doctor-'));
  const db = new DatabaseSync(join(scratch, 'check.sqlite'));
  try {
    db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('local')");
    result.sqliteWritable = db.prepare('SELECT value FROM probe').get().value === 'local';
    result.sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  } finally { db.close(); }
  result.note = 'Runtime and temporary SQLite write checked. Your configured data directory is checked on server startup; lifecycle acceptance is separate.';
} catch (error) {
  result.error = error.code || 'RUNTIME_CHECK_FAILED';
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, {recursive: true, force: true});
}
const root=fileURLToPath(new URL('../',import.meta.url));
const localPython=resolve(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.GENERAL_PYTHON || (existsSync(localPython)?localPython:'python3');
const parser=spawnSync(python,['-c','import sys,pypdf,docx,lxml; assert sys.version_info >= (3,11); print(pypdf.__version__,docx.__version__,lxml.__version__)'],{encoding:'utf8',timeout:15000});
result.pdfDocxParser=parser.status===0;
result.parserVersions=parser.status===0?parser.stdout.trim():null;
result.frontendBuilt=existsSync(resolve(root,'../web/dist-general/general.html'));
result.modelAndSearchConnectivity='NOT_TESTED';
if(!result.pdfDocxParser || !result.frontendBuilt) process.exitCode=1;
console.log(JSON.stringify(result, null, 2));
