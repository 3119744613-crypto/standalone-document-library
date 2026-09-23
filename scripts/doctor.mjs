import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const result = {node: process.versions.node, platform: `${process.platform}/${process.arch}`, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24, sqliteWritable: false, externalServicesRequired: false};
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
console.log(JSON.stringify(result, null, 2));
