export class StaleRequest extends Error {}
export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

// Clear the local session before contacting the server. A late logout failure
// must never change a newer login, and an HTTP failure is not a revocation.
export async function revokeSession(client, {fetchImpl = (...args) => globalThis.fetch(...args), onCleared = () => {}, onFailure = () => {}} = {}) {
  const token = client.token;
  client.setToken('');
  const stamp = client.snapshot();
  onCleared();
  try {
    const response = await fetchImpl('/general-api/logout', {
      method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && response.status !== 401) throw new ApiError('服务端退出尚未确认。', response.status);
    return true;
  } catch {
    if (client.current(stamp) && !client.token) {
      onFailure('本页已退出；服务端退出尚未确认，原登录将在有效期结束后失效。');
    }
    return false;
  }
}

// Every result belongs to a login and a selected resource. Aborting a fetch is
// not enough: a completed response can already be queued when selection changes.
export class GeneralClient {
  constructor({fetchImpl = (...args) => globalThis.fetch(...args), onExpired = () => {}} = {}) {
    this.fetchImpl = fetchImpl; this.onExpired = onExpired;
    this.token = ''; this.epoch = 0; this.scopes = new Map(); this.pending = new Map();
  }
  snapshot(scope = 'global') { return {epoch: this.epoch, scope, version: this.scopes.get(scope) || 0}; }
  current(stamp) { return stamp.epoch === this.epoch && stamp.version === (this.scopes.get(stamp.scope) || 0); }
  cancel(key) { this.pending.get(key)?.controller.abort(); this.pending.delete(key); }
  invalidate(scope) {
    this.scopes.set(scope, (this.scopes.get(scope) || 0) + 1);
    for (const [key, item] of this.pending) if (item.scope === scope) { item.controller.abort(); this.pending.delete(key); }
  }
  setToken(token) {
    this.epoch += 1; this.token = token;
    for (const item of this.pending.values()) item.controller.abort();
    this.pending.clear(); this.scopes.clear();
  }
  async request(path, {method = 'GET', body, scope = 'global', key = `${method}:${path}`, auth = true, timeout = 120000} = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new ApiError('资料接口路径无效。');
    const stamp = this.snapshot(scope);
    this.cancel(key);
    const controller = new AbortController();
    const item = {controller, scope}; this.pending.set(key, item);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    const valid = () => this.current(stamp) && this.pending.get(key) === item;
    try {
      const headers = {Accept: 'application/json'};
      if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
      const form = typeof FormData !== 'undefined' && body instanceof FormData;
      if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
      const response = await this.fetchImpl(`/general-api${path}`, {method, headers, body: body === undefined ? undefined : form ? body : JSON.stringify(body), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'});
      const raw = await response.text();
      if (!valid()) throw new StaleRequest();
      if (auth && response.status === 401) { this.setToken(''); this.onExpired(); throw new StaleRequest(); }
      let data = {};
      if (raw) { try { data = JSON.parse(raw); } catch { throw new ApiError('服务返回了无法识别的内容。', response.status); } }
      if (!response.ok) throw new ApiError(data.error?.message || data.detail || `请求失败（${response.status}）。`, response.status);
      return data;
    } catch (error) {
      if (!valid() || error instanceof StaleRequest) throw new StaleRequest();
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('等待服务超时。请刷新任务，确认实际状态后再操作。');
      if (error.name === 'AbortError') throw new StaleRequest();
      throw new ApiError('无法连接本地服务，请确认启动窗口仍在运行。');
    } finally { clearTimeout(timer); if (this.pending.get(key) === item) this.pending.delete(key); }
  }
}

export const terminalTask = task => ['completed', 'failed', 'cancelled', 'interrupted', 'invalidated'].includes(task?.status);
export function mergeTask(current, incoming) {
  if (!incoming) return current;
  if (!current || current.id !== incoming.id) return incoming;
  if (Number(incoming.attempt) > Number(current.attempt)) return incoming;
  if (Number(incoming.attempt) < Number(current.attempt)) return current;
  if (Number.isFinite(current.version) && Number.isFinite(incoming.version) && incoming.version < current.version) return current;
  if (incoming.updated_at && current.updated_at && incoming.updated_at < current.updated_at) return current;
  if (terminalTask(current) && !terminalTask(incoming)) return current;
  return incoming;
}
export function mergeTaskList(tasks, incoming) {
  if (!incoming?.id) return tasks;
  const index = tasks.findIndex(task => task.id === incoming.id);
  if (index < 0) return [incoming, ...tasks];
  const merged = mergeTask(tasks[index], incoming);
  if (merged === tasks[index]) return tasks;
  return tasks.map((task, position) => position === index ? merged : task);
}
export function approvalPlan(summary, steps, publicQueries) {
  const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
  return {summary: summary.trim(), steps: lines(steps), public_queries: lines(publicQueries)};
}
export function safeSourceUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function sourceLocator(source = {}) {
  const initial = {...source, ...source.metadata};
  if (typeof initial.locator === 'string') return initial.locator;
  const data = {...initial, ...(initial.locator || {})};
  if (data.page || data.page_number) return `第 ${data.page || data.page_number} 页${data.page_line_start ? ` · 页内第 ${data.page_line_start} 行` : ''}`;
  if (data.table) return `第 ${data.table} 个表格 · 第 ${data.row} 行 ${data.cell} 列${data.paragraph ? ` · 第 ${data.paragraph} 段` : ''}`;
  if (data.paragraph || data.paragraph_number) return `第 ${data.paragraph || data.paragraph_number} 段`;
  if (data.start_line) return `第 ${data.start_line}${data.end_line && data.end_line !== data.start_line ? `–${data.end_line}` : ''} 行`;
  return data.url ? '公开资料' : '原始文档';
}
