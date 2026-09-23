import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createLibraryServer} from '../server.mjs';
import {validateUpstream} from '../lib/upstream.mjs';
import {createFixture, FIXTURE_ACCOUNTS} from './fixture.mjs';

// These tests use real HTTP and a synthetic upstream. They do not validate a
// deployed Yuxi installation, its real database, or its permission middleware.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 1500) {
  const start = Date.now();
  while (!predicate()) {assert.ok(Date.now() - start < timeout, 'condition was not reached before timeout'); await pause(10);}
}
async function setup(t, options = {}) {
  const fixture = createFixture({transitionMs: 80});
  const upstream = await fixture.listen();
  const server = createLibraryServer({upstream, timeoutMs: 1200, ...options});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close();});
  const request = async (path, {method = 'GET', role = 'admin', body, headers = {}, signal} = {}) => {
    const requestHeaders = {...headers};
    if (role) requestHeaders.Authorization = `Bearer ${FIXTURE_ACCOUNTS[role]?.token || role}`;
    if (body != null && !(body instanceof FormData)) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {method, headers: requestHeaders, signal, body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body)});
    return {status: response.status, headers: response.headers, data: await response.json()};
  };
  return {fixture, server, base, request};
}
function seed(fixture, {kb = 'software-docs', id = 'seed-file', status = 'indexed'} = {}) {
  fixture.state.documents.set(id, {kb_id: kb, file_id: id, filename: 'software-guide.md', content: '# Software guide\nUse the Save button to preserve a note.', status, hash: 'seed-hash', created_at: new Date().toISOString()});
  return id;
}
function fileForm(name = 'software-note.md', content = '# Notes\nThe export button writes Markdown.') {
  const form = new FormData();
  form.append('file', new Blob([content], {type: 'text/markdown'}), name);
  return form;
}

test('unconfigured server reports not_configured and refuses protected upstream work', async t => {
  const {request, fixture} = await setup(t, {upstream: null});
  const status = await request('/api/status', {role: null});
  assert.equal(status.status, 200);
  assert.equal(status.data.backendConfigured, false);
  assert.equal(status.data.backendReachable, false);
  assert.equal(status.data.backendStatus, 'not_configured');
  const result = await request('/api/databases');
  assert.equal(result.status, 503);
  assert.equal(fixture.state.audit.filter(x => x.kind === 'request').length, 0);
});

test('upstream URL rejects remote HTTP, user info, paths, query and fragments', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/api', 'https://example.com/?secret=1', 'https://example.com/#x', 'file:///tmp/test']) {
    assert.throws(() => validateUpstream(url));
  }
  assert.equal(validateUpstream('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(validateUpstream('https://example.com'), 'https://example.com');
});

test('status performs a read-only reachability request and discloses source pin', async t => {
  const {request, fixture} = await setup(t);
  const status = await request('/api/status', {role: null});
  assert.equal(status.status, 200);
  assert.equal(status.data.backendConfigured, true);
  assert.equal(status.data.backendReachable, true);
  assert.equal(status.data.upstreamCommit, 'd633378c7ea55618ac659a547bfe90f74b29af4c');
  assert.ok(fixture.state.audit.some(x => x.kind === 'request' && x.path === '/api/auth/check-first-run' && x.method === 'GET' && x.role === null));
});

test('login sends official OAuth form; me uses explicit per-request token and strips secrets', async t => {
  const {request, fixture} = await setup(t);
  const login = await request('/api/login', {method: 'POST', role: null, body: {username: FIXTURE_ACCOUNTS.admin.username, password: FIXTURE_ACCOUNTS.admin.password}});
  assert.equal(login.status, 200);
  assert.equal(login.data.access_token, FIXTURE_ACCOUNTS.admin.token);
  const form = fixture.state.audit.find(x => x.kind === 'login_form');
  assert.match(form.contentType, /^application\/x-www-form-urlencoded/);
  const me = await request('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.uid, 'fixture-admin');
  assert.ok(!JSON.stringify(me.data).includes('SECRET'));
  const anonymous = await request('/api/me', {role: null});
  assert.equal(anonymous.status, 401, 'login must not create a shared global session');
});

test('API key is passed only as explicit bearer and browser cookies are not forwarded', async t => {
  const {request, fixture} = await setup(t);
  const me = await request('/api/me', {role: 'yxkey_synthetic-admin', headers: {Cookie: 'admin-session=DO_NOT_FORWARD'}});
  assert.equal(me.status, 200);
  const reads = fixture.state.audit.filter(x => x.kind === 'request' && x.path === '/api/auth/me');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].cookieReceived, false);
});

