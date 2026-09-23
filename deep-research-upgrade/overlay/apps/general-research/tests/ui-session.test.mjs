import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, json, deferred, until, drain} from './ui-harness.mjs';

test('unreachable local service cannot be presented as a successful connection', async () => {
  const app = harness(({path}) => path === '/api/status' ? json({backendConfigured: false, backendReachable: false}) : undefined);
  await until(() => app.el('connection-title').textContent.includes('暂不可用'));
  assert.equal(app.el('login-submit').disabled, true);
  assert.equal(app.calls.length, 1);
});

test('switching libraries aborts an old query and ignores a late successful reply', async () => {
  const pending = deferred();
  const app = harness(({path}) => path === '/api/databases/a/query' ? pending.promise : undefined);
  await app.login(); await app.select(0);
  app.el('query-input').value = 'synthetic question'; app.el('query-form').fire('submit');
  await until(() => app.calls.some(call => call.path.endsWith('/a/query')));
  const old = app.calls.find(call => call.path.endsWith('/a/query'));
  await app.select(1);
  assert.equal(old.options.signal.aborted, true);
  pending.resolve(json({results: [{file_id: 'doc-a', content: 'Private library A passage'}]})); await drain();
  assert.equal(app.el('library-title').textContent, 'Library b');
  assert.equal(app.el('query-sources').children.length, 0);
  assert.equal(app.el('query-answer').hidden, true);
});

test('logout invalidates an in-flight result and clears credentials and visible documents', async () => {
  const pending = deferred();
  const app = harness(({path}) => path.endsWith('/query') ? pending.promise : undefined);
  await app.login(); await app.select(0);
  app.el('query-input').value = 'question'; app.el('query-form').fire('submit');
  await until(() => app.calls.some(call => call.path.endsWith('/query')));
  app.el('logout').fire('click');
  pending.resolve(json({results: [{file_id: 'doc-a', content: 'old data'}]})); await drain();
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('auth-section').hidden, false);
  assert.equal(app.el('password').value, '');
  assert.equal(app.el('document-rows').children.length, 0);
  assert.equal(app.el('query-sources').children.length, 0);
});

test('confirmed read revocation clears previously visible document text and rows', async () => {
  let revoked = false;
  const app = harness(({path}) => revoked && path.startsWith('/api/databases/a/documents?') ? json({error: {message: 'Read access revoked'}}, 403) : undefined);
  await app.login(); await app.select(0);
  const actions = app.el('document-rows').children[0].children[2].children[0];
  actions.children[0].fire('click');
  await until(() => app.el('preview-content').textContent.includes('authorized'));
  revoked = true; app.el('refresh-documents').fire('click'); await drain();
  assert.equal(app.el('preview-content').textContent, '');
  assert.equal(app.el('document-rows').children.length, 0);
  assert.equal(app.el('query-sources').children.length, 0);
  assert.ok(app.el('global-message').textContent.includes('权限'));
});

test('401 with an invalid response body still discards the entire authenticated view', async () => {
  const app = harness(({path}) => path.endsWith('/query') ? new Response('not json', {status: 401}) : undefined);
  await app.login(); await app.select(0);
  app.el('query-input').value = 'question'; app.el('query-form').fire('submit');
  await until(() => app.el('workspace').hidden);
  assert.equal(app.el('document-rows').children.length, 0);
  assert.equal(app.el('account-label').textContent, '');
  assert.equal(app.el('auth-section').hidden, false);
});

test('cancelled authentication ignores a late token without erasing new input', async () => {
  const pending = deferred();
  const app = harness(({path}) => path === '/api/login' ? pending.promise : undefined);
  await until(() => !app.el('login-submit').disabled);
  app.el('username').value = 'synthetic'; app.el('password').value = 'only-test';
  app.el('login-form').fire('submit');
  await until(() => app.calls.some(call => call.path === '/api/login'));
  app.el('cancel-login').fire('click'); app.el('password').value = 'new-unsubmitted-password';
  pending.resolve(json({access_token: 'old-login-token'})); await drain();
  assert.equal(app.el('password').value, 'new-unsubmitted-password');
  assert.equal(app.calls.filter(call => call.path === '/api/me').length, 0);
});

test('a late denied document request from A cannot clear the new library B', async () => {
  const pending = deferred();
  const app = harness(({path}) => path.startsWith('/api/databases/a/documents?') ? pending.promise : undefined);
  await app.login(); await app.select(0); await app.select(1);
  pending.resolve(json({error: {message: 'A denied'}}, 403)); await drain();
  assert.equal(app.el('library-title').textContent, 'Library b');
  assert.equal(app.el('document-rows').children.length, 1);
  assert.equal(app.el('global-message').textContent, '');
});
