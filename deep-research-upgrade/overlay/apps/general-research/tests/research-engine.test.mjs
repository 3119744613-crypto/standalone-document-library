import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ResearchEngine} from '../lib/research.mjs';

const plan = {summary: 'Compare three document parsers.', steps: ['Read the requirements', 'Compare the public documentation', 'Review and write the report'], public_queries: ['open source document parser documentation']};
const source = {id: 'original-fragment', kind: 'document', kb_id: 'library-a', file_id: 'file-a', title: 'requirements.md', content: 'REQ_PRIVATE_FRAGMENT: The parser must preserve heading structure.', locator: {type: 'lines', start: 2, end: 3}, start_line: 2, end_line: 3};
const web = {kind: 'web', title: 'Parser documentation', url: 'https://example.org/parser', content: 'The parser supports structured documents.', locator: {url: 'https://example.org/parser'}};
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    const result = predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for task state');
}
function fixture(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'general-research-test-'));
  const calls = [], searches = [];
  const library = {getSourceExcerpts() { return [structuredClone(source)]; }, ...overrides.library};
  const provider = {configured: true, publicInfo: {model: 'synthetic', baseUrl: 'https://example.invalid'},
    async complete(input) {
      calls.push(input);
      if (overrides.complete) return overrides.complete(input);
      if (input.role === 'planner') return JSON.stringify(plan);
      if (input.role === 'writer') return '# Comparison\nRequirements [S1]. Public evidence [S2].\nNo performance benchmark was executed.';
      return `${input.role}: evidence ${input.role === 'web_researcher' ? '[S2]' : '[S1]'}.`;
    }};
  const search = {configured: true, async search(input) { searches.push(input); return overrides.search ? overrides.search(input) : [structuredClone(web)]; }};
  const engine = new ResearchEngine({dataDir, library, provider, search});
  t.after(() => { engine.close(); rmSync(dataDir, {recursive: true, force: true}); });
  const create = (extra = {}) => engine.create({objective: 'Compare three open source document parsers.', kb_id: 'library-a', file_ids: ['file-a'], max_calls: 5, ...extra});
  const planned = async () => { const task = create(); engine.plan(task.id); await until(() => engine.get(task.id).status === 'awaiting_confirmation'); return engine.get(task.id); };
  const completed = async () => { const task = await planned(); engine.approve(task.id, {plan: task.plan, allow_external: true}); await until(() => ['completed', 'failed'].includes(engine.get(task.id).status)); return engine.get(task.id); };
  return {engine, calls, searches, dataDir, library, provider, search, create, planned, completed};
}

test('creating a task is local; planning waits for review and does not search', async t => {
  const f = fixture(t);
  const draft = f.create();
  assert.equal(draft.status, 'draft'); assert.equal(f.calls.length, 0); assert.equal(f.searches.length, 0);
  assert.equal(f.engine.plan(draft.id).status, 'planning');
  await until(() => f.engine.get(draft.id).status === 'awaiting_confirmation');
  const task = f.engine.get(draft.id);
  assert.deepEqual(f.calls.map(call => call.role), ['planner']);
  assert.equal(task.calls_used, 1); assert.equal(task.allow_external, false); assert.equal(f.searches.length, 0);
  assert.deepEqual(task.plan, plan); assert.deepEqual(task.sources[0].locator, source.locator);
  assert.ok(f.calls[0].prompt.includes(source.content));
  assert.ok(f.calls[0].prompt.includes('untrusted data'));
  assert.throws(() => f.engine.approve(task.id, {plan, allow_external: false}), {code: 'EXTERNAL_CONSENT_REQUIRED'});
  assert.equal(f.searches.length, 0);
});

test('reviewed queries run exactly once and five distinct roles produce source-backed report', async t => {
  const f = fixture(t);
  const task = await f.planned();
  const reviewed = {...plan, public_queries: ['edited public parser topic']};
  f.engine.approve(task.id, {plan: reviewed, allow_external: true});
  await until(() => f.engine.get(task.id).status === 'completed');
  const done = f.engine.get(task.id);
  assert.deepEqual(f.calls.map(call => call.role), ['planner', 'document_researcher', 'web_researcher', 'reviewer', 'writer']);
  assert.deepEqual(f.searches.map(call => call.query), ['edited public parser topic']);
  assert.equal(done.calls_used, 5); assert.equal(done.max_calls, 5);
  assert.ok(done.agents.every(agent => agent.status === 'completed' && agent.output));
  assert.deepEqual(done.sources.map(item => [item.id, item.kind]), [['S1', 'document'], ['S2', 'web']]);
  assert.ok(done.report.includes('[S1]')); assert.ok(done.report.includes('[S2]'));
  assert.ok(f.calls.find(call => call.role === 'reviewer').prompt.includes(web.content));
  assert.ok(f.calls.find(call => call.role === 'writer').prompt.includes('reviewer: evidence'));
  const events = f.engine.events(task.id);
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(events.filter(event => event.type === 'agent_started').length, 5);
  const after = events[2].seq;
  assert.ok(f.engine.events(task.id, after).every(event => event.seq > after));
  assert.ok(!JSON.stringify(events).includes(source.content));
});

