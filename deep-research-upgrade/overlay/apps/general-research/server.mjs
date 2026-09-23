import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {LibraryError, MAX_FILE_BYTES, MAX_JSON_BYTES, requireObject} from './lib/common.mjs';
import {LibraryStore} from './lib/store.mjs';
import {ResearchEngine} from './lib/research.mjs';
import {createModelProvider, createWebSearch} from './lib/providers.mjs';

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

export function createLibraryServer({dataDir = resolve(moduleRoot, '.runtime'), publicDir = resolve(moduleRoot, 'public'), frontendDir = null, provider = createModelProvider(), search = createWebSearch()} = {}) {
  const store = new LibraryStore(dataDir);
  let research;
  try { research = new ResearchEngine({dataDir, library:store, provider, search}); }
  catch (error) { store.close(); throw error; }
  const eventConnections = new Set();
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
      const path = url.pathname.startsWith('/general-api/') ? url.pathname.replace('/general-api/', '/api/') : url.pathname;
      if (frontendDir && ['GET','HEAD'].includes(req.method) && (path === '/' || path === '/general.html' || /^\/assets\/[A-Za-z0-9_.-]+$/.test(path))) {
        const name = path === '/' || path === '/general.html' ? 'general.html' : path.slice(1);
        try {
          const bytes = await readFile(resolve(frontendDir, name));
          const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
          reply(res,200,req.method === 'HEAD' ? '' : bytes,type);
        } catch { reply(res,503,{error:{code:'FRONTEND_NOT_BUILT',message:'请先构建 apps/web 前端，再启动通用工作台。'}}); }
        return;
      }
      const method = req.method;
      if ((method === 'GET' || method === 'HEAD') && routes.has(path)) {
        const [name, type] = routes.get(path);
        const bytes = await readFile(resolve(publicDir, name));
        reply(res, 200, method === 'HEAD' ? '' : bytes, type); return;
      }
      if (path === '/api/status' && method === 'GET') {
        const setupRequired = store.setupRequired();
        reply(res, 200, {backendConfigured: true, backendReachable: true, backendStatus: setupRequired ? 'setup_required' : 'ready', setupRequired, storage: 'sqlite', searchMode: 'keyword', research: {configured:provider.configured,model:provider.publicInfo?.model || '',baseUrl:provider.publicInfo?.baseUrl || '',searchConfigured:search.configured,searchService:'Brave Search',maxCalls:6}, message: setupRequired ? '本地资料库已启动，请创建本机账号。' : '本地资料库已就绪；文档保存在此电脑，索引后可按关键词检索。'}); return;
      }
      if (['/api/setup', '/api/login'].includes(path) && method === 'POST') {
        const data = await jsonBody(req);
        const result = path === '/api/setup' ? await store.setup(data) : await store.login(data);
        reply(res, path === '/api/setup' ? 201 : 200, result); return;
      }
      if (!path.startsWith('/api/')) throw new LibraryError(404, 'NOT_FOUND', '页面不存在。');
      const token = bearer(req);
      const user = store.authenticate(token);
      // A request body can arrive after another request has revoked this session.
      const authenticatedBody = async () => { const data = await jsonBody(req); store.authenticate(token); return data; };
      if (path === '/api/me' && method === 'GET') {
        reply(res, 200, {user}); return;
      }
      if (path === '/api/logout' && method === 'POST') {
        await authenticatedBody(); store.logout(token); reply(res, 200, {status: 'success'}); return;
      }
      if (path === '/api/research' && method === 'GET') { reply(res,200,{tasks:research.list()}); return; }
      if (path === '/api/research' && method === 'POST') { reply(res,201,{task:research.create(await authenticatedBody())}); return; }
      const researchMatch = /^\/api\/research\/([A-Za-z0-9-]{1,80})(?:\/(plan|approve|cancel|events|report))?$/.exec(path);
      if (researchMatch) {
        const [,id,action] = researchMatch;
        if (!action && method === 'GET') { reply(res,200,{task:research.get(id)}); return; }
        if (action === 'report' && method === 'GET') {
          const task = research.get(id);
          if (task.status !== 'completed') throw new LibraryError(409,'REPORT_NOT_READY','任务尚未完成，不能导出成功报告。');
          reply(res,200,task.report,'text/markdown; charset=utf-8'); return;
        }
        if (['plan','approve','cancel'].includes(action) && method === 'POST') {
          const data = await authenticatedBody();
          if (action === 'plan' && data.allow_external !== true) throw new LibraryError(400,'CONSENT_REQUIRED','请先确认将所选资料片段与任务需求发送给配置的模型服务。');
          const task = action === 'plan' ? research.plan(id) : action === 'approve' ? research.approve(id,data) : research.cancel(id);
          reply(res, action === 'cancel' ? 200 : 202,{task}); return;
        }
        if (action === 'events' && method === 'GET') {
          let cursor = pageValue(url,'after',0,Number.MAX_SAFE_INTEGER);
          const lastId = req.headers['last-event-id'];
          if (lastId && /^\d+$/.test(lastId)) cursor = Math.max(cursor, Number(lastId));
          research.get(id);
          res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});
          let timer,nextPage,closed=false,paused=false,ticks=0;
          const stop = () => { if (closed) return; closed=true; clearInterval(timer); clearImmediate(nextPage); res.off('drain',resume); eventConnections.delete(stop); if (!res.writableEnded) res.end(); };
          const resume = () => { paused=false; tick(); };
          const write = text => { if (res.write(text)) return true; paused=true; res.once('drain',resume); return false; };
          const tick = () => {
            if (closed || res.destroyed) { stop(); return; }
            if (paused || nextPage) return;
            try {
              store.authenticate(token);
              const events=research.events(id,cursor);
              for (const event of events) {
                cursor = event.seq;
                if (!write(`id: ${event.seq}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`)) return;
              }
              // A terminal task can still have historical pages left to replay.
              if (events.length === 200) { nextPage=setImmediate(() => { nextPage=null; tick(); }); return; }
              if (['completed','failed','cancelled','interrupted','invalidated','awaiting_confirmation','draft'].includes(research.get(id).status)) { stop(); return; }
              if (++ticks % 20 === 0) write(': heartbeat\n\n');
            } catch { res.write('event: progress\ndata: {"type":"refresh_required"}\n\n'); stop(); }
          };
          eventConnections.add(stop); res.on('close',stop); timer=setInterval(tick,500); tick(); return;
        }
        throw new LibraryError(404,'NOT_FOUND','通用研究接口不存在。');
      }
      if (path === '/api/databases' && method === 'GET') { reply(res, 200, store.listLibraries()); return; }
      if (path === '/api/databases' && method === 'POST') { reply(res, 201, store.createLibrary(await authenticatedBody())); return; }
      const match = new RegExp(`^/api/databases/(${ID})/(documents|upload|query)(?:/(${ID}))?(?:/(content|basic|parse|index))?$`).exec(path);
      if (!match) throw new LibraryError(404, 'NOT_FOUND', '不支持的资料接口。');
      const [, kb, operation, id, action] = match;
      if (operation === 'documents' && !id && method === 'GET') {
        reply(res, 200, store.listDocuments(kb, pageValue(url, 'offset', 0, 1000000), pageValue(url, 'limit', 100, 500))); return;
      }
      if (operation === 'query' && !id && method === 'POST') { reply(res, 200, store.query(kb, (await authenticatedBody()).query)); return; }
      if (operation === 'documents' && id && method === 'GET' && action === 'content') {
        reply(res, 200, store.content(kb, id, pageValue(url, 'offset', 0, 10000000), pageValue(url, 'limit', 200, 1800))); return;
      }
      if (operation === 'documents' && id && method === 'GET' && action === 'basic') { reply(res, 200, store.basic(kb, id)); return; }
      if (operation === 'documents' && id && method === 'POST' && ['parse', 'index'].includes(action)) {
        await authenticatedBody(); reply(res, 202, store.queue(kb, id, action)); return;
      }
      if (operation === 'documents' && id && !action && method === 'DELETE') { store.basic(kb,id); research.invalidateDocument(kb,id); reply(res, 200, store.deleteDocument(kb, id)); return; }
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
        if (!/^[^/\\\x00-\x1f\x7f]{1,220}\.(md|txt|pdf|docx)$/i.test(file.name)) throw new LibraryError(400, 'UNSUPPORTED_FILE', '只支持文件名合法的 PDF、DOCX、Markdown 或 TXT 文档。');
        if (file.size > MAX_FILE_BYTES) throw new LibraryError(413, 'FILE_TOO_LARGE', '文件超过 10 MiB 限制。');
        const bytes = Buffer.from(await file.arrayBuffer());
        store.authenticate(token);
        reply(res, 201, store.upload(kb, file.name, bytes)); return;
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
  const originalClose = server.close.bind(server);
  server.close = (...args) => { for (const stop of [...eventConnections]) stop(); research.close(); return originalClose(...args); };
  server.on('close', () => { research.close(); store.close(); });
  server.on('error', () => { if (!server.listening) { research.close(); store.close(); } });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configFile=resolve(moduleRoot,'.env.general');
  if (existsSync(configFile)) loadEnvFile(configFile);
  const ownPython = resolve(moduleRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!process.env.GENERAL_PYTHON && existsSync(ownPython)) process.env.GENERAL_PYTHON = ownPython;
  const port = Number(process.env.GENERAL_PORT || 4196);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GENERAL_PORT');
  const server = createLibraryServer({dataDir: process.env.GENERAL_DATA_DIR || resolve(moduleRoot, '.runtime'), frontendDir: resolve(moduleRoot,'../web/dist-general'), provider:createModelProvider({baseUrl:process.env.GENERAL_MODEL_BASE_URL,model:process.env.GENERAL_MODEL,apiKey:process.env.GENERAL_MODEL_API_KEY}),search:createWebSearch({apiKey:process.env.GENERAL_SEARCH_API_KEY})});
  server.on('error', error => { console.error(`Library server could not start (${error.code || 'ERROR'}).`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`General research workbench: http://127.0.0.1:${port}/`));
  const stop = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
