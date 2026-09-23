import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LibraryStore} from '../lib/store.mjs';
import {parseDocument} from '../lib/parser.mjs';
import {textPdf, textDocx, python} from './parser-fixtures.mjs';

function directory(t) { const path = mkdtempSync(join(tmpdir(), 'general-parser-store-')); t.after(() => rmSync(path, {recursive: true, force: true})); return path; }
function storeFor(t, path = directory(t), options = {}) { const store = new LibraryStore(path, options); t.after(() => store.close()); return store; }
async function process(store, kb, id) { for (const action of ['parse', 'index']) await store.performJob(store.queue(kb, id, action).task_id); }

test('PDF/DOCX citations persist after restart, never merge pages or cells, and delete cleanly', async t => {
  const path = directory(t);
  let store = storeFor(t, path, {parser: (name, bytes, options) => parseDocument(name, bytes, {...options, python})});
  const kb = store.createLibrary({database_name: 'Selected docs'}).database.kb_id;
  const pdf = store.upload(kb, 'requirements.pdf', textPdf(['Source alpha', 'Source beta'])).document.file_id;
  const docx = store.upload(kb, 'notes.docx', textDocx()).document.file_id;
  await process(store, kb, pdf); await process(store, kb, docx);
  assert.equal(store.basic(kb, pdf).meta.status, 'indexed');
  const hits = store.query(kb, 'Source').results;
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(hit => hit.locator.page), [1, 2]);
  assert.equal(store.query(kb, 'beta').results.find(hit => hit.file_id === pdf).locator.page, 2);
  assert.equal(store.content(kb, pdf, 1, 1).locator.page, 2);
  assert.equal(store.query(kb, 'Table beta').results[0].locator.cell, 1);
  store.close(); store = storeFor(t, path);
  const excerpts = store.getSourceExcerpts(kb, [pdf, docx], {query: 'beta', maxChars: 16000});
  assert.equal(excerpts.length, 6);
  assert.equal(excerpts[0].locator.page, 2);
  assert.equal(excerpts.find(source => source.file_id === docx).locator.cell, 1);
  assert.ok(excerpts.some(source => source.content === 'Final requirement delta'), 'Include actual later requirements, not only the first paragraph.');
  assert.ok(excerpts.every(source => source.id.startsWith('doc-') && source.source_hash.length === 64));
  store.deleteDocument(kb, pdf);
  assert.throws(() => store.getSourceExcerpts(kb, [pdf]), {status: 409});
  assert.equal(store.query(kb, 'Source').results.length, 0);
});

test('selected excerpts include every selected file within budget and cannot leak other libraries', async t => {
  const store = storeFor(t);
  const kb = store.createLibrary({database_name: 'Selected'}).database.kb_id;
  const other = store.createLibrary({database_name: 'Unselected'}).database.kb_id;
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const id = store.upload(kb, `file${i}.txt`, Buffer.from(`Requirement ${i}\n${'Text content '.repeat(1000)}`)).document.file_id;
    await process(store, kb, id); ids.push(id);
  }
  const hidden = store.upload(other, 'hidden.txt', Buffer.from('Do not share this document')).document.file_id;
  await process(store, other, hidden);
  const sources = store.getSourceExcerpts(kb, ids, {maxChars: 600});
  assert.ok(sources.length >= 6 && sources.length <= 36);
  assert.equal(new Set(sources.map(item => item.file_id)).size, 6);
  assert.ok(sources.reduce((sum, item) => sum + item.content.length, 0) <= 600);
  assert.throws(() => store.getSourceExcerpts(kb, [...ids, hidden]), {status: 400});
  assert.throws(() => store.getSourceExcerpts(kb, [hidden]), {status: 409});
  const unindexed = store.upload(kb, 'new.txt', Buffer.from('Unindexed material')).document.file_id;
  assert.throws(() => store.getSourceExcerpts(kb, [ids[0], unindexed]), {status: 409});
  assert.deepEqual(store.getSourceExcerpts(null, []), []);
});

test('parser jobs run one at a time and deletion during parse cannot resurrect data', async t => {
  let running = 0, peak = 0;
  const releases = [];
  const store = storeFor(t, undefined, {parser: (name, bytes, {signal}) => new Promise((resolve, reject) => {
    running++; peak = Math.max(peak, running);
    const done = () => { running--; resolve({content: name, units: [{content: name, start_line: 1, end_line: 1, locator: {kind: 'text'}}], warnings: []}); };
    releases.push(done);
    signal.addEventListener('abort', () => { running--; reject(new Error('cancelled')); }, {once: true});
  })});
  const kb = store.createLibrary({database_name: 'Jobs'}).database.kb_id;
  const a = store.upload(kb, 'a.txt', Buffer.from('A')).document.file_id;
  const b = store.upload(kb, 'b.txt', Buffer.from('B')).document.file_id;
  const first = store.performJob(store.queue(kb, a, 'parse').task_id);
  const second = store.performJob(store.queue(kb, b, 'parse').task_id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, 1);
  store.deleteDocument(kb, a);
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, 1);
  releases[1](); await second;
  assert.equal(peak, 1);
  assert.equal(store.basic(kb, b).meta.status, 'parsed');
  assert.throws(() => store.basic(kb, a), {status: 404});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs WHERE document_id=?').get(a).n, 0);
});

test('version 1 standalone SQLite is upgraded additively with old text citations intact', t => {
  const path = directory(t);
  const db = new DatabaseSync(join(path, 'library.sqlite'));
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY,library_id TEXT NOT NULL,filename TEXT NOT NULL,byte_size INTEGER NOT NULL,content_hash TEXT NOT NULL,raw BLOB NOT NULL,content TEXT,status TEXT NOT NULL,error_message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE chunks (id TEXT PRIMARY KEY,document_id TEXT NOT NULL,content TEXT NOT NULL,searchable TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL);
  CREATE TABLE libraries (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
  INSERT INTO libraries VALUES ('kb-old','Legacy','','2026-01-01');
  INSERT INTO documents VALUES ('doc-old','kb-old','legacy.txt',14,'legacy-hash',X'00','Original text','indexed',NULL,'2026-01-01','2026-01-01');
  INSERT INTO chunks VALUES ('chunk-old','doc-old','Original text','original text',1,1);
  PRAGMA user_version=1;`);
  db.close();
  const store = storeFor(t, path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(store.content('kb-old', 'doc-old', 0, 10).content, 'Original text');
  assert.deepEqual(store.query('kb-old', 'Original').results[0].locator, {kind: 'text', start_line: 1, end_line: 1});
  assert.equal(store.getSourceExcerpts('kb-old', ['doc-old'])[0].content, 'Original text');
});

test('closing during active parsing aborts work and restart exposes an interrupted failure', async t => {
  const path = directory(t);
  let aborted = false;
  const store = storeFor(t, path, {parser: (name, bytes, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('closed')); }, {once: true});
  })});
  const kb = store.createLibrary({database_name: 'Restarted jobs'}).database.kb_id;
  const id = store.upload(kb, 'notes.txt', Buffer.from('Incomplete parse')).document.file_id;
  const pending = store.performJob(store.queue(kb, id, 'parse').task_id);
  await new Promise(resolve => setImmediate(resolve));
  store.close();
  await pending;
  assert.equal(aborted, true);
  const restarted = storeFor(t, path);
  assert.equal(restarted.basic(kb, id).meta.status, 'error_parsing');
  assert.equal(restarted.query(kb, 'Incomplete').results.length, 0);
  await process(restarted, kb, id);
  assert.equal(restarted.query(kb, 'Incomplete').results.length, 1);
});