test('document and web researchers run concurrently, review starts only after both', async t => {
  const document = pending(), internet = pending();
  const f = fixture(t, {async complete({role}) {
    if (role === 'planner') return JSON.stringify(plan);
    if (role === 'document_researcher') return document.promise;
    if (role === 'web_researcher') return internet.promise;
    return role === 'writer' ? 'Comparison [S1] [S2].' : 'Review [S1] [S2].';
  }});
  const task = await f.planned();
  f.engine.approve(task.id, {plan, allow_external: true});
  await until(() => f.calls.some(call => call.role === 'web_researcher'));
  assert.deepEqual(f.engine.get(task.id).agents.filter(agent => agent.status === 'running').map(agent => agent.role), ['document_researcher', 'web_researcher']);
  assert.ok(!f.calls.some(call => call.role === 'reviewer'));
  internet.resolve('Web [S2]'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.role === 'reviewer'));
  document.resolve('Requirements [S1]');
  await until(() => f.engine.get(task.id).status === 'completed');
});

test('bad model plan fails explicitly; retry preserves attempt history without auto calls', async t => {
  let valid = false;
  const f = fixture(t, {complete() { return valid ? JSON.stringify(plan) : 'bad JSON'; }});
  const task = f.create(); f.engine.plan(task.id);
  await until(() => f.engine.get(task.id).status === 'failed');
  assert.equal(f.engine.get(task.id).error.code, 'INVALID_MODEL_PLAN');
  assert.equal(f.calls.length, 1); assert.equal(f.searches.length, 0);
  valid = true; f.engine.plan(task.id);
  await until(() => f.engine.get(task.id).status === 'awaiting_confirmation');
  assert.equal(f.engine.get(task.id).attempt, 2); assert.equal(f.calls.length, 2);
  assert.ok(f.engine.events(task.id).some(event => event.attempt === 1 && event.type === 'failed'));
});

test('unknown citations or missing public citations cannot mark report completed', async t => {
  for (const report of ['Claims [S1] [S99].', 'Only document claims [S1].', 'No references.']) {
    await t.test(report, async t => {
      const f = fixture(t, {complete({role}) { return role === 'planner' ? JSON.stringify(plan) : role === 'writer' ? report : 'Evidence [S1] [S2].'; }});
      const task = await f.completed();
      assert.equal(task.status, 'failed'); assert.equal(task.report, '');
      assert.ok(['INVALID_CITATIONS', 'MISSING_SOURCE_KIND'].includes(task.error.code));
      assert.ok(!f.engine.events(task.id).some(event => event.type === 'completed'));
    });
  }
});

test('cancelling a planner defeats ignored AbortSignal and late output', async t => {
  const late = pending();
  const f = fixture(t, {complete() { return late.promise; }});
  const task = f.create(); f.engine.plan(task.id);
  await until(() => f.calls.length === 1);
  f.engine.cancel(task.id);
  assert.equal(f.calls[0].signal.aborted, true);
  late.resolve(JSON.stringify(plan)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.engine.get(task.id).status, 'cancelled'); assert.equal(f.engine.get(task.id).plan, null);
  assert.equal(f.engine.events(task.id).at(-1).type, 'cancelled'); assert.equal(f.searches.length, 0);
});

test('cancelled research cannot trigger a reviewer or commit late researcher output', async t => {
  const documents = pending(), publicResults = pending();
  const f = fixture(t, {
    complete({role}) { return role === 'planner' ? JSON.stringify(plan) : documents.promise; },
    search() { return publicResults.promise; }
  });
  const task = await f.planned(); f.engine.approve(task.id, {plan, allow_external: true});
  await until(() => f.searches.length === 1 && f.calls.length === 2);
  f.engine.cancel(task.id);
  documents.resolve('Late private finding'); publicResults.resolve([web]);
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = f.engine.get(task.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.report, '');
  assert.equal(cancelled.sources.length, 1); assert.equal(f.calls.length, 2);
  assert.ok(cancelled.agents.every(agent => !agent.output.includes('Late private')));
});

