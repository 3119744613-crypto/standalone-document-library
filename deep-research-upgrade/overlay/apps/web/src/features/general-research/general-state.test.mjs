import test from 'node:test';
import assert from 'node:assert/strict';
import {GeneralClient, StaleRequest, approvalPlan, mergeTask, mergeTaskList, revokeSession, safeSourceUrl, sourceLocator} from './general-state.mjs';

const deferred = () => { let resolve; return {promise:new Promise(done => {resolve = done;}), resolve:value => resolve(value)}; };
const response = (data,status = 200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

test('default browser fetch retains its global receiver instead of using the client instance',async () => {
  const original = globalThis.fetch;
  let calls=0;
  globalThis.fetch = async function() {
    assert.equal(this,globalThis,'native browser fetch requires its global receiver');
    calls++;
    return response({setupRequired:false});
  };
  try {
    const client = new GeneralClient();
    assert.equal((await client.request('/status',{auth:false})).setupRequired,false);
    client.setToken('synthetic-session');
    assert.equal(await revokeSession(client),true);
    assert.equal(calls,2);
  } finally { globalThis.fetch = original; }
});

test('general requests stay within own API and omit cookies',async () => {
  let seen;
  const client = new GeneralClient({fetchImpl:async (url,options) => { seen = {url,options}; return response({task:{id:'one'}}); }});
  client.setToken('local-session');
  await client.request('/research/one/approve',{method:'POST',body:{allow_external:true},scope:'task'});
  assert.equal(seen.url,'/general-api/research/one/approve');
  assert.equal(seen.options.headers.Authorization,'Bearer local-session');
  assert.equal(seen.options.credentials,'omit');
  assert.equal(seen.options.redirect,'error');
  assert.equal(JSON.parse(seen.options.body).allow_external,true);
});
test('late response after logout cannot repopulate data',async () => {
  const pending = deferred(); const client = new GeneralClient({fetchImpl:() => pending.promise});
  client.setToken('first'); const result = client.request('/research/one',{scope:'task'});
  client.setToken(''); pending.resolve(response({private:'old content'}));
  await assert.rejects(result,StaleRequest);
});
test('logout clears immediately and distinguishes server failures from already-expired credentials',async () => {
  for (const status of [500,403,401,200]) {
    const pending = deferred(); const client = new GeneralClient(); client.setToken('old-session');
    let cleared=0; let failures=0;
    const result = revokeSession(client,{fetchImpl:() => pending.promise,onCleared:() => cleared++,onFailure:() => failures++});
    assert.equal(client.token,''); assert.equal(cleared,1); assert.equal(failures,0);
    pending.resolve(response({},status));
    assert.equal(await result,[200,401].includes(status));
    assert.equal(failures,[200,401].includes(status) ? 0 : 1);
  }
});
test('a delayed logout failure cannot publish a notice into a newer login',async () => {
  const pending=deferred(); const client=new GeneralClient(); client.setToken('old-session'); let failures=0;
  const result=revokeSession(client,{fetchImpl:() => pending.promise,onFailure:() => failures++});
  client.setToken('new-session'); pending.resolve(response({},503));
  assert.equal(await result,false); assert.equal(client.token,'new-session'); assert.equal(failures,0);
});
test('late task cancellation receipt cannot replace a different selected task',async () => {
  const pending = deferred(); const client = new GeneralClient({fetchImpl:() => pending.promise});
  const result = client.request('/research/one/cancel',{method:'POST',body:{},scope:'task'});
  client.invalidate('task'); pending.resolve(response({task:{id:'one',status:'cancelled'}}));
  await assert.rejects(result,StaleRequest);
});
test('closing a preview rejects a completed but queued response',async () => {
  const pending = deferred(); const client = new GeneralClient({fetchImpl:() => pending.promise});
  const result = client.request('/databases/k/documents/f/content',{scope:'library',key:'preview'});
  client.cancel('preview'); pending.resolve(response({content:'private text'}));
  await assert.rejects(result,StaleRequest);
});
test('newer request owns the same key even if older fetch ignores abort',async () => {
  const one = deferred(); const two = deferred(); let count=0;
  const client = new GeneralClient({fetchImpl:() => (++count === 1 ? one : two).promise});
  const first = client.request('/research/one',{key:'detail',scope:'task'});
  const second = client.request('/research/one',{key:'detail',scope:'task'});
  two.resolve(response({status:'completed'})); assert.equal((await second).status,'completed');
  one.resolve(response({status:'running'})); await assert.rejects(first,StaleRequest);
});
test('401 clears memory credentials even when its body is malformed',async () => {
  let expired=0; const client = new GeneralClient({fetchImpl:async () => new Response('broken',{status:401}),onExpired:() => expired++});
  client.setToken('old'); await assert.rejects(client.request('/me'),StaleRequest);
  assert.equal(client.token,''); assert.equal(expired,1);
});
test('old login session cannot expire a newer one',async () => {
  const pending=deferred(); let expired=0; const client = new GeneralClient({fetchImpl:() => pending.promise,onExpired:() => expired++});
  client.setToken('old'); const result=client.request('/me'); client.setToken('new');
  pending.resolve(response({},401)); await assert.rejects(result,StaleRequest); assert.equal(client.token,'new'); assert.equal(expired,0);
});
test('stale progress cannot regress cancellation, but a new attempt may start',() => {
  const cancelled={id:'one',attempt:1,status:'cancelled',updated_at:'2026-01-02'};
  assert.equal(mergeTask(cancelled,{id:'one',attempt:1,status:'running',updated_at:'2026-01-01'}),cancelled);
  assert.equal(mergeTask(cancelled,{id:'one',attempt:2,status:'planning'}).status,'planning');
  const second={id:'one',attempt:2,status:'running'};
  assert.equal(mergeTask(second,cancelled),second);
});
test('sidebar receives completed progress and rejects stale updates without disturbing other tasks',() => {
  const other = {id:'other',attempt:1,status:'draft',updated_at:'2026-01-01'};
  const running = {id:'active',attempt:1,status:'running',updated_at:'2026-01-01'};
  const complete = {...running,status:'completed',updated_at:'2026-01-02',calls_used:5};
  const synced = mergeTaskList([other,running],complete);
  assert.equal(synced[1].status,'completed'); assert.equal(synced[1].calls_used,5);
  assert.equal(synced[0],other);
  assert.equal(mergeTaskList(synced,running),synced,'late progress must not undo completed sidebar state');
  const retry = {...running,attempt:2,status:'planning',updated_at:'2026-01-03'};
  assert.equal(mergeTaskList(synced,retry)[1].status,'planning');
});
test('approval preserves only explicit edited nonempty lines and summary',() => {
  assert.deepEqual(approvalPlan(' software selection ',' compare APIs\n\n check license ',' tool docs\n official source '),{summary:'software selection',steps:['compare APIs','check license'],public_queries:['tool docs','official source']});
});
test('source links reject script/data URLs and embedded credentials',() => {
  assert.equal(safeSourceUrl('javascript:alert(1)'),null);
  assert.equal(safeSourceUrl('data:text/html,test'),null);
  assert.equal(safeSourceUrl('https://name:password@example.com'),null);
  assert.equal(safeSourceUrl('https://example.org/docs'),'https://example.org/docs');
});
test('document references expose pages, paragraphs, and line ranges',() => {
  assert.equal(sourceLocator({page:2}),'第 2 页');
  assert.equal(sourceLocator({paragraph:7}),'第 7 段');
  assert.equal(sourceLocator({metadata:{start_line:3,end_line:8}}),'第 3–8 行');
  assert.equal(sourceLocator({locator:{kind:'pdf',page:3,page_line_start:2}}),'第 3 页 · 页内第 2 行');
  assert.equal(sourceLocator({locator:{kind:'docx',table:2,row:3,cell:1,paragraph:2}}),'第 2 个表格 · 第 3 行 1 列 · 第 2 段');
});
