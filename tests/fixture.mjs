/** Synthetic contract fixture, never a production fallback or a real Yuxi service. */
import http from 'node:http';
import {createHash} from 'node:crypto';

export const FIXTURE_ACCOUNTS = Object.freeze({
  admin: {username: 'synthetic-admin', password: 'fixture-only-admin', token: 'synthetic-admin-token'},
  reader: {username: 'synthetic-reader', password: 'fixture-only-reader', token: 'synthetic-reader-token'},
});

export function createFixture({transitionMs = 600} = {}) {
  const state = {
    synthetic: true, audit: [], faults: new Map(), readerRevoked: false,
    registrationFailure: null, actionFailure: null, nextFile: 1,
    uploads: new Map(), documents: new Map(),
    databases: new Map([
      ['software-docs', {kb_id: 'software-docs', name: '合成软件说明', description: '仅用于本机合同验收', kb_type: 'milvus', shared: true}],
      ['private-notes', {kb_id: 'private-notes', name: '管理员私有笔记', description: '跨账户权限测试', kb_type: 'milvus', shared: false}],
    ]),
  };
  const timers = new Set();
  const sockets = new Set();
  const later = fn => {
    const timer = setTimeout(() => {timers.delete(timer); fn();}, transitionMs);
    timers.add(timer);
  };
  const audit = (kind, details) => state.audit.push({at: new Date().toISOString(), kind, ...details});
  const visible = (kb, role) => state.databases.has(kb) && (role === 'admin' || (role === 'reader' && !state.readerRevoked && state.databases.get(kb).shared));
  const docs = kb => [...state.documents.values()].filter(x => x.kb_id === kb);
  const publicMeta = doc => ({file_id: doc.file_id, filename: doc.filename, status: doc.status, file_type: doc.filename.split('.').at(-1), file_size: Buffer.byteLength(doc.content), created_at: doc.created_at, updated_at: doc.created_at, is_folder: false, parent_id: null});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const auth = req.headers.authorization || '';
    const role = auth === `Bearer ${FIXTURE_ACCOUNTS.admin.token}` || auth === 'Bearer yxkey_synthetic-admin' ? 'admin'
      : auth === `Bearer ${FIXTURE_ACCOUNTS.reader.token}` ? 'reader' : null;
    audit('request', {method: req.method, path, search: url.search, role, cookieReceived: Boolean(req.headers.cookie)});
    res.setHeader('X-Synthetic-Fixture', 'true');
    res.once('close', () => audit('response_close', {path, ended: res.writableEnded}));
    const json = (status, body) => {
      if (!res.destroyed) res.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
    };
    const read = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    try {
      // Explicit fixture-only controls are not included in the BFF route allowlist.
      if (path === '/__fixture/control' && req.method === 'POST') {
        const body = JSON.parse((await read()).toString());
        for (const key of ['readerRevoked', 'registrationFailure', 'actionFailure']) {
          if (Object.hasOwn(body, key)) state[key] = body[key];
        }
        json(200, {synthetic: true}); return;
      }
      const fault = state.faults.get(path);
      if (fault) {
        if (fault.type === 'timeout') return;
        if (fault.type === 'disconnect') {res.destroy(); return;}
        if (fault.type === 'redirect') {res.writeHead(302, {Location: fault.location || '/__redirect_target'}).end(); return;}
        if (fault.type === 'large') {json(200, {data: 'x'.repeat(3 * 1024 * 1024)}); return;}
        if (fault.type === 'invalid-json') {res.writeHead(200, {'Content-Type': 'application/json'}).end('not-json'); return;}
        json(fault.status || 200, fault.body || {status: 'failed', message: 'SECRET internal stack credential=DO_NOT_FORWARD'}); return;
      }
      if (path === '/api/auth/check-first-run') {json(200, {first_run: false}); return;}
      if (path === '/api/auth/token' && req.method === 'POST') {
        const body = new URLSearchParams((await read()).toString());
        const account = Object.values(FIXTURE_ACCOUNTS).find(x => x.username === body.get('username') && x.password === body.get('password'));
        audit('login_form', {contentType: req.headers['content-type'], grantType: body.get('grant_type'), username: body.get('username')});
        json(account ? 200 : 401, account ? {access_token: account.token, token_type: 'bearer'} : {detail: 'invalid synthetic credentials'});
        return;
      }
      if (!role) {json(401, {detail: 'authentication required'}); return;}
      if (path === '/api/auth/me') {
        json(200, {uid: `fixture-${role}`, username: FIXTURE_ACCOUNTS[role].username, name: role, role: role === 'admin' ? 'admin' : 'user', password_hash: 'SECRET_SHOULD_BE_DROPPED'}); return;
      }
      if (path === '/api/knowledge/databases/external') {
        json(200, {databases: [...state.databases.values()].filter(db => visible(db.kb_id, role)).map(({shared, ...db}) => ({...db, supports_documents: true}))}); return;
      }
      if (path === '/api/knowledge/databases') {
        if (role !== 'admin') {json(403, {detail: 'admin only'}); return;}
        if (req.method === 'POST') {
          const body = JSON.parse((await read()).toString());
          audit('create_database', {body});
          if (!body.embedding_model_spec) {json(400, {detail: 'embedding model required'}); return;}
          const kb = `created-${state.databases.size}`;
          const db = {kb_id: kb, name: body.database_name, description: body.description, kb_type: body.kb_type, shared: false};
          state.databases.set(kb, db);
          json(200, {...db, can_manage: true}); return;
        }
        json(200, {databases: [...state.databases.values()].map(db => ({...db, can_manage: true, supports_documents: true, additional_params: {api_key: 'SECRET_SHOULD_BE_DROPPED'}, metadata: {password: 'SECRET_SHOULD_BE_DROPPED'}}))}); return;
      }
      if (path === '/api/knowledge/files/upload' && req.method === 'POST') {
        const kb = url.searchParams.get('kb_id');
        if (role !== 'admin' || !visible(kb, role)) {json(403, {detail: 'manage permission required'}); return;}
        const form = await new Request('http://127.0.0.1/upload', {method: 'POST', headers: {'Content-Type': req.headers['content-type']}, body: await read()}).formData();
        const file = form.get('file');
        const content = await file.text();
        const hash = createHash('sha256').update(content).digest('hex');
        if (docs(kb).some(doc => doc.hash === hash)) {json(409, {detail: 'identical content exists'}); return;}
        const filePath = `minio://documents/${kb}/upload/${state.uploads.size + 1}-${file.name}`;
        state.uploads.set(filePath, {kb_id: kb, filename: file.name, content, hash});
        audit('upload', {kb, filename: file.name, chars: content.length});
        json(200, {file_path: filePath, minio_path: filePath, kb_id: kb, content_hash: hash, filename: file.name, original_filename: file.name.replace(/\.[^.]+$/, ''), size: Buffer.byteLength(content), has_same_name: docs(kb).some(d => d.filename === file.name)}); return;
      }
      const ext = path.match(/^\/api\/knowledge\/databases\/external\/([^/]+)\/(files|retrieve)(?:\/([^/]+)\/open)?$/);
      if (ext) {
        const [, kb, action, id] = ext;
        if (!visible(kb, role)) {json(404, {detail: 'not found or inaccessible'}); return;}
        if (action === 'retrieve') {
          const body = JSON.parse((await read()).toString());
          audit('retrieve', {kb, body});
          json(200, {kb_id: kb, results: docs(kb).filter(d => ['indexed', 'done'].includes(d.status)).map(doc => ({id: `chunk-${doc.file_id}`, kb_id: kb, file_id: doc.file_id, content: doc.content, metadata: {filename: doc.filename, page: 1, api_key: 'SECRET_SHOULD_BE_DROPPED'}}))}); return;
        }
        if (id) {
          const doc = state.documents.get(id);
          if (!doc || doc.kb_id !== kb) {json(404, {detail: 'document missing'}); return;}
          if (!['parsed', 'indexed', 'done'].includes(doc.status)) {json(400, {detail: 'not parsed'}); return;}
          const lines = doc.content.split('\n');
          const offset = Number(url.searchParams.get('offset') || 0);
          const limit = Number(url.searchParams.get('limit') || 200);
          const end = Math.min(offset + limit, lines.length);
          json(200, {kb_id: kb, file_id: id, start_line: offset + 1, end_line: end, total_lines: lines.length, offset, window_size: limit, has_more_before: offset > 0, has_more_after: end < lines.length, next_offset: end < lines.length ? end : null, content: lines.slice(offset, end).map((line, i) => `${offset + i + 1}: ${line}`).join('\n')}); return;
        }
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
        const all = docs(kb);
        json(200, {files: all.slice(offset, offset + limit).map(publicMeta), total: all.length, offset, limit, has_more: offset + limit < all.length}); return;
      }
      const managed = path.match(/^\/api\/knowledge\/databases\/([^/]+)(?:\/documents(?:\/([^/]+))?(?:\/(basic|content))?)?$/);
      if (managed) {
        const [, kb, action, detail] = managed;
        if (role !== 'admin') {json(403, {detail: 'admin only'}); return;}
        if (!visible(kb, role)) {json(404, {detail: 'missing database'}); return;}
        if (!path.includes('/documents')) {json(200, {...state.databases.get(kb), can_manage: true}); return;}
        if (!action) {json(200, {items: docs(kb).map(publicMeta), total: docs(kb).length}); return;}
        if (action === 'add' && req.method === 'POST') {
          const body = JSON.parse((await read()).toString());
          audit('register', {kb, body});
          if (state.registrationFailure) {json(200, {status: state.registrationFailure, items: [], failed_items: [{error: 'SECRET internal registration stack'}], added: 0, failed: 1}); return;}
          const items = [];
          for (const item of body.items) {
            const uploaded = state.uploads.get(item);
            if (!uploaded || uploaded.kb_id !== kb || body.params?.content_hashes?.[item] !== uploaded.hash) {json(200, {status: 'failed', added: 0, failed: 1}); return;}
            const id = `file-${state.nextFile++}`;
            const doc = {...uploaded, file_id: id, status: 'uploaded', created_at: new Date().toISOString()};
            state.documents.set(id, doc);
            items.push({index: items.length, item, file_id: id, status: 'uploaded', file_meta: publicMeta(doc)});
          }
          json(200, {status: 'success', items, failed_items: [], added: items.length, failed: 0}); return;
        }
        if (['parse', 'index'].includes(action) && req.method === 'POST') {
          const body = JSON.parse((await read()).toString());
          audit('document_action', {kb, action, body});
          if (state.actionFailure) {json(200, {status: state.actionFailure, message: 'SECRET internal parse stack'}); return;}
          const selected = (body.file_ids || []).map(id => state.documents.get(id)).filter(d => d?.kb_id === kb);
          if (!selected.length) {json(404, {detail: 'missing files'}); return;}
          selected.forEach(doc => {doc.status = action === 'parse' ? 'parsing' : 'indexing';});
          later(() => selected.forEach(doc => {if (state.documents.has(doc.file_id)) doc.status = action === 'parse' ? 'parsed' : 'indexed';}));
          json(200, {status: 'queued', task_id: `fixture-${action}-${selected[0].file_id}`}); return;
        }
        const doc = state.documents.get(action);
        if (!doc || doc.kb_id !== kb) {json(404, {detail: 'missing document'}); return;}
        if (req.method === 'DELETE') {state.documents.delete(action); json(200, {message: '删除成功'}); return;}
        if (detail === 'basic') {json(200, {meta: {...publicMeta(doc), api_key: 'SECRET_SHOULD_BE_DROPPED'}}); return;}
        if (detail === 'content') {json(200, {content: doc.content}); return;}
      }
      json(404, {detail: 'unknown fixture route'});
    } catch (error) {
      // Only test diagnostics are retained in memory; never dump credentials.
      audit('fixture_error', {name: error.name});
      json(500, {detail: 'synthetic fixture error'});
    }
  });
  server.on('connection', socket => {sockets.add(socket); socket.once('close', () => sockets.delete(socket));});
  return {
    server, state,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