test('one active task bounds costs; cancelling frees slot without cross-task updates', async t => {
  const late = pending(); let first = true;
  const f = fixture(t, {complete() { if (first) { first = false; return late.promise; } return JSON.stringify(plan); }});
  const a = f.create(), b = f.create(); f.engine.plan(a.id);
  await until(() => f.calls.length === 1);
  assert.throws(() => f.engine.plan(b.id), {code: 'RESEARCH_BUSY'});
  f.engine.cancel(a.id); f.engine.plan(b.id);
  await until(() => f.engine.get(b.id).status === 'awaiting_confirmation');
  late.resolve(JSON.stringify(plan)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.engine.get(a.id).status, 'cancelled'); assert.equal(f.engine.get(b.id).status, 'awaiting_confirmation');
});

test('restart preserves tasks and marks unfinished work interrupted without provider retry', async t => {
  const f = fixture(t);
  const task = await f.planned(); f.engine.close();
  // Represent the durable row left by an abrupt process death before its cleanup hook.
  const db = new DatabaseSync(join(f.dataDir, 'research.sqlite'));
  const row = JSON.parse(db.prepare('SELECT data FROM research_tasks WHERE id=?').get(task.id).data);
  row.status = 'running'; row.agents[1].status = 'running';
  db.prepare('UPDATE research_tasks SET data=? WHERE id=?').run(JSON.stringify(row), task.id); db.close();
  const reopened = new ResearchEngine({dataDir: f.dataDir, library: f.library, provider: f.provider, search: f.search});
  try {
    assert.equal(reopened.get(task.id).status, 'interrupted');
    assert.equal(reopened.get(task.id).error.code, 'SERVER_RESTARTED');
    assert.equal(reopened.get(task.id).agents[1].status, 'cancelled');
    assert.equal(f.calls.length, 1); assert.equal(f.searches.length, 0);
    assert.equal(reopened.events(task.id).at(-1).type, 'interrupted');
    if (process.platform !== 'win32') assert.equal(statSync(join(f.dataDir, 'research.sqlite')).mode & 0o777, 0o600);
  } finally { reopened.close(); }
});

test('document deletion clears snapshots, generated outputs, plan and report durably', async t => {
  const f = fixture(t);
  const task = await f.completed(); assert.equal(task.status, 'completed');
  assert.deepEqual(f.engine.invalidateDocument('other-library', 'file-a'), {invalidated: 0});
  assert.deepEqual(f.engine.invalidateDocument('library-a', 'file-a'), {invalidated: 1});
  const cleared = f.engine.get(task.id);
  assert.equal(cleared.status, 'invalidated'); assert.deepEqual(cleared.sources, []); assert.equal(cleared.report, ''); assert.equal(cleared.plan, null);
  assert.ok(cleared.agents.every(agent => !agent.output));
  assert.throws(() => f.engine.plan(task.id), {code: 'INVALID_TASK_STATE'});
  assert.ok(!JSON.stringify(f.engine.events(task.id)).includes('REQ_PRIVATE_FRAGMENT'));
  assert.ok(!readFileSync(join(f.dataDir, 'research.sqlite')).includes(Buffer.from('REQ_PRIVATE_FRAGMENT')));
});

test('deleting a source during search prevents late repopulation and paid downstream calls', async t => {
  const publicResults = pending();
  const f = fixture(t, {search() { return publicResults.promise; }});
  const task = await f.planned(); f.engine.approve(task.id, {plan, allow_external: true});
  await until(() => f.searches.length === 1);
  f.engine.invalidateDocument('library-a', 'file-a'); publicResults.resolve([web]);
  await new Promise(resolve => setImmediate(resolve));
  const cleared = f.engine.get(task.id);
  assert.equal(cleared.status, 'invalidated'); assert.deepEqual(cleared.sources, []);
  assert.equal(f.calls.length, 2); assert.ok(cleared.agents.every(agent => !agent.output));
});

