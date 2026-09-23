import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createFixture, fileForm, OWNER} from './fixture.mjs';

const documentPath = (kb, id) => `/api/databases/${kb}/documents/${id}`;
async function query(fixture, kb, text) {
  const result = await fixture.request(`/api/databases/${kb}/query`, {method: 'POST', body: {query: text}});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(Array.isArray(result.data.results));
  return result.data.results;
}

test('a fresh local store requires one-time owner setup and no external backend', async t => {
  const fixture = await createFixture(t, {initialize: false});
  const initial = await fixture.request('/api/status', {auth: null});
  assert.equal(initial.status, 200);
  assert.equal(initial.data.setupRequired, true);
  assert.equal(initial.data.backendStatus, 'setup_required');
  assert.equal(initial.data.storage, 'sqlite');
  assert.equal(initial.data.searchMode, 'keyword');
  assert.equal((await fixture.request('/api/databases', {auth: null})).status, 401);
  assert.equal((await fixture.request('/api/setup', {method: 'POST', body: {...OWNER, password: 'short'}})).status, 400);
  const setup = await fixture.request('/api/setup', {method: 'POST', body: OWNER});
  assert.equal(setup.status, 201);
  assert.ok(setup.data.access_token);
  const ready = await fixture.request('/api/status', {auth: null});
  assert.equal(ready.data.setupRequired, false);
  assert.equal(ready.data.backendStatus, 'ready');
  assert.equal((await fixture.request('/api/setup', {method: 'POST', body: {...OWNER, username: 'second-owner'}})).status, 409);
  const me = await fixture.request('/api/me', {auth: setup.data.access_token});
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, OWNER.username);
  assert.ok(!JSON.stringify(me.data).includes(OWNER.password));
  assert.ok(!Object.keys(me.data.user).some(key => /password|salt|hash|token/i.test(key)));
});

test('concurrent initial setup creates exactly one owner', async t => {
  const fixture = await createFixture(t, {initialize: false});
  const attempts = await Promise.all([OWNER, {...OWNER, username: 'another-owner'}].map(body => fixture.request('/api/setup', {method: 'POST', body})));
  assert.deepEqual(attempts.map(x => x.status).sort(), [201, 409]);
  const winning = attempts.find(x => x.status === 201).data.access_token;
  assert.equal((await fixture.request('/api/me', {auth: winning})).status, 200);
});

test('password login, per-session logout and anonymous rejection use real stored credentials', async t => {
  const fixture = await createFixture(t);
  const firstToken = fixture.token;
  assert.equal((await fixture.request('/api/login', {method: 'POST', auth: null, body: {...OWNER, password: 'incorrect password'}})).status, 401);
  assert.equal((await fixture.request('/api/me', {auth: 'invented-token'})).status, 401);
  assert.equal((await fixture.request('/api/me', {auth: null, headers: {Cookie: `session=${firstToken}`}})).status, 401);
  const secondToken = await fixture.login();
  assert.notEqual(firstToken, secondToken);
  assert.equal((await fixture.request('/api/logout', {method: 'POST', auth: firstToken, body: {}})).status, 200);
  assert.equal((await fixture.request('/api/me', {auth: firstToken})).status, 401);
  assert.equal((await fixture.request('/api/me', {auth: secondToken})).status, 200);
});

test('libraries are created and listed without model configuration', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary('User manuals');
  const result = await fixture.request('/api/databases');
  assert.equal(result.status, 200);
  assert.equal(result.data.canCreate, true);
  assert.equal(result.data.databases.length, 1);
  assert.equal(result.data.databases[0].kb_id, kb);
  assert.equal(result.data.databases[0].name, 'User manuals');
  assert.equal(result.data.databases[0].kb_type, 'local');
  assert.equal(result.data.databases[0].can_manage, true);
});

test('actual upload, UTF-8 parsing and indexing produce line-cited keyword matches', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const text = '# 软件使用说明\n点击导出按钮保存文档。\nThe export button saves Markdown.\nEnd of document.';
  const id = await fixture.upload(kb, text, '软件说明.md');
  assert.deepEqual(await query(fixture, kb, '导出按钮'), []);
  assert.equal((await fixture.request(`${documentPath(kb, id)}/index`, {method: 'POST', body: {}})).status, 409);
  await fixture.processDocument(kb, id, 'parse');
  assert.deepEqual(await query(fixture, kb, '导出按钮'), [], 'parsed documents are not indexed yet');
  const preview = await fixture.request(`${documentPath(kb, id)}/content`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.content, text);
  assert.equal(preview.data.start_line, 1);
  assert.equal(preview.data.total_lines, 4);
  await fixture.processDocument(kb, id, 'index');
  for (const term of ['导出按钮', 'export']) {
    const matches = await query(fixture, kb, term);
    assert.ok(matches.length > 0, term);
    assert.equal(matches[0].kb_id, kb);
    assert.equal(matches[0].file_id, id);
    assert.equal(matches[0].metadata.filename, '软件说明.md');
    assert.ok(matches[0].metadata.start_line >= 1);
    assert.ok(matches[0].metadata.end_line <= 4);
    assert.match(matches[0].content, new RegExp(term));
  }
  assert.deepEqual(await query(fixture, kb, 'not-present-76193'), []);
});