test('reader uses accessible list with management 403 and cannot inherit administrator libraries', async t => {
  const {request, fixture} = await setup(t);
  const admin = await request('/api/databases');
  assert.equal(admin.data.databases.length, 2);
  assert.equal(admin.data.canCreate, true);
  assert.ok(!JSON.stringify(admin.data).includes('SECRET'));
  const reader = await request('/api/databases', {role: 'reader'});
  assert.equal(reader.status, 200);
  assert.deepEqual(reader.data.databases.map(x => x.kb_id), ['software-docs']);
  assert.equal(reader.data.canCreate, false);
  assert.equal(reader.data.databases[0].can_manage, false);
  assert.ok(fixture.state.audit.some(x => x.kind === 'request' && x.path === '/api/knowledge/databases/external' && x.role === 'reader'));
  const denied = await request('/api/databases/private-notes/documents', {role: 'reader'});
  assert.ok([403, 404].includes(denied.status));
});

test('401 stays an error and does not make a second request with different authority', async t => {
  const {request, fixture} = await setup(t);
  const result = await request('/api/databases', {role: 'invalid-token'});
  assert.equal(result.status, 401);
  assert.ok(result.data.error);
  assert.equal(fixture.state.audit.filter(x => x.kind === 'request').length, 1);
});

test('reader can open and retrieve visible software notes but cannot upload or delete them', async t => {
  const {request, fixture} = await setup(t);
  const id = seed(fixture);
  const list = await request('/api/databases/software-docs/documents?offset=0&limit=100', {role: 'reader'});
  assert.equal(list.status, 200);
  assert.equal(list.data.documents[0].file_id, id);
  assert.equal(list.data.canManage, false);
  const content = await request(`/api/databases/software-docs/documents/${id}/content`, {role: 'reader'});
  assert.equal(content.status, 200);
  assert.match(content.data.content, /Software guide/);
  const query = await request('/api/databases/software-docs/query', {role: 'reader', method: 'POST', body: {query: 'Save button'}});
  assert.equal(query.status, 200);
  assert.equal(query.data.results[0].file_id, id);
  assert.ok(!JSON.stringify(query.data).includes('SECRET'));
  assert.equal((await request('/api/databases/software-docs/upload', {role: 'reader', method: 'POST', body: fileForm()})).status, 403);
  assert.equal((await request(`/api/databases/software-docs/documents/${id}`, {role: 'reader', method: 'DELETE'})).status, 403);
});

