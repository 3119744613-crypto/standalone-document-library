import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {
  LibraryError, createUpstream, validateUpstream, UPSTREAM_COMMIT,
  MAX_FILE_BYTES, MAX_JSON_BYTES, requireObject, textField,
  databaseView, documentView, resultView,
} from './lib/upstream.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const routes = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const ID = '[A-Za-z0-9_.-]{1,160}';
const invalidResponse = () => new LibraryError(502, 'UPSTREAM_INVALID_RESPONSE', '资料服务返回了不支持的响应结构。');
const only = (data, keys) => Object.fromEntries(keys.filter(k => data?.[k] != null).map(k => [k, data[k]]));
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function reply(res, status, data, type = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {...headers, 'Content-Type': type});
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
async function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) throw new LibraryError(413, 'REQUEST_TOO_LARGE', '上传或请求超过大小限制。');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new LibraryError(413, 'REQUEST_TOO_LARGE', '上传或请求超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function jsonBody(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new LibraryError(415, 'JSON_REQUIRED', '此操作需要 JSON 请求。');
  }
  const raw = await readBody(req, MAX_JSON_BYTES);
  try { return requireObject(JSON.parse(raw.toString('utf8'))); }
  catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError(400, 'INVALID_JSON', 'JSON 请求无效。'); }
}
function pageValue(url, key, fallback, max) {
  const raw = url.searchParams.get(key);
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) throw new LibraryError(400, 'INVALID_PAGE', '分页参数无效。');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max || (key === 'limit' && value < 1)) throw new LibraryError(400, 'INVALID_PAGE', '分页参数超出范围。');
  return value;
}
function bearer(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer [^\s\x00-\x1f\x7f]{1,8192}$/.test(value)) {
    throw new LibraryError(401, 'AUTH_REQUIRED', '请使用独立 Yuxi 账号登录或提供有效 API Key。');
  }
  return value;
}
function isForbidden(error) { return error instanceof LibraryError && error.status === 403; }

