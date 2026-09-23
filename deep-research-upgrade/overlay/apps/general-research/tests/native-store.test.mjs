import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LibraryStore} from '../lib/store.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'native-library-store-'));
  t.after(() => rmSync(path, {recursive: true, force: true}));
  return path;
}
function ownedStore(t, path) {
  const store = new LibraryStore(path);
  t.after(() => store.close());
  return store;
}
function upload(store) {
  const kb = store.createLibrary({database_name: '本地测试'}).database.kb_id;
  const id = store.upload(kb, '说明.txt', Buffer.from('第一行\n关键词持久保存\n第三行')).document.file_id;
  return {kb, id};
}

test('interrupted parse and index jobs recover to explicit failures and can be retried', async t => {
  const path = directory(t);
  let store = ownedStore(t, path);
  const {kb, id} = upload(store);
  store.queue(kb, id, 'parse');
  assert.equal(store.basic(kb, id).meta.status, 'parsing');
  store.close();
  store = ownedStore(t, path);
  assert.equal(store.basic(kb, id).meta.status, 'error_parsing');
  assert.match(store.basic(kb, id).meta.error_message, /未完成/);
  const parse = store.queue(kb, id, 'parse');
  await store.performJob(parse.task_id);
  assert.equal(store.basic(kb, id).meta.status, 'parsed');
  store.queue(kb, id, 'index');
  store.close();
  store = ownedStore(t, path);
  assert.equal(store.basic(kb, id).meta.status, 'error_indexing');
  assert.equal(store.content(kb, id, 0, 200).content, '第一行\n关键词持久保存\n第三行');
  assert.equal(store.query(kb, '关键词').results.length, 0);
  const index = store.queue(kb, id, 'index');
  await store.performJob(index.task_id);
  assert.equal(store.query(kb, '关键词').results.length, 1);
});

test('deleting a queued document removes raw content, jobs and chunks without resurrection', async t => {
  const store = ownedStore(t, directory(t));
  const {kb, id} = upload(store);
  const job = store.queue(kb, id, 'parse');
  store.deleteDocument(kb, id);
  await store.performJob(job.task_id);
  assert.equal(store.listDocuments(kb, 0, 100).total, 0);
  for (const table of ['documents', 'jobs', 'chunks']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.throws(() => store.basic(kb, id), {status: 404});
});

test('data directory lock rejects another instance and is released on close', t => {
  const path = directory(t);
  const store = ownedStore(t, path);
  assert.throws(() => new LibraryStore(path), /already in use/);
  assert.equal(existsSync(join(path, 'server.lock')), true);
  store.close();
  assert.equal(existsSync(join(path, 'server.lock')), false);
  ownedStore(t, path);
});

test('stale lock fails closed without deleting another process claim', t => {
  const path = directory(t);
  writeFileSync(join(path, 'server.lock'), JSON.stringify({pid: 2147483647, nonce: 'stale-fixture'}));
  assert.throws(() => new LibraryStore(path), /previous server left/);
  assert.equal(existsSync(join(path, 'server.lock')), true);
  assert.equal(existsSync(join(path, 'library.sqlite')), false);
});

test('newer schema is rejected without downgrading or changing tables', t => {
  const path = directory(t);
  let database = new DatabaseSync(join(path, 'library.sqlite'));
  database.exec('PRAGMA user_version=99; CREATE TABLE future_version (message TEXT);');
  database.close();
  assert.throws(() => new LibraryStore(path), /newer unsupported schema/);
  database = new DatabaseSync(join(path, 'library.sqlite'));
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 99);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['future_version']);
  database.close();
  assert.equal(existsSync(join(path, 'server.lock')), false);
});

test('stored secrets are salted password hashes and hashed expiring sessions', async t => {
  const store = ownedStore(t, directory(t));
  const {access_token: token} = await store.setup({username: '本机用户', password: 'temporary-test-password'});
  const owner = store.db.prepare('SELECT * FROM owner').get();
  assert.notEqual(owner.password_hash, 'temporary-test-password');
  assert.equal(owner.password_hash.length, 128);
  assert.equal(owner.salt.length, 64);
  const session = store.db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(session.token_hash, token);
  assert.equal(session.token_hash.length, 64);
  assert.ok(session.expires > Date.now());
  store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
  assert.throws(() => store.authenticate(token), {status: 401});
});