test('same-content upload is rejected while same-name different content remains separate', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const original = 'First document text';
  const first = await fixture.upload(kb, original, 'notes.txt');
  const duplicate = await fixture.request(`/api/databases/${kb}/upload`, {method: 'POST', body: fileForm('other-name.md', original)});
  assert.equal(duplicate.status, 409);
  const changed = await fixture.request(`/api/databases/${kb}/upload`, {method: 'POST', body: fileForm('notes.txt', 'Second document text')});
  assert.equal(changed.status, 201);
  assert.notEqual(changed.data.document.file_id, first);
  assert.equal(changed.data.hasSameName, true);
  const list = await fixture.request(`/api/databases/${kb}/documents`);
  assert.equal(list.data.total, 2);
  for (const [id, content] of [[first, original], [changed.data.document.file_id, 'Second document text']]) {
    await fixture.processDocument(kb, id, 'parse');
    assert.equal((await fixture.request(`${documentPath(kb, id)}/content`)).data.content, content);
  }
});

test('simultaneous duplicate uploads cannot bypass the local uniqueness constraint', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const attempts = await Promise.all(['one.md', 'two.md'].map(name => fixture.request(`/api/databases/${kb}/upload`, {method: 'POST', body: fileForm(name, 'Concurrent duplicate document.')})));
  assert.deepEqual(attempts.map(x => x.status).sort(), [201, 409]);
  assert.equal((await fixture.request(`/api/databases/${kb}/documents`)).data.total, 1);
});

test('invalid UTF-8 is recorded as parse failure and never becomes searchable', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const id = await fixture.upload(kb, new Uint8Array([0x61, 0xc3, 0x28, 0xff]), 'invalid.txt');
  const failed = await fixture.processDocument(kb, id, 'parse', 'error_parsing');
  assert.equal(failed.status, 'error_parsing');
  assert.equal((await fixture.request(`${documentPath(kb, id)}/index`, {method: 'POST', body: {}})).status, 409);
  assert.deepEqual(await query(fixture, kb, 'a'), []);
});

test('documents, previews and retrieval remain isolated by their library ID', async t => {
  const fixture = await createFixture(t);
  const firstKb = await fixture.createLibrary('First library');
  const secondKb = await fixture.createLibrary('Second library');
  const id = await fixture.upload(firstKb, 'Only the first library contains the violet notebook.');
  await fixture.processDocument(firstKb, id, 'parse');
  await fixture.processDocument(firstKb, id, 'index');
  assert.equal((await query(fixture, firstKb, 'violet')).length, 1);
  assert.deepEqual(await query(fixture, secondKb, 'violet'), []);
  assert.deepEqual((await fixture.request(`/api/databases/${secondKb}/documents`)).data.documents, []);
  for (const suffix of ['/content', '/basic']) assert.equal((await fixture.request(`${documentPath(secondKb, id)}${suffix}`)).status, 404);
  assert.equal((await fixture.request(documentPath(secondKb, id), {method: 'DELETE'})).status, 404);
  assert.equal((await fixture.request(`${documentPath(firstKb, id)}/content`)).status, 200);
  await fixture.upload(secondKb, 'Only the first library contains the violet notebook.');
});

test('deletion removes the stored document from previews, metadata and retrieval', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const id = await fixture.upload(kb, 'Temporary software manual: ambermarker.');
  await fixture.processDocument(kb, id, 'parse');
  await fixture.processDocument(kb, id, 'index');
  assert.ok((await query(fixture, kb, 'ambermarker')).length);
  const result = await fixture.request(documentPath(kb, id), {method: 'DELETE'});
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'success');
  for (const suffix of ['/content', '/basic']) assert.equal((await fixture.request(`${documentPath(kb, id)}${suffix}`)).status, 404);
  assert.deepEqual(await query(fixture, kb, 'ambermarker'), []);
  assert.equal((await fixture.request(`/api/databases/${kb}/documents`)).data.total, 0);
  await fixture.restart();
  await fixture.login();
  assert.equal((await fixture.request(`${documentPath(kb, id)}/content`)).status, 404);
  assert.deepEqual(await query(fixture, kb, 'ambermarker'), []);
});

