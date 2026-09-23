export const UPSTREAM_COMMIT = 'd633378c7ea55618ac659a547bfe90f74b29af4c';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_BYTES = 32 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class LibraryError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, {status, code, details});
  }
}
export function validateUpstream(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('YUXI_LIBRARY_UPSTREAM must be an origin URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('YUXI_LIBRARY_UPSTREAM must be HTTPS or loopback HTTP, with no credentials, path, query or fragment');
  }
  return url.origin;
}
export async function boundedBody(body, limit, signal) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const {value, done} = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new LibraryError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '资料服务响应超过大小限制。');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function checkBusiness(data) {
  if (data && typeof data === 'object'
      && (['failed', 'partial_failed', 'error'].includes(data.status) || data.success === false)) {
    throw new LibraryError(502, 'UPSTREAM_OPERATION_FAILED', '资料服务未完成请求，请检查后端任务状态。');
  }
  return data;
}
export function createUpstream({upstream, timeoutMs = 12000, fetchImpl = fetch}) {
  return async function call(path, {method = 'GET', token, body, signal, form = false} = {}) {
    if (!upstream) throw new LibraryError(503, 'BACKEND_NOT_CONFIGURED', '尚未配置独立 Yuxi 资料服务。');
    if (!path.startsWith('/api/')) throw new LibraryError(500, 'INVALID_INTERNAL_ROUTE', '请求路径无效。');
    const timer = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    const headers = {Accept: 'application/json'};
    if (token) headers.Authorization = token;
    if (body && !form) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${upstream}${path}`, {
        method, headers, body: body == null ? undefined : form ? body : JSON.stringify(body),
        redirect: 'manual', signal: combined,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new LibraryError(502, 'UPSTREAM_REDIRECT_REJECTED', '资料服务返回了不允许跟随的重定向。');
      }
      if (!response.ok) {
        await response.body?.cancel();
        const status = [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
        const messages = {401: '登录已失效或凭据无效。', 403: '当前账户无权执行此操作。', 404: '资料不存在或当前账户无权访问。', 409: '资料已存在或操作发生冲突。', 429: '资料服务请求过多，请稍后重试。'};
        throw new LibraryError(status, `UPSTREAM_HTTP_${response.status}`, messages[status] || '资料服务拒绝或未能完成请求。');
      }
      if (response.status === 204) return {};
      if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
        await response.body?.cancel();
        throw new LibraryError(502, 'UPSTREAM_INVALID_RESPONSE', '资料服务未返回有效 JSON。');
      }
      const raw = await boundedBody(response.body, MAX_RESPONSE_BYTES, combined);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw new LibraryError(502, 'UPSTREAM_INVALID_RESPONSE', '资料服务返回的 JSON 无效。'); }
      return checkBusiness(data);
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      if (signal?.aborted) throw new LibraryError(499, 'CLIENT_DISCONNECTED', '请求已取消。');
      if (timer.aborted) throw new LibraryError(504, 'UPSTREAM_TIMEOUT', '资料服务响应超时。');
      throw new LibraryError(502, 'UPSTREAM_UNREACHABLE', '无法连接独立 Yuxi 资料服务。');
    }
  };
}

export const safeText = value => typeof value === 'string' ? value : '';
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] != null).map(k => [k, value[k]]));
export const documentView = value => pick(value, ['file_id', 'filename', 'status', 'file_type', 'file_size', 'size', 'created_at', 'updated_at', 'is_folder', 'parent_id', 'source_path']);
export const databaseView = (value, reader = false) => ({
  ...pick(value, ['kb_id', 'name', 'description', 'kb_type', 'supports_documents']),
  can_manage: !reader && value.can_manage === true,
});
export function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LibraryError(400, 'INVALID_JSON', '请求必须是 JSON 对象。');
  return value;
}
export function textField(value, name, {max = 1000, empty = false} = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new LibraryError(400, 'INVALID_FIELD', `${name} 格式或长度无效。`);
  return value.trim();
}
export function resultView(data) {
  if (!Array.isArray(data?.results)) throw new LibraryError(502, 'UPSTREAM_INVALID_RESPONSE', '当前知识库未返回支持的结构化检索结果。');
  return {results: data.results.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.id !== 'string' || !row.id
        || typeof row.kb_id !== 'string' || !row.kb_id
        || typeof row.content !== 'string'
        || (row.file_id != null && typeof row.file_id !== 'string')) {
      throw new LibraryError(502, 'UPSTREAM_INVALID_RESPONSE', '检索结果结构无效，不能作为可信来源显示。');
    }
    const metadata = Object.fromEntries(Object.entries(pick(row.metadata,
      ['filename', 'file_name', 'source', 'source_path', 'page', 'start_line', 'end_line', 'score']))
      .filter(([, value]) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))));
    return {id: row.id, kb_id: row.kb_id, file_id: row.file_id || '', content: row.content, metadata};
  })};
}
