import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLibraryServer} from '../server.mjs';

// Real HTTP application and on-disk SQLite per test; synthetic input only.
export const OWNER = {username: 'local-owner', password: 'Test-only password 482!'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function createFixture(t, {initialize = true, serverOptions = {}} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'native-library-test-'));
  let server, base, token;
  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    const done = new Promise((resolve, reject) => closing.close(error => error ? reject(error) : resolve()));
    closing.closeAllConnections();
    await done;
  }
  t.after(async () => {await stop(); await rm(dataDir, {recursive: true, force: true});});
  async function start() {
    server = createLibraryServer({dataDir, ...serverOptions});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function request(path, {method = 'GET', auth = token, body, rawBody, headers = {}} = {}) {
    const requestHeaders = {...headers};
    if (auth) requestHeaders.Authorization = `Bearer ${auth}`;
    if (body != null && !(body instanceof FormData)) requestHeaders['Content-Type'] ??= 'application/json';
    const response = await fetch(`${base}${path}`, {method, headers: requestHeaders,
      body: rawBody ?? (body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body))});
    const text = await response.text();
    return {status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null};
  }
  async function login() {
    const response = await request('/api/login', {method: 'POST', auth: null, body: OWNER});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    token = response.data.access_token;
    return token;
  }
  async function createLibrary(name = 'Software notes') {
    const response = await request('/api/databases', {method: 'POST', body: {database_name: name, description: 'Local test documents'}});
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.ok(response.data.database.kb_id);
    return response.data.database.kb_id;
  }
  async function upload(kb, content = '# Software notes\nThe export button saves Markdown.', name = 'software-notes.md') {
    const response = await request(`/api/databases/${kb}/upload`, {method: 'POST', body: fileForm(name, content)});
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(response.data.document.status, 'uploaded');
    return response.data.document.file_id;
  }
  async function waitForDocument(kb, id, expected) {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const result = await request(`/api/databases/${kb}/documents/${id}/basic`);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      if (result.data.meta.status === expected) return result.data.meta;
      assert.ok(!result.data.meta.status.startsWith('error_'), `unexpected document failure: ${JSON.stringify(result.data.meta)}`);
      await pause(10);
    }
    assert.fail(`document did not reach ${expected} within 5 seconds`);
  }
  async function processDocument(kb, id, action, expected = action === 'parse' ? 'parsed' : 'indexed') {
    const response = await request(`/api/databases/${kb}/documents/${id}/${action}`, {method: 'POST', body: {}});
    assert.equal(response.status, 202, JSON.stringify(response.data));
    assert.equal(response.data.status, 'queued');
    assert.ok(response.data.task_id);
    return waitForDocument(kb, id, expected);
  }
  await start();
  if (initialize) {
    const response = await request('/api/setup', {method: 'POST', auth: null, body: OWNER});
    assert.equal(response.status, 201, JSON.stringify(response.data));
    token = response.data.access_token;
    assert.ok(token);
  }
  return {request, login, createLibrary, upload, waitForDocument, processDocument, stop, dataDir,
    get base() {return base;}, get token() {return token;}, get server() {return server;},
    async restart() {await stop(); token = undefined; await start();}};
}
export function fileForm(name = 'software-notes.md', content = '# Notes\nThe export button saves Markdown.') {
  const form = new FormData();
  form.append('file', new Blob([content], {type: 'text/plain'}), name);
  return form;
}