test('upload registers the uploaded MinIO reference and preserves content hash and size', async t => {
  const {request, fixture} = await setup(t);
  const result = await request('/api/databases/software-docs/upload', {method: 'POST', body: fileForm()});
  assert.equal(result.status, 201);
  assert.equal(result.data.status, 'success');
  assert.equal(result.data.document.status, 'uploaded');
  const registration = fixture.state.audit.find(x => x.kind === 'register');
  const uploadedPath = registration.body.items[0];
  assert.match(uploadedPath, /^minio:\/\/documents\//);
  assert.equal(registration.body.params.content_type, 'file');
  assert.equal(registration.body.params.content_hashes[uploadedPath], fixture.state.uploads.get(uploadedPath).hash);
  assert.ok(registration.body.params.file_sizes[uploadedPath] > 0);
});

for (const status of ['failed', 'partial_failed']) {
  test(`HTTP 200 registration ${status} is an error with explicit staged upload information`, async t => {
    const {request, fixture} = await setup(t);
    fixture.state.registrationFailure = status;
    const result = await request('/api/databases/software-docs/upload', {method: 'POST', body: fileForm()});
    assert.ok(result.status >= 400);
    assert.ok(result.data.error);
    assert.equal(result.data.staged, true);
    assert.equal(result.data.registrationFailed, true);
    assert.ok(!JSON.stringify(result.data).includes('SECRET'));
    assert.equal(fixture.state.documents.size, 0);
  });
}

test('parse returns queued and the document only progresses to parsed; index is a separate action', async t => {
  const {request, fixture} = await setup(t);
  const id = seed(fixture, {status: 'uploaded'});
  const parse = await request(`/api/databases/software-docs/documents/${id}/parse`, {method: 'POST', body: {}});
  assert.equal(parse.status, 202);
  assert.equal(parse.data.status, 'queued');
  assert.ok(parse.data.task_id);
  assert.notEqual(parse.data.status, 'ready');
  await until(() => fixture.state.documents.get(id).status === 'parsed');
  assert.equal(fixture.state.documents.get(id).status, 'parsed');
  const index = await request(`/api/databases/software-docs/documents/${id}/index`, {method: 'POST', body: {}});
  assert.equal(index.status, 202);
  assert.equal(index.data.status, 'queued');
  const actions = fixture.state.audit.filter(x => x.kind === 'document_action');
  assert.deepEqual(actions.map(x => x.action), ['parse', 'index']);
  assert.deepEqual(actions[0].body, {file_ids: [id], params: {}});
});

test('HTTP 200 parse business failure is not presented as a queued or completed operation', async t => {
  const {request, fixture} = await setup(t);
  const id = seed(fixture);
  fixture.state.actionFailure = 'failed';
  const result = await request(`/api/databases/software-docs/documents/${id}/parse`, {method: 'POST', body: {}});
  assert.ok(result.status >= 400);
  assert.ok(result.data.error);
  assert.ok(!JSON.stringify(result.data).includes('SECRET'));
});

test('deleted documents and revoked accounts cannot read cached data', async t => {
  const {request, fixture} = await setup(t);
  const id = seed(fixture);
  const path = `/api/databases/software-docs/documents/${id}/content`;
  assert.equal((await request(path, {role: 'reader'})).status, 200);
  fixture.state.readerRevoked = true;
  assert.equal((await request(path, {role: 'reader'})).status, 404);
  fixture.state.readerRevoked = false;
  assert.equal((await request(`/api/databases/software-docs/documents/${id}`, {method: 'DELETE'})).status, 200);
  assert.equal((await request(path)).status, 404);
  assert.equal((await request(path, {role: 'reader'})).status, 404);
});

test('upstream errors preserve HTTP 401 and 403 without leaking internal detail', async t => {
  const {request, fixture} = await setup(t);
  for (const status of [401, 403]) {
    fixture.state.faults.set('/api/auth/me', {status, body: {detail: 'SECRET password and internal stack'}});
    const result = await request('/api/me');
    assert.equal(result.status, status);
    assert.ok(result.data.error);
    assert.ok(!JSON.stringify(result.data).includes('SECRET'));
  }
});

test('timeout, socket failure and malformed or oversized upstream responses are bounded errors', async t => {
  const {request, fixture} = await setup(t, {timeoutMs: 100});
  for (const [type, expected] of [['timeout', 504], ['disconnect', 502], ['invalid-json', 502], ['large', 502]]) {
    fixture.state.faults.set('/api/auth/me', {type});
    const result = await request('/api/me');
    assert.equal(result.status, expected, type);
    assert.ok(result.data.error, type);
  }
});

test('a disconnected client aborts the outstanding upstream request', async t => {
  const {request, fixture} = await setup(t, {timeoutMs: 5000});
  fixture.state.faults.set('/api/auth/me', {type: 'timeout'});
  const controller = new AbortController();
  const pending = request('/api/me', {signal: controller.signal});
  await until(() => fixture.state.audit.some(x => x.kind === 'request' && x.path === '/api/auth/me'));
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  await until(() => fixture.state.audit.some(x => x.kind === 'response_close' && x.path === '/api/auth/me' && !x.ended));
});

test('upstream redirect is rejected without following its Location', async t => {
  const {request, fixture} = await setup(t);
  fixture.state.faults.set('/api/auth/me', {type: 'redirect'});
  const result = await request('/api/me');
  assert.equal(result.status, 502);
  assert.equal(result.data.error.code, 'UPSTREAM_REDIRECT_REJECTED');
  assert.equal(fixture.state.audit.filter(x => x.kind === 'request' && x.path === '/__redirect_target').length, 0);
});

test('unapproved routes, upstream URL injection and encoded traversal never reach upstream', async t => {
  const {request, fixture} = await setup(t);
  for (const path of ['/api/agents', '/api/proxy?url=https://example.com', '/api/databases/bad%2Fid/documents', '/api/databases/%252e%252e/documents']) {
    const result = await request(path);
    assert.ok([400, 404].includes(result.status), path);
  }
  assert.equal(fixture.state.audit.filter(x => x.kind === 'request').length, 0);
});

test('Host and Origin are checked before credentials can be forwarded', async t => {
  const {base, fixture} = await setup(t);
  for (const headers of [{Host: 'attacker.example'}, {Origin: 'https://attacker.example'}, {'Sec-Fetch-Site': 'cross-site'}]) {
    // Native HTTP preserves Host and Fetch Metadata exactly; fetch can rewrite
    // these browser-controlled headers and would test a different request.
    const result = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/me`, {headers: {...headers, Authorization: `Bearer ${FIXTURE_ACCOUNTS.admin.token}`}}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString())}));
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok([400, 403].includes(result.status));
  }
  assert.equal(fixture.state.audit.filter(x => x.kind === 'request').length, 0);
});

test('HTTP 200 deletion with an unrecognized body is rejected as unverified', async t => {
  const {request, fixture} = await setup(t);
  const id = seed(fixture);
  for (const body of [{}, []]) {
    fixture.state.faults.set(`/api/knowledge/databases/software-docs/documents/${id}`, {status: 200, body});
    const result = await request(`/api/databases/software-docs/documents/${id}`, {method: 'DELETE'});
    assert.equal(result.status, 502);
    assert.ok(result.data.error);
    assert.ok(fixture.state.documents.has(id), 'fixture did not actually delete anything');
  }
});

test('malformed query rows do not become apparent retrieval matches', async t => {
  const {request, fixture} = await setup(t);
  fixture.state.faults.set('/api/knowledge/databases/external/software-docs/retrieve', {status: 200, body: {results: [{}]}});
  const result = await request('/api/databases/software-docs/query', {method: 'POST', body: {query: 'Save button'}});
  assert.equal(result.status, 502);
  assert.ok(result.data.error);
});

test('nested metadata cannot smuggle credentials through an allowed citation key', async t => {
  const {request, fixture} = await setup(t);
  fixture.state.faults.set('/api/knowledge/databases/external/software-docs/retrieve', {status: 200, body: {results: [{id: 'chunk-1', kb_id: 'software-docs', file_id: 'file-1', content: 'A software note.', metadata: {filename: 'guide.md', source: {password: 'SECRET_CREDENTIAL'}}}]}});
  const result = await request('/api/databases/software-docs/query', {method: 'POST', body: {query: 'Save button'}});
  assert.ok(!JSON.stringify(result.data).includes('SECRET_CREDENTIAL'));
  if (result.status === 200) {
    assert.equal(result.data.results[0].metadata.filename, 'guide.md');
    assert.ok(result.data.results[0].metadata.source == null || typeof result.data.results[0].metadata.source !== 'object');
  } else {
    assert.equal(result.status, 502);
    assert.ok(result.data.error);
  }
});

test('only Markdown and text below 10 MiB are uploaded; JSON request body is bounded', async t => {
  const {request, fixture} = await setup(t);
  const type = await request('/api/databases/software-docs/upload', {method: 'POST', body: fileForm('program.exe')});
  assert.ok([400, 415].includes(type.status));
  const size = await request('/api/databases/software-docs/upload', {method: 'POST', body: fileForm('large.md', 'x'.repeat(10 * 1024 * 1024 + 1))});
  assert.equal(size.status, 413);
  const json = await request('/api/databases/software-docs/query', {method: 'POST', body: {query: 'x'.repeat(128 * 1024)}});
  assert.equal(json.status, 413);
  assert.equal(fixture.state.audit.filter(x => x.kind === 'upload').length, 0);
});

test('responses carry no-store, nosniff and CSP without enabling CORS', async t => {
  const {request} = await setup(t);
  const result = await request('/api/status', {role: null});
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.match(result.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(result.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
});
