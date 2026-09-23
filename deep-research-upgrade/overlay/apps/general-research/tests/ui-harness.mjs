import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual UI script against a minimal DOM. These are deterministic
// session/race tests, not a substitute for browser or real storage acceptance.
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false; this.files = []; this.attributes = new Map();
    const classes = new Set();
    this.classList = {add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), toggle: (k, yes) => yes ? classes.add(k) : classes.delete(k)};
  }
  set innerHTML(_) { throw new Error('Untrusted HTML rendering is forbidden'); }
  setAttribute(k, v) { this.attributes.set(k, v); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  fire(type) { for (const fn of this.listeners.get(type) || []) fn({preventDefault() {}}); }
  close() { this.open = false; }
  showModal() { this.open = true; }
  reset() {}
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail('UI did not reach the expected state');
}
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function harness(override = () => undefined) {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => {
    const element = new Element();
    element.hidden = /\shidden(?:\s|>)/.test(match[0]);
    element.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    return [match[1], element];
  }));
  const calls = [];
  const document = {getElementById(id) { assert.ok(elements.has(id), `Missing actual HTML id: ${id}`); return elements.get(id); }, createElement() { return new Element(); }};
  const win = new Element(); win.confirm = () => true;
  const libraries = ['a', 'b'].map(kb_id => ({kb_id, name: `Library ${kb_id}`, kb_type: 'local', supports_documents: true, can_manage: true}));
  const context = vm.createContext({
    document, window: win, AbortController, FormData, setTimeout, clearTimeout, console,
    fetch: async (path, options) => {
      const call = {path, options}; calls.push(call);
      const special = override(call);
      if (special !== undefined) return special;
      const route = path.split('?')[0];
      if (route === '/api/status') return json({backendConfigured: true, backendReachable: true, setupRequired: false});
      if (route === '/api/login' || route === '/api/setup') return json({access_token: 'synthetic-admin-token'});
      if (route === '/api/logout') return json({status: 'success'});
      if (route === '/api/me') return json({user: {name: 'Synthetic admin'}});
      if (route === '/api/databases') return json({databases: libraries, canCreate: true});
      const docs = /^\/api\/databases\/(a|b)\/documents$/.exec(route);
      if (docs) return json({documents: [{file_id: `doc-${docs[1]}`, filename: `${docs[1]}.md`, status: 'parsed'}], canManage: true, total: 1, offset: 0, limit: 100, has_more: false});
      if (route.endsWith('/content')) return json({content: 'A previously authorized passage', total_lines: 1, end_line: 1});
      if (route.endsWith('/query')) return json({results: []});
      throw new Error(`Unmodelled route: ${route}`);
    },
  });
  vm.runInContext(script, context, {filename: 'actual-public-app.js'});
  const el = id => elements.get(id);
  return {el, calls, async login() {
    await until(() => !el('login-submit').disabled);
    el('username').value = 'synthetic-owner'; el('password').value = 'only-test-password'; el('login-form').fire('submit');
    await until(() => el('library-list').children.length === 2);
  }, async select(index) {
    el('library-list').children[index].fire('click');
    await drain();
  }};
}

export {harness, json, deferred, until, drain};
