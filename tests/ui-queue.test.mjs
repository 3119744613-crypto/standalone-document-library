import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, json, deferred, until, drain} from './ui-harness.mjs';

const actions = app => app.el('document-rows').children[0].children[2].children[0].children;
const docList = status => json({documents: [{file_id: 'doc-a', filename: 'a.md', status}], canManage: true, total: 1, offset: 0, limit: 100, has_more: false});
const processCalls = app => app.calls.filter(call => /\/(parse|index)$/.test(call.path));

test('a pending parse suppresses duplicate parse and index submissions for that document', async () => {
  const pending = deferred();
  const app = harness(({path}) => /\/(parse|index)$/.test(path) ? pending.promise : path.startsWith('/api/databases/a/documents?') ? docList('uploaded') : undefined);
  await app.login(); await app.select(0);
  const oldActions = actions(app);
  oldActions[1].fire('click'); oldActions[1].fire('click'); oldActions[2].fire('click');
  await drain();
  const disabled = [actions(app)[1].disabled, actions(app)[2].disabled];
  pending.resolve(json({status: 'queued', task_id: 'task-a'})); await drain();
  assert.equal(processCalls(app).length, 1);
  assert.deepEqual(disabled, [true, true]);
});

test('queued indexing remains pending when refresh still returns its original status', async () => {
  const app = harness(({path}) => path.endsWith('/index') ? json({status: 'queued', task_id: 'task-a'}) : undefined);
  await app.login(); await app.select(0);
  actions(app)[2].fire('click'); await drain();
  assert.equal(actions(app)[2].disabled, true);
  assert.match(app.el('document-rows').children[0].children[1].children[0].textContent, /排队/);
  app.el('refresh-documents').fire('click'); await drain();
  assert.equal(actions(app)[2].disabled, true);
  assert.equal(processCalls(app).length, 1);
});

test('observed processing state clears the queue label and blocks completed document reprocessing', async () => {
  let status = 'parsed';
  const app = harness(({path}) => path.endsWith('/index') ? json({status: 'queued', task_id: 'task-a'}) : path.startsWith('/api/databases/a/documents?') ? docList(status) : undefined);
  await app.login(); await app.select(0);
  actions(app)[2].fire('click'); await drain();
  status = 'indexing'; app.el('refresh-documents').fire('click'); await drain();
  assert.equal(actions(app)[1].disabled, true);
  assert.match(app.el('document-rows').children[0].children[1].children[0].textContent, /正在索引/);
  status = 'indexed'; app.el('refresh-documents').fire('click'); await drain();
  assert.equal(actions(app)[1].disabled, true);
  assert.equal(actions(app)[2].disabled, true);
  assert.equal(app.el('document-rows').children[0].children[1].children[0].textContent, '已索引');
  actions(app)[1].fire('click'); actions(app)[2].fire('click'); await drain();
  assert.equal(processCalls(app).length, 1);
});

test('submission failure releases the document lock for an explicit retry', async () => {
  const pending = deferred();
  const app = harness(({path}) => path.endsWith('/parse') ? pending.promise : path.startsWith('/api/databases/a/documents?') ? docList('uploaded') : undefined);
  await app.login(); await app.select(0);
  actions(app)[1].fire('click'); await drain();
  const disabledWhilePending = actions(app)[1].disabled;
  pending.resolve(json({error: {message: 'Synthetic queue unavailable'}}, 502)); await drain();
  assert.equal(disabledWhilePending, true);
  assert.equal(actions(app)[1].disabled, false);
  assert.equal(actions(app)[2].disabled, true);
  assert.match(app.el('documents-message').textContent, /unavailable/);
});

test('a library switch drops pending locks and ignores a late queue receipt', async () => {
  const pending = deferred();
  const app = harness(({path}) => path.endsWith('/parse') ? pending.promise : path.startsWith('/api/databases/a/documents?') ? docList('uploaded') : undefined);
  await app.login(); await app.select(0);
  actions(app)[1].fire('click'); await drain();
  await app.select(1);
  pending.resolve(json({status: 'queued', task_id: 'old-task'})); await drain();
  assert.equal(app.el('library-title').textContent, 'Library b');
  assert.equal(actions(app)[1].disabled, true);
  assert.equal(actions(app)[2].disabled, false);
  assert.doesNotMatch(app.el('documents-message').textContent, /old-task/);
});

test('an observed parsing failure releases the queue lock and shows the actual failure', async () => {
  let status = 'uploaded';
  const app = harness(({path}) => path.endsWith('/parse') ? json({status: 'queued', task_id: 'task-a'}) : path.startsWith('/api/databases/a/documents?') ? docList(status) : undefined);
  await app.login(); await app.select(0);
  actions(app)[1].fire('click'); await drain();
  status = 'error_parsing'; app.el('refresh-documents').fire('click'); await drain();
  assert.equal(actions(app)[1].disabled, false);
  assert.equal(app.el('document-rows').children[0].children[1].children[0].textContent, '解析失败');
});


test('persisted processing error is displayed as plain text beside the failure status', async () => {
  const app = harness(({path}) => path.startsWith('/api/databases/a/documents?') ? json({documents: [{file_id:'doc-a',filename:'a.md',status:'error_parsing',error_message:'UTF-8 decoding failed <script>sample</script>'}],canManage:true,total:1}) : undefined);
  await app.login(); await app.select(0);
  const status = app.el('document-rows').children[0].children[1];
  assert.equal(status.children[0].textContent, '解析失败');
  assert.equal(status.children[1].textContent, 'UTF-8 decoding failed <script>sample</script>');
});
