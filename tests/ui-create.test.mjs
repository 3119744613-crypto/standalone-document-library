import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, json, until, drain} from './ui-harness.mjs';

test('successful creation followed by a failed list refresh reports both outcomes honestly', async () => {
  let created = false;
  const app = harness(({path, options}) => {
    if (path === '/api/databases' && options.method === 'POST') {
      created = true;
      return json({database: {kb_id: 'created-library'}});
    }
    if (path === '/api/databases' && created) return json({error: {message: 'Synthetic list unavailable'}}, 503);
  });
  await app.login();
  app.el('new-library').fire('click');
  app.el('create-name').value = 'Software notes';
  app.el('create-form').fire('submit');
  await until(() => created); await drain();
  const creation = app.calls.find(call => call.path === '/api/databases' && call.options.method === 'POST');
  assert.deepEqual(JSON.parse(creation.options.body), {database_name: 'Software notes', description: ''});
  assert.match(app.el('global-message').textContent, /已创建|创建.*成功/);
  assert.match(app.el('global-message').textContent, /刷新.*失败/);
  assert.doesNotMatch(app.el('global-message').textContent, /列表已刷新/);
  assert.match(app.el('library-message').textContent, /unavailable/);
  assert.equal(app.el('create-submit').disabled, false);
});