test('model errors are sanitized, recorded once, and do not auto-retry', async t => {
  const f = fixture(t, {complete() { throw new Error('secret-api-key=do-not-expose'); }});
  const task = f.create(); f.engine.plan(task.id);
  await until(() => f.engine.get(task.id).status === 'failed');
  const failed = f.engine.get(task.id);
  assert.equal(failed.calls_used, 1); assert.equal(f.calls.length, 1); assert.equal(f.searches.length, 0);
  assert.equal(failed.agents[0].status, 'failed');
  assert.ok(!JSON.stringify([failed, f.engine.events(task.id)]).includes('do-not-expose'));
  assert.equal(f.engine.events(task.id).filter(event => event.type === 'agent_failed').length, 1);
});

test('missing indexed documents fail before an external model call', async t => {
  const f = fixture(t, {library: {getSourceExcerpts() { return []; }}});
  const task = f.create(); f.engine.plan(task.id);
  await until(() => f.engine.get(task.id).status === 'failed');
  assert.equal(f.engine.get(task.id).error.code, 'NO_DOCUMENT_SOURCES'); assert.equal(f.calls.length, 0);
});

test('empty public search does not invent sources or produce a report', async t => {
  const f = fixture(t, {search() { return []; }});
  const task = await f.completed();
  assert.equal(task.status, 'failed'); assert.equal(task.error.code, 'NO_WEB_SOURCES'); assert.equal(task.report, '');
  assert.ok(!f.calls.some(call => call.role === 'writer'));
  assert.equal(task.agents.find(agent => agent.role === 'web_researcher').status, 'failed');
});

test('retrying same task cannot accept a response from the cancelled attempt', async t => {
  const late = pending(); let first = true;
  const f = fixture(t, {complete() { if (first) { first = false; return late.promise; } return JSON.stringify(plan); }});
  const task = f.create(); f.engine.plan(task.id); await until(() => f.calls.length === 1);
  f.engine.cancel(task.id); f.engine.plan(task.id);
  await until(() => f.engine.get(task.id).status === 'awaiting_confirmation');
  late.resolve(JSON.stringify({...plan, summary: 'Stale first attempt plan'})); await new Promise(resolve => setImmediate(resolve));
  const current = f.engine.get(task.id);
  assert.equal(current.attempt, 2); assert.equal(current.plan.summary, plan.summary); assert.equal(current.calls_used, 1);
  assert.equal(f.engine.events(task.id).at(-1).attempt, 2);
});

test('search failure marks the web role failed and sanitizes provider detail', async t => {
  const f = fixture(t, {search() { throw new Error('search-secret=do-not-expose'); }});
  const task = await f.completed();
  assert.equal(task.status, 'failed'); assert.equal(task.error.code, 'SEARCH_FAILED');
  assert.equal(task.agents.find(agent => agent.role === 'web_researcher').status, 'failed');
  assert.ok(f.engine.events(task.id).some(event => event.type === 'agent_failed' && event.role === 'web_researcher'));
  assert.ok(!JSON.stringify([task, f.engine.events(task.id)]).includes('do-not-expose'));
});

test('configuration, budget and reviewed-plan bounds reject before paid calls', async t => {
  const f = fixture(t);
  for (const max_calls of [0, 4, 21, '6', NaN]) assert.throws(() => f.create({max_calls}), {code: 'INVALID_BUDGET'});
  assert.throws(() => f.create({file_ids: []}), {code: 'INVALID_DOCUMENTS'});
  assert.throws(() => f.create({file_ids: Array.from({length: 7}, (_, i) => `file-${i}`)}), {code: 'INVALID_DOCUMENTS'});
  f.provider.configured = false;
  const draft = f.create(); assert.throws(() => f.engine.plan(draft.id), {code: 'MODEL_NOT_CONFIGURED'});
  assert.equal(f.calls.length, 0);
  f.provider.configured = true;
  const task = await f.planned();
  assert.throws(() => f.engine.approve(task.id, {plan: {...plan, public_queries: []}, allow_external: true}), {code: 'INVALID_PLAN'});
  for (const query of ['x'.repeat(401), Array(76).fill('x').join(' ')]) {
    assert.throws(() => f.engine.approve(task.id, {plan: {...plan, public_queries: [query]}, allow_external: true}), error => error.status === 400);
    assert.equal(f.engine.get(task.id).status, 'awaiting_confirmation');
  }
  f.search.configured = false;
  assert.throws(() => f.engine.approve(task.id, {plan, allow_external: true}), {code: 'SEARCH_NOT_CONFIGURED'});
  assert.equal(f.calls.length, 1); assert.equal(f.searches.length, 0);
});
