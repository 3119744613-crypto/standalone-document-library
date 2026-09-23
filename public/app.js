// Credentials, account data and document text live only in this page's memory.
// All routes below are the local BFF contract, never guessed upstream routes.
const $ = id => document.getElementById(id);
const state = {
  token: '', account: null, accountEpoch: 0, libraryEpoch: 0,
  libraries: [], selected: null, documents: [], canCreate: false, canManage: false,
  docOffset: 0, docHasMore: false, preview: null, configured: false, reachable: false,
  requests: new Map(), operations: new Map(), processing: new Map(), docTotal: 0,
  authMethod: 'login', authPending: false,
};
class StaleRequest extends Error {}
class ApiError extends Error {
  constructor(message, status = 0, payload = {}) { super(message); this.status = status; this.payload = payload; }
}
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const encoded = value => encodeURIComponent(String(value));
const libraryPath = () => `/api/databases/${encoded(state.selected.kb_id)}`;
const snapshot = (library = true) => ({account: state.accountEpoch, library: library ? state.libraryEpoch : null});
const current = stamp => stamp.account === state.accountEpoch && (stamp.library === null || stamp.library === state.libraryEpoch);
function beginOperation(key, {library = true, global = false} = {}) {
  const id = (state.operations.get(key) || 0) + 1;
  state.operations.set(key, id);
  return {key, id, stamp: global ? null : snapshot(library)};
}
const activeOperation = op => state.operations.get(op.key) === op.id && (!op.stamp || current(op.stamp));
function message(id, value = '', kind = '') {
  const node = $(id); node.textContent = value;
  node.classList.remove('error', 'success', 'warn');
  if (kind) node.classList.add(kind);
  if (id === 'global-message') node.hidden = !value;
}
function abortWhere(predicate) {
  for (const [key, item] of state.requests) if (predicate(item, key)) { item.controller.abort(); state.requests.delete(key); }
}
async function request(path, {key = path, method = 'GET', body, auth = true, scope = 'library'} = {}) {
  const stamp = scope === 'global' ? null : snapshot(scope === 'library');
  state.requests.get(key)?.controller.abort();
  const controller = new AbortController();
  const item = {controller, scope, stamp};
  state.requests.set(key, item);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const headers = {Accept: 'application/json'};
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    const raw = await response.text();
    if ((stamp && !current(stamp)) || state.requests.get(key) !== item) throw new StaleRequest();
    if (response.status === 401 && auth && scope !== 'global') {
      clearAccount();
      message('global-message', '登录已失效或凭据无效。本页凭据和资料已清空，请重新登录。', 'error');
      throw new StaleRequest();
    }
    let payload = {};
    if (raw) { try { payload = JSON.parse(raw); } catch { throw new ApiError('服务返回了无法识别的响应，请检查后端连接。', response.status); } }
    if (!response.ok) {
      const detail = text(payload.error?.message) || `请求失败（HTTP ${response.status}）。`;
      const prefix = response.status === 403 ? '权限不足。' : '';
      const staged = payload.staged ? '文件已暂存，但登记失败；尚未加入资料库。' : '';
      throw new ApiError(`${prefix}${staged}${detail}`, response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof StaleRequest || (stamp && !current(stamp)) || state.requests.get(key) !== item) throw new StaleRequest();
    if (error.name === 'AbortError') {
      if (timedOut) throw new ApiError('请求超时，请检查 Yuxi 服务状态后重试。');
      throw new StaleRequest();
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError('无法连接服务。请检查独立模块与 Yuxi 后端是否在线。');
  } finally {
    clearTimeout(timeout);
    if (state.requests.get(key) === item) state.requests.delete(key);
  }
}
function report(id, error) { if (!(error instanceof StaleRequest)) message(id, error.message, 'error'); }
function clearPreview() {
  state.preview = null; $('document-preview').hidden = true;
  for (const id of ['preview-title', 'preview-meta', 'preview-content']) $(id).textContent = '';
  $('load-more-content').hidden = true;
}
function clearQuery() {
  $('query-input').value = ''; $('answer-text').textContent = ''; $('query-sources').replaceChildren();
  $('query-answer').hidden = true; $('cancel-query').hidden = true; $('query-submit').disabled = false;
  message('query-message');
}
function clearLibrary() {
  state.libraryEpoch += 1;
  abortWhere(item => item.scope === 'library');
  state.selected = null; state.documents = []; state.canManage = false; state.docOffset = 0; state.docHasMore = false;
  state.processing.clear(); state.docTotal = 0;
  $('library-detail').hidden = true; $('no-library').hidden = false;
  for (const id of ['library-title', 'library-description', 'library-type', 'document-count']) $(id).textContent = '';
  $('document-rows').replaceChildren(); $('documents-empty').hidden = true; $('document-file').value = '';
  $('load-more-documents').hidden = true; $('upload-submit').disabled = false;
  message('documents-message'); clearPreview(); clearQuery();
}
function clearAccount() {
  state.accountEpoch += 1; abortWhere(item => item.scope !== 'global');
  for (const key of state.operations.keys()) if (key !== 'status') state.operations.delete(key);
  clearLibrary(); state.token = ''; state.account = null; state.libraries = []; state.canCreate = false; state.authPending = false;
  $('workspace').hidden = true; $('auth-section').hidden = false; $('account-label').textContent = '';
  $('library-list').replaceChildren(); message('library-message'); message('create-message');
  $('create-dialog').close(); $('create-form').reset(); $('username').value = ''; $('password').value = ''; $('api-key').value = '';
  $('create-submit').disabled = false;
  $('login-submit').disabled = !state.reachable; $('key-submit').disabled = !state.reachable;
}
function chooseAuth(method) {
  if (state.authPending) { clearAccount(); message('global-message', '已取消先前的身份验证，请使用当前方式重新连接。'); }
  state.authMethod = method;
  $('login-form').hidden = method !== 'login'; $('key-form').hidden = method !== 'key';
  for (const name of ['login', 'key']) {
    $(`choose-${name}`).classList.toggle('active', name === method);
    $(`choose-${name}`).setAttribute('aria-pressed', String(name === method));
  }
  $('password').value = ''; $('api-key').value = '';
}
async function checkStatus() {
  const op = beginOperation('status', {global: true});
  $('refresh-status').disabled = true;
  try {
    const data = await request('/api/status', {key: 'status', auth: false, scope: 'global'});
    state.configured = data.backendConfigured === true; state.reachable = data.backendReachable === true;
    $('connection-title').textContent = !state.configured ? '独立模块已启动 · 等待 Yuxi 地址' : state.reachable ? 'Yuxi 后端可连接' : 'Yuxi 后端未连接';
    $('connection-message').textContent = text(data.message) || (!state.configured ? '请为独立模块配置 YUXI_LIBRARY_UPSTREAM，然后重启服务。' : state.reachable ? '登录后可访问你有权限的资料库。' : '请检查后端地址与服务运行状态。');
    $('backend-address').textContent = text(data.backendUrl) || '尚未配置后端地址';
    $('backend-version').textContent = data.upstreamCommit ? `接口参考版本 ${text(data.upstreamCommit).slice(0, 12)}` : '';
    $('connection-dot').className = `status-dot ${state.reachable ? 'good' : 'bad'}`;
  } catch (error) {
    if (error instanceof StaleRequest) return;
    state.reachable = false;
    $('connection-title').textContent = '无法连接独立模块服务';
    $('connection-message').textContent = error.message;
    $('connection-dot').className = 'status-dot bad';
  } finally {
    if (activeOperation(op)) {
      $('refresh-status').disabled = false;
      $('login-submit').disabled = !state.reachable || state.authPending; $('key-submit').disabled = !state.reachable || state.authPending;
    }
  }
}
async function authenticate(event, method) {
  event.preventDefault();
  const username = $('username').value.trim(), password = $('password').value, apiKey = $('api-key').value.trim();
  clearAccount(); const stamp = snapshot(false); const op = beginOperation('authenticate', {library: false}); state.authPending = true;
  $('login-submit').disabled = true; $('key-submit').disabled = true;
  message('global-message', '正在验证独立 Yuxi 身份…');
  try {
    if (method === 'login') {
      const data = await request('/api/login', {key: 'login', method: 'POST', body: {username, password}, auth: false, scope: 'account'});
      if (!text(data.access_token)) throw new ApiError('登录响应缺少访问令牌，未建立登录状态。');
      state.token = data.access_token;
    } else state.token = apiKey;
    const data = await request('/api/me', {key: 'me', scope: 'account'});
    if (!current(stamp)) return;
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) throw new ApiError('身份响应格式无效，未建立登录状态。');
    state.account = data.user;
    $('account-label').textContent = text(state.account.name) || text(state.account.username) || (method === 'key' ? 'API Key 已验证' : 'Yuxi 用户');
    $('auth-section').hidden = true; $('workspace').hidden = false;
    message('global-message'); await loadLibraries();
  } catch (error) {
    if (error instanceof StaleRequest) return;
    clearAccount(); message('global-message', error.message, 'error');
  } finally {
    if (activeOperation(op)) {
      state.authPending = false; $('password').value = ''; $('api-key').value = '';
      $('login-submit').disabled = !state.reachable; $('key-submit').disabled = !state.reachable;
    }
  }
}
function renderLibraries() {
  $('library-list').replaceChildren();
  for (const library of state.libraries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'library-item';
    const selected = state.selected?.kb_id === library.kb_id;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    const icon = document.createElement('span'); icon.className = 'library-icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
    const details = document.createElement('span'), title = document.createElement('strong'), sub = document.createElement('small');
    title.textContent = text(library.name) || '未命名资料库'; sub.textContent = library.can_manage ? '可管理' : '只读访问';
    details.append(title, sub); button.append(icon, details); button.addEventListener('click', () => selectLibrary(library));
    $('library-list').append(button);
  }
  $('new-library').disabled = !state.canCreate;
  $('new-library').title = state.canCreate ? '新建资料库' : '当前身份没有创建资料库权限';
}
async function loadLibraries() {
  const op = beginOperation('libraries', {library: false}); message('library-message', '正在读取资料库…'); $('refresh-libraries').disabled = true;
  try {
    const data = await request('/api/databases', {key: 'libraries', scope: 'account'});
    if (!Array.isArray(data.databases)) throw new ApiError('资料库列表响应格式无效，未将其视为空列表。');
    state.libraries = data.databases;
    state.canCreate = data.canCreate === true;
    if (state.selected && !state.libraries.some(item => item.kb_id === state.selected.kb_id)) clearLibrary();
    renderLibraries(); message('library-message', state.libraries.length ? '' : '当前账号没有可访问的资料库。');
    return true;
  } catch (error) {
    if (!activeOperation(op)) return;
    if (error.status === 403 || error.status === 404) {
      clearLibrary(); state.libraries = []; state.canCreate = false; renderLibraries();
      message('global-message', '资料库列表读取被拒绝或已不存在。本页资料已清空，请确认当前账号的访问权限。', 'error');
    }
    report('library-message', error);
    return false;
  } finally { if (activeOperation(op)) $('refresh-libraries').disabled = false; }
}
function selectLibrary(library) {
  clearLibrary(); state.selected = library; state.canManage = library.can_manage === true;
  $('no-library').hidden = true; $('library-detail').hidden = false;
  $('library-title').textContent = text(library.name) || '未命名资料库';
  $('library-description').textContent = text(library.description); $('library-type').textContent = text(library.kb_type) || '资料库';
  $('upload-form').hidden = !state.canManage || library.supports_documents === false;
  renderLibraries(); showPane('documents');
  if (library.supports_documents === false) {
    message('documents-message', '此资料库类型不支持当前文档管理接口，可使用独立查询。');
    $('refresh-documents').disabled = true;
  } else { $('refresh-documents').disabled = false; void loadDocuments(); }
}
function showPane(pane) {
  for (const name of ['documents', 'query']) {
    $(`${name}-pane`).hidden = name !== pane; $(`show-${name}`).classList.toggle('active', name === pane);
    $(`show-${name}`).setAttribute('aria-pressed', String(name === pane));
  }
}
const statusLabels = {uploaded:'已上传，待解析',parsing:'正在解析',parsed:'已解析，待索引',error_parsing:'解析失败',indexing:'正在索引',indexed:'已索引',done:'已索引',error_indexing:'索引失败'};
function actionButton(label, action, {danger = false, disabled = false} = {}) {
  const button = document.createElement('button'); button.type = 'button'; button.className = `mini-button${danger ? ' danger' : ''}`;
  button.textContent = label; button.disabled = disabled; button.addEventListener('click', action); return button;
}
function renderDocuments(total = state.docTotal) {
  state.docTotal = Number.isFinite(Number(total)) ? Number(total) : state.documents.length;
  $('document-count').textContent = String(state.docTotal);
  $('document-rows').replaceChildren(); $('documents-empty').hidden = state.documents.length !== 0;
  for (const doc of state.documents) {
    const row = document.createElement('tr'), nameCell = document.createElement('td'), statusCell = document.createElement('td'), actionCell = document.createElement('td');
    const name = document.createElement('span'), id = document.createElement('small'), status = document.createElement('span');
    name.className = 'document-name'; name.textContent = text(doc.filename) || '未命名文档'; id.className = 'document-id'; id.textContent = text(doc.file_id);
    nameCell.append(name,id); status.className = `document-status${text(doc.status).startsWith('error') ? ' failed' : ''}`;
    const pending = state.processing.get(doc.file_id);
    const pendingLabel = pending ? `${pending.action === 'parse' ? '解析' : '索引'}${pending.phase === 'submitting' ? '正在提交' : '已排队，待确认状态'}` : '';
    status.textContent = doc.is_folder ? '文件夹' : pendingLabel || statusLabels[doc.status] || text(doc.status) || '状态未知'; statusCell.append(status);
    const actions = document.createElement('div'); actions.className = 'document-actions';
    if (!doc.is_folder) actions.append(actionButton('原文', () => viewContent(doc)));
    if (state.canManage && !doc.is_folder) {
      const busy = Boolean(pending) || ['parsing','indexing'].includes(doc.status);
      actions.append(actionButton('解析', () => processDocument(doc, 'parse'), {disabled:busy}));
      actions.append(actionButton('索引', () => processDocument(doc, 'index'), {disabled:busy}));
      actions.append(actionButton('删除', () => deleteDocument(doc), {danger:true}));
    }
    actionCell.append(actions); row.append(nameCell,statusCell,actionCell); $('document-rows').append(row);
  }
  $('load-more-documents').hidden = !state.docHasMore;
}
async function loadDocuments(append = false) {
  if (!state.selected) return;
  const op = beginOperation('documents'); const offset = append ? state.docOffset : 0;
  message('documents-message', '正在读取文档状态…'); $('refresh-documents').disabled = true; $('load-more-documents').disabled = true;
  try {
    const data = await request(`${libraryPath()}/documents?offset=${offset}&limit=100`, {key:'documents'});
    if (!Array.isArray(data.documents)) throw new ApiError('文档列表响应格式无效，未将其视为空列表。');
    const documents = data.documents;
    for (const doc of documents) {
      const pending = state.processing.get(doc.file_id);
      // Queuing does not immediately change Yuxi's persisted file status.
      // Keep the lock until a refresh observes a real state/version change.
      if (pending?.phase === 'queued' && (doc.status !== pending.initialStatus
          || (doc.updated_at != null && doc.updated_at !== pending.initialUpdatedAt))) {
        state.processing.delete(doc.file_id);
      }
    }
    state.documents = append ? [...state.documents,...documents] : documents;
    state.canManage = data.canManage === true;
    state.docHasMore = data.has_more === true; state.docOffset = Number(data.offset ?? offset) + Number(data.limit ?? documents.length);
    $('upload-form').hidden = !state.canManage;
    renderDocuments(data.total); message('documents-message');
  } catch (error) {
    if (!activeOperation(op)) return;
    if (error.status === 403 || error.status === 404) {
      clearLibrary(); renderLibraries();
      message('global-message', '当前资料库读取被拒绝或已不存在。已清空本库文档、原文与查询结果，请确认访问权限。', 'error');
      return;
    }
    report('documents-message', error); $('documents-empty').hidden = true;
  } finally { if (activeOperation(op)) { $('refresh-documents').disabled = false; $('load-more-documents').disabled = false; } }
}
async function uploadDocument(event) {
  event.preventDefault(); if (!state.selected || !state.canManage) return;
  const file = $('document-file').files[0]; if (!file) return;
  if (!/\.(md|txt)$/i.test(file.name)) { message('documents-message','仅支持 .md 或 .txt 文件。','error'); return; }
  if (file.size > 10 * 1024 * 1024) { message('documents-message','文件超过 10 MiB 限制。','error'); return; }
  const op = beginOperation('upload'); const form = new FormData(); form.append('file',file);
  $('upload-submit').disabled = true; message('documents-message','正在上传文档…');
  try {
    const data = await request(`${libraryPath()}/upload`,{key:'upload',method:'POST',body:form});
    if (data.staged || data.registrationFailed) throw new ApiError('文件已暂存但登记失败，尚未加入资料库。',0,data);
    if (data.status !== 'success' || !data.document?.file_id) throw new ApiError('后端未确认文档登记成功，请刷新实际文档状态。');
    $('document-file').value = ''; await loadDocuments();
    if (activeOperation(op)) message('documents-message','文档已上传并登记。解析和索引需要分别提交。','success');
  } catch(error) { if(activeOperation(op)) report('documents-message',error); }
  finally { if(activeOperation(op)) $('upload-submit').disabled=false; }
}
async function processDocument(doc, action) {
  if (!state.selected || !state.canManage || state.processing.has(doc.file_id)) return;
  const stamp = snapshot(); const label = action === 'parse' ? '解析' : '索引';
  const pending = {action, phase: 'submitting', initialStatus: doc.status, initialUpdatedAt: doc.updated_at};
  state.processing.set(doc.file_id, pending); renderDocuments();
  message('documents-message',`正在提交${label}任务…`);
  try {
    const data = await request(`${libraryPath()}/documents/${encoded(doc.file_id)}/${action}`, {key:`process:${doc.file_id}`,method:'POST',body:{}});
    if (!current(stamp) || state.processing.get(doc.file_id) !== pending) return;
    if (data.status === 'queued') {
      pending.phase = 'queued';
      message('documents-message',`${label}任务已排队${data.task_id ? `（${text(data.task_id)}）` : ''}，尚未完成。请刷新查看实际处理状态。`,'success');
    } else {
      state.processing.delete(doc.file_id);
      message('documents-message',`服务已响应${label}请求，请刷新查看实际处理状态。`);
    }
  } catch(error) {
    if (current(stamp) && state.processing.get(doc.file_id) === pending) {
      state.processing.delete(doc.file_id); report('documents-message',error);
    }
  } finally { if (current(stamp)) renderDocuments(); }
}
async function deleteDocument(doc) {
  if (!window.confirm(`确认从当前资料库删除“${text(doc.filename) || text(doc.file_id)}”？`)) return;
  const op=beginOperation(`delete:${doc.file_id}`); message('documents-message','正在删除文档…');
  try {
    await request(`${libraryPath()}/documents/${encoded(doc.file_id)}`,{key:`delete:${doc.file_id}`,method:'DELETE'});
    if(!activeOperation(op))return;
    state.processing.delete(doc.file_id);
    beginOperation('query');
    abortWhere((item,key)=>key==='query');
    clearQuery();
    if(state.preview?.file_id===doc.file_id){
      beginOperation('content');
      abortWhere((item,key)=>key==='content');
      clearPreview();
    }
    await loadDocuments();
    if(activeOperation(op))message('documents-message','文档已删除。','success');
  } catch(error){if(activeOperation(op))report('documents-message',error);}
}
async function viewContent(doc, append=false) {
  if(!state.selected)return;
  const op=beginOperation('content');
  if(!append){clearPreview();state.preview={file_id:doc.file_id,filename:doc.filename,offset:0};}
  const preview=state.preview;if(!preview)return;
  showPane('documents');$('document-preview').hidden=false;$('preview-title').textContent=text(preview.filename)||'原文预览';
  $('preview-meta').textContent='正在读取原文…';$('load-more-content').disabled=true;
  try {
    const data=await request(`${libraryPath()}/documents/${encoded(preview.file_id)}/content?offset=${append?preview.offset:0}&limit=200`,{key:'content'});
    if(state.preview!==preview)return;
    if(typeof data.content!=='string')throw new ApiError('原文响应格式无效，未读取到可信的文本窗口。');
    const content=data.content;$('preview-content').textContent=append?`${$('preview-content').textContent}\n${content}`:content;
    preview.offset=Number(data.next_offset)||0;
    $('preview-meta').textContent=`纯文本 · ${data.total_lines!==undefined?`共 ${data.total_lines} 行`:'原文窗口'}${data.end_line!==undefined?` · 已读取至第 ${data.end_line} 行`:''}`;
    $('load-more-content').hidden=data.has_more_after!==true;
  }catch(error){
    if(!activeOperation(op)||error instanceof StaleRequest)return;
    if([403,404].includes(error.status)){
      clearLibrary();renderLibraries();
      message('global-message','原文读取被拒绝或资料已不存在。已清空本库资料，请确认访问权限。','error');
    }else $('preview-meta').textContent=error.message;
  }
  finally{if(activeOperation(op))$('load-more-content').disabled=false;}
}
async function queryLibrary(event) {
  event.preventDefault();if(!state.selected)return;
  const query=$('query-input').value.trim();if(!query)return;
  const op=beginOperation('query');$('query-answer').hidden=true;$('answer-text').textContent='';$('query-sources').replaceChildren();
  $('query-submit').disabled=true;$('cancel-query').hidden=false;message('query-message','正在查询当前资料库…');
  try {
    const data=await request(`${libraryPath()}/query`,{key:'query',method:'POST',body:{query}});
    if(!Array.isArray(data.results))throw new ApiError('查询响应格式无效，不能判断是否存在匹配资料。');
    const results=data.results;
    $('answer-text').textContent=results.length?`找到 ${results.length} 条匹配资料。以下为后端返回的内容与出处。`:'未找到匹配资料。';
    $('source-heading').hidden=!results.length;
    for(const [index,result]of results.entries()){
      const card=document.createElement('article');card.className='source-card';
      const title=document.createElement('strong'),meta=document.createElement('small'),content=document.createElement('p');
      const metadata=result.metadata&&typeof result.metadata==='object'?result.metadata:{};
      title.textContent=`${index+1}. ${text(metadata.filename)||text(metadata.file_name)||text(metadata.title)||text(metadata.source)||text(metadata.source_path)||text(result.file_id)||'未提供文档名称'}`;
      const details=[metadata.source_path?`来源 ${text(metadata.source_path)}`:'',metadata.page!==undefined?`页 ${text(metadata.page)}`:'',metadata.start_line!==undefined?`行 ${text(metadata.start_line)}`:'',result.file_id?`文档 ${text(result.file_id)}`:'',result.id?`结果 ${text(result.id)}`:''].filter(Boolean);
      meta.textContent=details.join(' · ')||'后端未提供更详细的来源信息。';
      content.textContent=text(result.content);card.append(title,meta,content);
      if(result.file_id)card.append(actionButton('查看原文',()=>viewContent({file_id:result.file_id,filename:text(metadata.filename)||text(metadata.file_name)||text(metadata.title)||'查询来源'})));
      $('query-sources').append(card);
    }
    $('query-answer').hidden=false;message('query-message');
  }catch(error){if(activeOperation(op))report('query-message',error);}
  finally{if(activeOperation(op)){$('query-submit').disabled=false;$('cancel-query').hidden=true;}}
}
async function createLibrary(event){
  event.preventDefault();if(!state.canCreate)return;
  const op=beginOperation('create-library',{library:false});const model=$('create-model').value.trim();
  if(!model){message('create-message','请填写 Yuxi 已配置的 embedding_model_spec 模型标识字符串。','error');return;}
  const body={database_name:$('create-name').value.trim(),description:$('create-description').value.trim(),kb_type:$('create-type').value,embedding_model_spec:model};
  $('create-submit').disabled=true;message('create-message','正在创建资料库…');
  try{
    await request('/api/databases',{key:'create-library',method:'POST',body,scope:'account'});
    $('create-dialog').close();$('create-form').reset();const refreshed=await loadLibraries();
    if(activeOperation(op))message('global-message',refreshed?'资料库已创建，列表已刷新。':'资料库已创建，但列表刷新失败。请稍后刷新列表。',refreshed?'success':'warn');
  }catch(error){if(activeOperation(op))report('create-message',error);}
  finally{if(activeOperation(op))$('create-submit').disabled=false;}
}
$('choose-login').addEventListener('click',()=>chooseAuth('login'));
$('choose-key').addEventListener('click',()=>chooseAuth('key'));
$('login-form').addEventListener('submit',event=>void authenticate(event,'login'));
$('key-form').addEventListener('submit',event=>void authenticate(event,'key'));
$('refresh-status').addEventListener('click',()=>void checkStatus());
$('logout').addEventListener('click',()=>{clearAccount();message('global-message','已退出，当前页面的凭据、文档和查询结果已清空。');});
$('refresh-libraries').addEventListener('click',()=>void loadLibraries());
$('show-documents').addEventListener('click',()=>showPane('documents'));
$('show-query').addEventListener('click',()=>showPane('query'));
$('refresh-documents').addEventListener('click',()=>void loadDocuments());
$('load-more-documents').addEventListener('click',()=>void loadDocuments(true));
$('upload-form').addEventListener('submit',event=>void uploadDocument(event));
$('query-form').addEventListener('submit',event=>void queryLibrary(event));
$('cancel-query').addEventListener('click',()=>{beginOperation('query');abortWhere((item,key)=>key==='query');$('query-submit').disabled=false;$('cancel-query').hidden=true;message('query-message','已停止等待本次查询结果。');});
$('close-preview').addEventListener('click',()=>{beginOperation('content');abortWhere((item,key)=>key==='content');clearPreview();});
$('load-more-content').addEventListener('click',()=>void viewContent(state.preview,true));
$('new-library').addEventListener('click',()=>{message('create-message');$('create-dialog').showModal();});
function closeCreate() {
  beginOperation('create-library',{library:false});abortWhere((item,key)=>key==='create-library');
  $('create-dialog').close();$('create-form').reset();$('create-submit').disabled=false;message('create-message');
}
for(const id of ['close-create','cancel-create'])$(id).addEventListener('click',closeCreate);
$('create-dialog').addEventListener('cancel',closeCreate);
$('create-form').addEventListener('submit',event=>void createLibrary(event));
window.addEventListener('pagehide',()=>{clearAccount();});
void checkStatus();