test('list and preview pagination retain complete, non-overlapping real data', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const ids = [];
  for (let index = 0; index < 3; index++) ids.push(await fixture.upload(kb, `line one ${index}\nline two ${index}\nline three ${index}\nline four ${index}`, `note-${index}.txt`));
  const first = await fixture.request(`/api/databases/${kb}/documents?offset=0&limit=2`);
  const second = await fixture.request(`/api/databases/${kb}/documents?offset=2&limit=2`);
  assert.equal(first.data.total, 3);
  assert.equal(first.data.documents.length, 2);
  assert.equal(first.data.has_more, true);
  assert.equal(second.data.documents.length, 1);
  assert.equal(second.data.has_more, false);
  assert.deepEqual(new Set([...first.data.documents, ...second.data.documents].map(x => x.file_id)), new Set(ids));
  await fixture.processDocument(kb, ids[0], 'parse');
  const preview = await fixture.request(`${documentPath(kb, ids[0])}/content?offset=1&limit=2`);
  assert.equal(preview.data.content, 'line two 0\nline three 0');
  assert.equal(preview.data.start_line, 2);
  assert.equal(preview.data.end_line, 3);
  assert.equal(preview.data.total_lines, 4);
  assert.equal(preview.data.has_more_after, true);
  assert.equal(preview.data.next_offset, 3);
  for (const page of ['offset=-1', 'limit=0', 'offset=1.5']) assert.equal((await fixture.request(`/api/databases/${kb}/documents?${page}`)).status, 400);
});

test('owner credentials, documents, parsed text and indexed search survive a server restart', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary('Persistent library');
  const content = 'Stored manual\nThe cerulean bookmark survives a restart.';
  const id = await fixture.upload(kb, content);
  await fixture.processDocument(kb, id, 'parse');
  await fixture.processDocument(kb, id, 'index');
  await fixture.restart();
  assert.equal((await fixture.request('/api/status', {auth: null})).data.setupRequired, false);
  await fixture.login();
  assert.equal((await fixture.request('/api/databases')).data.databases[0].kb_id, kb);
  assert.equal((await fixture.request(`${documentPath(kb, id)}/basic`)).data.meta.status, 'indexed');
  assert.equal((await fixture.request(`${documentPath(kb, id)}/content`)).data.content, content);
  assert.equal((await query(fixture, kb, 'cerulean'))[0].file_id, id);
});

test('names and search input are handled as data, including SQL punctuation and literal HTML', async t => {
  const fixture = await createFixture(t);
  const name = "Notes'); DROP TABLE documents; -- <script>example</script>";
  const kb = await fixture.createLibrary(name);
  const id = await fixture.upload(kb, '<script>alert("example")</script>\nLiteral example text.');
  await fixture.processDocument(kb, id, 'parse');
  await fixture.processDocument(kb, id, 'index');
  assert.equal((await fixture.request('/api/databases')).data.databases[0].name, name);
  assert.equal((await fixture.request(`${documentPath(kb, id)}/content`)).data.content, '<script>alert("example")</script>\nLiteral example text.');
  assert.deepEqual(await query(fixture, kb, "' OR 1=1 --"), []);
  assert.ok((await query(fixture, kb, 'Literal')).length);
});

test('unknown routes and encoded traversal do not expose files or unrelated features', async t => {
  const fixture = await createFixture(t);
  for (const path of ['/api/agents', '/api/proxy?url=https://example.com', '/api/databases/bad%2Fid/documents', '/api/databases/%252e%252e/documents', '/.env', '/server.mjs']) {
    assert.ok([400, 404].includes((await fixture.request(path)).status), path);
  }
});

test('Host, Origin and cross-site metadata are checked before local authenticated access', async t => {
  const fixture = await createFixture(t);
  for (const headers of [{Host: 'attacker.example'}, {Origin: 'https://attacker.example'}, {'Sec-Fetch-Site': 'cross-site'}]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(`${fixture.base}/api/me`, {headers: {...headers, Authorization: `Bearer ${fixture.token}`}}, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  }
  assert.equal((await fixture.request('/api/me', {headers: {Origin: fixture.base}})).status, 200);
});

test('unsupported files, multi-file uploads, oversize bodies and invalid JSON are rejected', async t => {
  const fixture = await createFixture(t);
  const kb = await fixture.createLibrary();
  const uploadPath = `/api/databases/${kb}/upload`;
  assert.ok([400, 415].includes((await fixture.request(uploadPath, {method: 'POST', body: fileForm('program.exe')})).status));
  const multiple = fileForm();
  multiple.append('another-file', new Blob(['other document']), 'another.md');
  assert.equal((await fixture.request(uploadPath, {method: 'POST', body: multiple})).status, 400);
  assert.equal((await fixture.request(uploadPath, {method: 'POST', body: fileForm('large.md', 'x'.repeat(10 * 1024 * 1024 + 1))})).status, 413);
  assert.equal((await fixture.request(`/api/databases/${kb}/query`, {method: 'POST', body: {query: 'x'.repeat(128 * 1024)}})).status, 413);
  assert.equal((await fixture.request('/api/databases', {method: 'POST', rawBody: '{broken', headers: {'Content-Type': 'application/json'}})).status, 400);
  assert.equal((await fixture.request('/api/databases', {method: 'POST', rawBody: '{}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await fixture.request(`/api/databases/${kb}/documents`)).data.total, 0);
});

test('static UI and local APIs carry no-store, nosniff and restrictive CSP without CORS', async t => {
  const fixture = await createFixture(t);
  for (const path of ['/api/status', '/', '/app.js']) {
    const response = await fetch(`${fixture.base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.arrayBuffer();
  }
});