export function createLibraryServer({upstream = null, timeoutMs = 12000, fetchImpl = fetch, publicDir = resolve(moduleRoot, 'public')} = {}) {
  const origin = validateUpstream(upstream);
  const call = createUpstream({upstream: origin, timeoutMs, fetchImpl});
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new LibraryError(403, 'HOST_REJECTED', '此资料入口仅接受本机访问。');
      const requestOrigin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== requestOrigin) throw new LibraryError(403, 'ORIGIN_REJECTED', '请求来源不匹配。');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new LibraryError(403, 'ORIGIN_REJECTED', '不接受跨站请求。');
      const url = new URL(req.url, requestOrigin);
      if (url.origin !== requestOrigin) throw new LibraryError(400, 'INVALID_TARGET', '请求目标无效。');
      const path = url.pathname;
      const method = req.method;
      if ((method === 'GET' || method === 'HEAD') && routes.has(path)) {
        const [name, type] = routes.get(path);
        const bytes = await readFile(resolve(publicDir, name));
        reply(res, 200, method === 'HEAD' ? '' : bytes, type); return;
      }
      if (path === '/api/status' && method === 'GET') {
        let reachable = false, status = origin ? 'unavailable' : 'not_configured';
        let message = origin ? '尚未连接 Yuxi 后端，请检查其运行状态。' : '独立模块已启动。请设置 YUXI_LIBRARY_UPSTREAM 为你的独立 Yuxi 服务地址后重启。';
        if (origin) {
          try {
            const first = await call('/api/auth/check-first-run', {signal: controller.signal});
            if (typeof first?.first_run !== 'boolean') throw invalidResponse();
            reachable = true; status = first.first_run ? 'setup_required' : 'reachable';
            message = first.first_run ? 'Yuxi 后端可连接，请先在独立 Yuxi 中初始化账号。' : 'Yuxi 后端可连接；登录后按当前账户权限访问资料。';
          } catch (error) { if (error.code === 'CLIENT_DISCONNECTED') return; message = error.message; }
        }
        reply(res, 200, {backendConfigured: Boolean(origin), backendReachable: reachable, backendStatus: status, backendUrl: origin, upstreamCommit: UPSTREAM_COMMIT, message}); return;
      }
      if (path === '/api/login' && method === 'POST') {
        const data = await jsonBody(req);
        const username = textField(data.username, '用户名', {max: 256});
        // Whitespace can be part of a password. Never normalize or log it.
        if (typeof data.password !== 'string' || !data.password || data.password.length > 2048) throw new LibraryError(400, 'INVALID_FIELD', '密码格式或长度无效。');
        const response = await call('/api/auth/token', {method: 'POST', form: true, body: new URLSearchParams({username, password: data.password}), signal: controller.signal});
        if (typeof response?.access_token !== 'string' || !response.access_token || response.access_token.length > 8192 || /\s/.test(response.access_token)) throw invalidResponse();
        reply(res, 200, {access_token: response.access_token, token_type: 'bearer'}); return;
      }
      if (!path.startsWith('/api/')) throw new LibraryError(404, 'NOT_FOUND', '页面不存在。');
      const token = bearer(req);
      const options = {token, signal: controller.signal};
      if (path === '/api/me' && method === 'GET') {
        const data = await call('/api/auth/me', options);
        if (!data || typeof data !== 'object' || !(data.username || data.uid || data.id != null)) throw invalidResponse();
        reply(res, 200, {user: only(data, ['id', 'uid', 'username', 'name', 'role', 'department_id'])}); return;
      }
      if (path === '/api/databases' && method === 'GET') {
        const accessible = await call('/api/knowledge/databases/external', options);
        if (!Array.isArray(accessible?.databases)) throw invalidResponse();
        let managed = [], canCreate = false;
        try {
          const data = await call('/api/knowledge/databases', options);
          if (!Array.isArray(data?.databases)) throw invalidResponse();
          managed = data.databases; canCreate = true;
        } catch (error) { if (!isForbidden(error)) throw error; }
        const byId = new Map(managed.map(item => [item.kb_id, item]));
        reply(res, 200, {databases: accessible.databases.map(item => ({...databaseView(item, true), can_manage: byId.get(item.kb_id)?.can_manage === true})), canCreate}); return;
      }
      if (path === '/api/databases' && method === 'POST') {
        const input = await jsonBody(req);
        if (input.kb_type !== 'milvus') throw new LibraryError(400, 'UNSUPPORTED_LIBRARY_TYPE', '本入口仅支持显式创建 Milvus 资料库。');
        const body = {database_name: textField(input.database_name, '资料库名称', {max: 100}), description: textField(input.description ?? '', '说明', {empty: true}), kb_type: 'milvus', embedding_model_spec: textField(input.embedding_model_spec, 'Embedding 模型标识', {max: 500}), llm_model_spec: null, additional_params: {}, share_config: null};
        const data = await call('/api/knowledge/databases', {...options, method: 'POST', body});
        if (!data?.kb_id) throw invalidResponse();
        reply(res, 201, {database: databaseView(data)}); return;
      }
      const match = new RegExp(`^/api/databases/(${ID})(?:/(documents|upload|query))?(?:/(${ID}))?(?:/(content|basic|parse|index))?$`).exec(path);
      if (!match) throw new LibraryError(404, 'NOT_FOUND', '不支持的资料接口。');
      const [, kb, operation, id, action] = match;
      const base = `/api/knowledge/databases/${kb}`;
      const external = `/api/knowledge/databases/external/${kb}`;
      if (operation === 'documents' && !id && method === 'GET') {
        const offset = pageValue(url, 'offset', 0, 1000000), limit = pageValue(url, 'limit', 100, 500);
        const data = await call(`${external}/files?offset=${offset}&limit=${limit}&status=all`, options);
        if (!Array.isArray(data?.files)) throw invalidResponse();
        let canManage = false;
        try { const detail = await call(base, options); canManage = detail?.can_manage === true; }
        catch (error) { if (!isForbidden(error)) throw error; }
        reply(res, 200, {documents: data.files.map(documentView), canManage, total: data.total, offset, limit, has_more: data.has_more === true}); return;
      }
      if (operation === 'query' && !id && method === 'POST') {
        const body = await jsonBody(req);
        const data = await call(`${external}/retrieve`, {...options, method: 'POST', body: {query: textField(body.query, '查询内容', {max: 8000}), options: {}}});
        reply(res, 200, resultView(data)); return;
      }
      if (operation === 'documents' && id && method === 'GET' && action === 'content') {
        const offset = pageValue(url, 'offset', 0, 10000000), limit = pageValue(url, 'limit', 200, 1800);
        const data = await call(`${external}/files/${id}/open?offset=${offset}&limit=${limit}`, options);
        if (typeof data?.content !== 'string') throw invalidResponse();
        reply(res, 200, only(data, ['kb_id', 'file_id', 'content', 'start_line', 'end_line', 'total_lines', 'offset', 'window_size', 'has_more_before', 'has_more_after', 'next_offset'])); return;
      }
      if (operation === 'documents' && id && method === 'GET' && action === 'basic') {
        const data = await call(`${base}/documents/${id}/basic`, options);
        if (!data?.meta || typeof data.meta !== 'object') throw invalidResponse();
        reply(res, 200, {meta: documentView(data.meta)}); return;
      }
      if (operation === 'documents' && id && method === 'POST' && ['parse', 'index'].includes(action)) {
        await jsonBody(req);
        const data = await call(`${base}/documents/${action}`, {...options, method: 'POST', body: {file_ids: [id], params: {}}});
        if (data?.status !== 'queued' || typeof data.task_id !== 'string') throw invalidResponse();
        reply(res, 202, {status: 'queued', task_id: data.task_id}); return;
      }
      if (operation === 'documents' && id && !action && method === 'DELETE') {
        const deleted = await call(`${base}/documents/${id}`, {...options, method: 'DELETE'});
        if (typeof deleted?.message !== 'string' || !deleted.message.trim()) throw invalidResponse();
        reply(res, 200, {status: 'success', physicalDeletionVerified: false}); return;
      }
      if (operation === 'upload' && !id && method === 'POST') {
        if (!(req.headers['content-type'] || '').startsWith('multipart/form-data;')) throw new LibraryError(415, 'MULTIPART_REQUIRED', '上传需要 multipart 文件表单。');
        const raw = await readBody(req, MAX_FILE_BYTES + 64 * 1024);
        let form;
        try { form = await new Request('http://localhost/upload', {method: 'POST', headers: {'Content-Type': req.headers['content-type']}, body: raw}).formData(); }
        catch { throw new LibraryError(400, 'INVALID_UPLOAD', '上传表单无效。'); }
        const values = [...form.entries()];
        if (values.length !== 1 || values[0][0] !== 'file' || typeof values[0][1] === 'string') throw new LibraryError(400, 'INVALID_UPLOAD', '请一次上传一个文件。');
        const file = values[0][1];
        if (!/^[^/\\\x00-\x1f]{1,220}\.(md|txt)$/i.test(file.name)) throw new LibraryError(400, 'UNSUPPORTED_FILE', '只支持文件名合法的 Markdown 或 TXT 文档。');
        if (file.size > MAX_FILE_BYTES) throw new LibraryError(413, 'FILE_TOO_LARGE', '文件超过 10 MiB 限制。');
        const uploadForm = new FormData(); uploadForm.append('file', file, file.name);
        const uploaded = await call(`/api/knowledge/files/upload?kb_id=${kb}`, {...options, method: 'POST', body: uploadForm, form: true});
        // Uploading and registering are separate transactions in Yuxi.
        try {
          const hash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
          if (typeof uploaded?.file_path !== 'string' || !uploaded.file_path || uploaded.content_hash !== hash || uploaded.size !== file.size) throw invalidResponse();
          const path = uploaded.file_path;
          const registered = await call(`${base}/documents/add`, {...options, method: 'POST', body: {items: [path], params: {content_type: 'file', content_hashes: {[path]: hash}, file_sizes: {[path]: file.size}, source_paths: {[path]: file.name}}}});
          if (registered?.status !== 'success' || registered.failed !== 0 || registered.added !== 1 || !Array.isArray(registered.items) || registered.items.length !== 1 || !registered.items[0]?.file_id || ['failed', 'error'].includes(registered.items[0]?.status)) throw invalidResponse();
          const item = registered.items[0];
          reply(res, 201, {status: 'success', document: {...documentView(item.file_meta || item), file_id: item.file_id}, hasSameName: uploaded.has_same_name === true});
        } catch (error) {
          if (error instanceof LibraryError) error.details = {...error.details, staged: true, registrationFailed: true};
          throw error;
        }
        return;
      }
      throw new LibraryError(404, 'NOT_FOUND', '不支持的资料接口。');
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const known = error instanceof LibraryError;
      const status = known && error.status !== 499 ? error.status : 500;
      reply(res, status, {error: {code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '独立资料入口暂时无法完成请求。'}, ...(known ? error.details : {})});
      // Do not log request URLs, credentials, bodies or upstream error payloads.
      if (!req.readableEnded) req.resume();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.YUXI_LIBRARY_PORT || 4184);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid YUXI_LIBRARY_PORT');
  const server = createLibraryServer({upstream: process.env.YUXI_LIBRARY_UPSTREAM || null});
  server.on('error', error => { console.error(`Library server could not start (${error.code || 'ERROR'}).`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Independent Yuxi library: http://127.0.0.1:${port}/`));
}
