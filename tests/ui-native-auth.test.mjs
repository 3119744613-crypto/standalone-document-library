import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, json, deferred, until, drain} from './ui-harness.mjs';

const ready = setupRequired => json({backendConfigured: true, backendReachable: true, setupRequired, storage: 'sqlite', searchMode: 'keyword'});
const submit = app => {
  app.el('username').value = 'local-owner';
  app.el('password').value = 'synthetic-password-only';
  app.el('login-form').fire('submit');
};

test('first run creates a local owner and proceeds directly to the native library', async () => {
  const app = harness(({path}) => path === '/api/status' ? ready(true) : path === '/api/setup' ? json({access_token: 'synthetic-created-owner-token'}, 201) : undefined);
  await until(() => !app.el('login-submit').disabled);
  assert.equal(app.el('auth-title').textContent, '设置本机管理员');
  submit(app);
  await until(() => app.el('library-list').children.length === 2);
  const setup = app.calls.find(call => call.path === '/api/setup');
  assert.deepEqual(JSON.parse(setup.options.body), {username: 'local-owner', password: 'synthetic-password-only'});
  assert.equal(setup.options.headers.Authorization, undefined);
  assert.equal(app.calls.some(call => call.path === '/api/login'), false);
  assert.equal(app.el('workspace').hidden, false);
  assert.match(app.el('connection-message').textContent, /已就绪/);
  assert.doesNotMatch(app.el('connection-message').textContent, /创建.*账号/);
  assert.equal(app.el('password').value, '');
  app.el('logout').fire('click'); await drain();
  assert.equal(app.el('auth-title').textContent, '登录本地资料库');
  assert.equal(app.el('login-submit').textContent, '登录资料库');
});

test('first-run password shorter than ten characters is rejected before creating an account', async () => {
  const app = harness(({path}) => path === '/api/status' ? ready(true) : undefined);
  await until(() => !app.el('login-submit').disabled);
  app.el('username').value = 'local-owner'; app.el('password').value = 'short'; app.el('login-form').fire('submit');
  await drain();
  assert.match(app.el('global-message').textContent, /至少 10/);
  assert.equal(app.calls.some(call => call.path === '/api/setup'), false);
});

test('a late first-run status reply cannot restore setup mode after successful account creation', async () => {
  const delayedStatus = deferred(); let statusCalls = 0;
  const app = harness(({path}) => path === '/api/status' ? (++statusCalls === 1 ? ready(true) : delayedStatus.promise) : undefined);
  await until(() => !app.el('login-submit').disabled);
  app.el('refresh-status').fire('click');
  submit(app);
  await until(() => app.el('library-list').children.length === 2);
  delayedStatus.resolve(ready(true)); await drain();
  assert.match(app.el('connection-message').textContent, /已就绪/);
  assert.doesNotMatch(app.el('connection-message').textContent, /创建.*账号/);
  app.el('logout').fire('click'); await drain();
  assert.equal(app.el('auth-title').textContent, '登录本地资料库');
});

test('logout sends the current bearer for revocation and immediately clears the page', async () => {
  const pending = deferred();
  const app = harness(({path}) => path === '/api/logout' ? pending.promise : undefined);
  await app.login(); await app.select(0);
  app.el('logout').fire('click');
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('document-rows').children.length, 0);
  const logout = app.calls.find(call => call.path === '/api/logout');
  assert.equal(logout.options.headers.Authorization, 'Bearer synthetic-admin-token');
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.credentials, 'omit');
  await app.login();
  pending.resolve(json({status: 'success'})); await drain();
  assert.equal(app.el('workspace').hidden, false);
  assert.equal(app.el('global-message').textContent, '');
});

test('logout failure reports unconfirmed revocation without retaining document text', async () => {
  const app = harness(({path}) => path === '/api/logout' ? json({error: {message: 'Temporary error'}}, 503) : undefined);
  await app.login(); await app.select(0);
  app.el('logout').fire('click'); await drain();
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('document-rows').children.length, 0);
  assert.match(app.el('global-message').textContent, /未确认会话注销/);
  assert.doesNotMatch(app.el('global-message').textContent, /会话已注销/);
});

test('query cancellation ignores a late result without changing the selected library', async () => {
  const pending = deferred();
  const app = harness(({path}) => path.endsWith('/query') ? pending.promise : undefined);
  await app.login(); await app.select(0);
  app.el('query-input').value = 'local sample'; app.el('query-form').fire('submit');
  await until(() => app.calls.some(call => call.path.endsWith('/query')));
  const call = app.calls.find(call => call.path.endsWith('/query'));
  app.el('cancel-query').fire('click');
  assert.equal(call.options.signal.aborted, true);
  pending.resolve(json({results: [{file_id: 'doc-a', content: 'Late passage'}]})); await drain();
  assert.equal(app.el('library-title').textContent, 'Library a');
  assert.equal(app.el('query-sources').children.length, 0);
  assert.equal(app.el('query-submit').disabled, false);
});

test('unknown setup state does not allow an accidental login or owner creation', async () => {
  const app = harness(({path}) => path === '/api/status' ? json({backendConfigured: true, backendReachable: true}) : undefined);
  await drain(); submit(app); await drain();
  assert.equal(app.el('login-submit').disabled, true);
  assert.equal(app.calls.length, 1);
});


test('cancelled first setup recovers to login when owner creation finishes after cancellation', async () => {
  const initialSetup = deferred(); let ownerExists = false; let setupCalls = 0;
  const app = harness(({path}) => {
    if (path === '/api/status') return ready(!ownerExists);
    if (path === '/api/setup') return ++setupCalls === 1 ? initialSetup.promise : json({error: {message: '本地账号已初始化，请登录。'}}, 409);
  });
  await until(() => !app.el('login-submit').disabled);
  submit(app);
  await until(() => setupCalls === 1);
  app.el('cancel-login').fire('click'); await drain();
  ownerExists = true;
  initialSetup.resolve(json({access_token: 'late-setup-token'}, 201)); await drain();
  assert.equal(app.calls.some(call => call.path === '/api/me'), false);
  assert.equal(app.el('workspace').hidden, true);
  // Cancellation cannot undo an owner transaction that already reached the server.
  submit(app);
  await until(() => app.el('auth-title').textContent === '登录本地资料库');
  assert.match(app.el('global-message').textContent, /已初始化/);
  submit(app);
  await until(() => app.el('library-list').children.length === 2);
  assert.equal(app.el('workspace').hidden, false);
});

test('an unreadable login error leaves a usable login form without an authenticated view', async () => {
  const app = harness(({path}) => path === '/api/login' ? new Response('upstream-free synthetic invalid error body', {status: 500}) : undefined);
  await until(() => !app.el('login-submit').disabled);
  submit(app); await drain();
  assert.match(app.el('global-message').textContent, /无法识别/);
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('login-submit').disabled, false);
  assert.equal(app.calls.some(call => call.path === '/api/me'), false);
});
