import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {LibraryError, MAX_FILE_BYTES, MAX_JSON_BYTES, requireObject} from './lib/common.mjs';
import {LibraryStore} from './lib/store.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const routes = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const ID = '[A-Za-z0-9_.-]{1,160}';
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
    throw new LibraryError(401, 'AUTH_REQUIRED', '请登录本地资料库。');
  }
  return value.slice(7);
}

export function createLibraryServer({dataDir = resolve(moduleRoot, '.runtime'), publicDir = resolve(moduleRoot, 'public')} = {}) {
  const store = new LibraryStore(dataDir);
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !allowedHosts.includes(req.headers.host)) throw new LibraryError(403, 'HOST_REJECTED', '此资料入口仅接受本机访问。');
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
        const setupRequired = store.setupRequired();
        reply(res, 200, {backendConfigured: true, backendReachable: true, backendStatus: setupRequired ? 'setup_required' : 'ready', setupRequired, storage: 'sqlite', searchMode: 'keyword', message: setupRequired ? '本地资料库已启动，请创建本机账号。' : '本地资料库已就绪；文档保存在此电脑，索引后可按关键词检索。'}); return;
      }
      if (['/api/setup', '/api/login'].includes(path) && method === 'POST') {
        const data = await jsonBody(req);
        const result = path === '/api/setup' ? await store.setup(data) : await store.login(data);
        reply(res, path === '/api/setup' ? 201 : 200, result); return;
      }
      if (!path.startsWith('/api/')) throw new LibraryError(404, 'NOT_FOUND', '页面不存在。');
      const token = bearer(req);
      const user = store.authenticate(token);
      if (path === '/api/me' && method === 'GET') {
        reply(res, 200, {user}); return;
      }
      if (path === '/api/logout' && method === 'POST') {
        await jsonBody(req); store.logout(token); reply(res, 200, {status: 'success'}); return;
      }
      if (path === '/api/databases' && method === 'GET') { reply(res, 200, store.listLibraries()); return; }
      if (path === '/api/databases' && method === 'POST') { reply(res, 201, store.createLibrary(await jsonBody(req))); return; }
      const match = new RegExp(`^/api/databases/(${ID})/(documents|upload|query)(?:/(${ID}))?(?:/(content|basic|parse|index))?$`).exec(path);
      if (!match) throw new LibraryError(404, 'NOT_FOUND', '不支持的资料接口。');
      const [, kb, operation, id, action] = match;
      if (operation === 'documents' && !id && method === 'GET') {
        reply(res, 200, store.listDocuments(kb, pageValue(url, 'offset', 0, 1000000), pageValue(url, 'limit', 100, 500))); return;
      }
      if (operation === 'query' && !id && method === 'POST') { reply(res, 200, store.query(kb, (await jsonBody(req)).query)); return; }
      if (operation === 'documents' && id && method === 'GET' && action === 'content') {
        reply(res, 200, store.content(kb, id, pageValue(url, 'offset', 0, 10000000), pageValue(url, 'limit', 200, 1800))); return;
      }
      if (operation === 'documents' && id && method === 'GET' && action === 'basic') { reply(res, 200, store.basic(kb, id)); return; }
      if (operation === 'documents' && id && method === 'POST' && ['parse', 'index'].includes(action)) {
        await jsonBody(req); reply(res, 202, store.queue(kb, id, action)); return;
      }
      if (operation === 'documents' && id && !action && method === 'DELETE') { reply(res, 200, store.deleteDocument(kb, id)); return; }
      if (operation === 'upload' && !id && method === 'POST') {
        store.library(kb);
        if (!(req.headers['content-type'] || '').startsWith('multipart/form-data;')) throw new LibraryError(415, 'MULTIPART_REQUIRED', '上传需要 multipart 文件表单。');
        const raw = await readBody(req, MAX_FILE_BYTES + 64 * 1024);
        let form;
        try { form = await new Request('http://localhost/upload', {method: 'POST', headers: {'Content-Type': req.headers['content-type']}, body: raw}).formData(); }
        catch { throw new LibraryError(400, 'INVALID_UPLOAD', '上传表单无效。'); }
        const values = [...form.entries()];
        if (values.length !== 1 || values[0][0] !== 'file' || typeof values[0][1] === 'string') throw new LibraryError(400, 'INVALID_UPLOAD', '请一次上传一个文件。');
        const file = values[0][1];
        if (!/^[^/\\\x00-\x1f\x7f]{1,220}\.(md|txt)$/i.test(file.name)) throw new LibraryError(400, 'UNSUPPORTED_FILE', '只支持文件名合法的 Markdown 或 TXT 文档。');
        if (file.size > MAX_FILE_BYTES) throw new LibraryError(413, 'FILE_TOO_LARGE', '文件超过 10 MiB 限制。');
        reply(res, 201, store.upload(kb, file.name, Buffer.from(await file.arrayBuffer()))); return;
      }
      throw new LibraryError(404, 'NOT_FOUND', '不支持的资料接口。');
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      const known = error instanceof LibraryError;
      reply(res, known ? error.status : 500, {error: {code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '本地资料库暂时无法完成请求。'}});
      if (!req.readableEnded) req.resume();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('close', () => store.close());
  server.on('error', () => { if (!server.listening) store.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.LIBRARY_PORT || 4184);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LIBRARY_PORT');
  const server = createLibraryServer({dataDir: process.env.LIBRARY_DATA_DIR || resolve(moduleRoot, '.runtime')});
  server.on('error', error => { console.error(`Library server could not start (${error.code || 'ERROR'}).`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local document library: http://127.0.0.1:${port}/`));
  const stop = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
