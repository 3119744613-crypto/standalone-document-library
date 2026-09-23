import React, {useEffect, useMemo, useRef, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Archive, BookOpen, Bot, ChevronRight, Download, LogOut, RefreshCw, Search, ShieldCheck} from 'lucide-react';
import {ErrorBoundary, ToastHost, downloadText, notify, relativeTime} from '../../ux.jsx';
import {readDeepEventStream} from '../deep-thinking/deep-event-stream.js';
import {GeneralClient, StaleRequest, approvalPlan, mergeTask, mergeTaskList, revokeSession, safeSourceUrl, sourceLocator} from './general-state.mjs';
import './general.css';

const e = encodeURIComponent;
const labels = {draft:'草稿', planning:'正在生成计划', awaiting_confirmation:'等待你确认计划', running:'研究中', completed:'已完成', failed:'失败', cancelled:'已取消', interrupted:'运行中断', invalidated:'来源已删除，报告失效', pending:'等待开始', uploaded:'待解析', parsing:'解析中', parsed:'待索引', indexing:'索引中', indexed:'可检索', error_parsing:'解析失败', error_indexing:'索引失败'};
const roles = {planner:'规划 Agent', document_researcher:'资料研究 Agent', web_researcher:'公开资料 Agent', reviewer:'来源核验 Agent', writer:'报告撰写 Agent'};
const errorText = error => error instanceof StaleRequest ? '' : error.message || '操作失败，请重试。';
const listTasks = value => Array.isArray(value) ? value : value.tasks || value.items || [];
const asTask = value => value.task || value;
const modelHost = status => { try { return new URL(status?.research?.baseUrl).hostname; } catch { return '尚未配置'; } };

export default function GeneralWorkbench() {
  const [status, setStatus] = useState(null); const [user, setUser] = useState(null);
  const [error, setError] = useState(''); const [tab, setTab] = useState('research');
  const [libraries, setLibraries] = useState([]); const [kb, setKb] = useState('');
  const client = useMemo(() => new GeneralClient({onExpired: () => { setUser(null); setLibraries([]); setKb(''); setError('登录已失效，本页资料已清空，请重新登录。'); }}), []);
  const check = async () => { try { setStatus(await client.request('/status', {auth:false, key:'status'})); setError(''); } catch (reason) { const text = errorText(reason); if (text) setError(text); } };
  useEffect(() => { void check(); const leave = () => client.setToken(''); window.addEventListener('pagehide', leave); return () => { leave(); window.removeEventListener('pagehide', leave); }; }, []);
  const refreshLibraries = async () => { const data = await client.request('/databases'); setLibraries(data.databases || []); setKb(current => (data.databases || []).some(item => item.kb_id === current) ? current : data.databases?.[0]?.kb_id || ''); };
  const signedIn = async token => { client.setToken(token); const data = await client.request('/me'); setUser(data.user); setStatus(current => ({...current, setupRequired:false})); await refreshLibraries(); };
  const logout = () => revokeSession(client, {onCleared: () => { setUser(null); setLibraries([]); setKb(''); setError(''); }, onFailure: setError});
  return <div className="app-shell general-shell">
    <header className="topbar"><div className="brand-mark"><BookOpen size={22}/></div><div className="brand-copy"><b>通用研究与资料管理</b><span>DEEP RESEARCH WORKBENCH</span></div><div className={`service-state ${status ? 'online' : 'offline'}`}><i/>{status ? '本地服务已连接' : '等待本地服务'}</div><button onClick={check} aria-label="检查服务连接"><RefreshCw size={15}/></button>{user && <button onClick={logout}><LogOut size={15}/>退出</button>}</header>
    <aside className="sidebar"><div className="sidebar-label">功能导航</div><div className="sidebar-nav">{[['research','通用研究',Bot],['library','资料管理',BookOpen]].map(([id,title,Icon]) => <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={19}/><b>{title}</b><ChevronRight size={15}/></button>)}</div><div className="general-side-copy"><b>{user?.name || '本机工作台'}</b><p>先确认计划，再开始研究。资料、任务和报告保存在这台电脑。</p></div><div className="sidebar-note"><ShieldCheck size={17}/><span>独立资料与任务空间<br/>不连接原业务运行流程</span></div></aside>
    <nav className="mobile-nav" aria-label="通用工作台导航"><button onClick={() => setTab('research')}>通用研究</button><button onClick={() => setTab('library')}>资料管理</button></nav>
    <main><header className="page-title"><div><span>RESEARCH · EVIDENCE · REPORT</span><h1>{tab === 'research' ? '从问题到有据可查的结论' : '让每份资料都有出处'}</h1><p>{tab === 'research' ? '选择资料，确认研究计划，查看各 Agent 的真实进度与报告。' : '上传、解析、索引和查阅文档；原始资料保存在本机。'}</p></div></header>
      {error && <p className="general-notice error" role="alert">{error}</p>}
      {!user ? <Login client={client} status={status} signedIn={signedIn}/> : <ErrorBoundary resetKey={tab} fallback={(reason,retry) => <section className="general-card"><h2>页面暂时无法显示</h2><p>本地任务仍可保留。请重试或重新打开页面。</p><button onClick={retry}>重试</button></section>}><div className="general-library-bar"><label>当前资料库<select value={kb} onChange={event => setKb(event.target.value)}><option value="">选择资料库</option>{libraries.map(item => <option value={item.kb_id} key={item.kb_id}>{item.name}</option>)}</select></label><button onClick={() => refreshLibraries().catch(reason => setError(errorText(reason)))}><RefreshCw size={14}/>刷新</button><CreateLibrary client={client} onCreated={async id => { await refreshLibraries(); setKb(id); }}/></div>
        {tab === 'library' ? kb ? <Library key={kb} client={client} kb={kb}/> : <Empty title="先创建一个资料库" text="按用途给资料归类，然后上传需求文档。"/> : <Research client={client} kb={kb} status={status} openLibrary={() => setTab('library')}/>}
      </ErrorBoundary>}
      <footer className="general-footer">通用工作台沿用原项目界面结构；资料管理参考 Yuxi 设计，可独立运行。刷新页面后需重新登录。</footer>
    </main><ToastHost/>
  </div>;
}

function Login({client,status,signedIn}) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const setup = status?.setupRequired;
  const submit = async event => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError('');
    try { const result = await client.request(setup ? '/setup' : '/login', {method:'POST',auth:false,body:{username:data.get('username'),password:data.get('password')},key:'login'}); form.reset(); await signedIn(result.access_token); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <section className="general-card general-login"><div><span className="general-eyebrow">你的本机研究空间</span><h2>{setup ? '创建本机账号' : '登录工作台'}</h2><p>账号只用于此电脑的独立通用模块。模型服务另由本机启动配置提供，不在页面保存密钥。</p></div><form onSubmit={submit}><label>用户名<input name="username" autoComplete="username" required maxLength={80}/></label><label>密码<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 10 : 1} required/></label>{setup && <small>首次设置至少 10 个字符的密码，请妥善记住。</small>}{error && <p role="alert" className="general-notice error">{error}</p>}<button className="primary" disabled={!status || busy}>{busy ? '正在验证…' : setup ? '创建并进入' : '登录'}</button></form></section>;
}
function CreateLibrary({client,onCreated}) {
  const [open,setOpen] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const submit = async event => { event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(''); try { const result = await client.request('/databases',{method:'POST',body:{database_name:data.get('name'),description:data.get('description')}}); await onCreated(result.database.kb_id); setOpen(false); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } };
  return <><button onClick={() => setOpen(value => !value)}>＋ 新建资料库</button>{open && <form className="general-create-library" onSubmit={submit}><label>名称<input name="name" required maxLength={100}/></label><label>说明<input name="description" maxLength={1000}/></label><button className="primary" disabled={busy}>创建</button><button type="button" onClick={() => setOpen(false)}>关闭</button>{error && <p role="alert">{error}</p>}</form>}</>;
}
function Empty({title,text}) { return <section className="general-card general-empty"><Archive size={30}/><h2>{title}</h2><p>{text}</p></section>; }
function Status({value}) { return <span className={`general-status ${value || ''}`}>{labels[value] || value || '待开始'}</span>; }
function Preview({value,onClose,onMore}) {
  return <section className="general-card general-preview"><header><div><h3>{value.title || '原文预览'}</h3><small>{sourceLocator(value)}{value.total_lines ? ` · 共 ${value.total_lines} 行` : ''}</small></div><button onClick={onClose} aria-label="关闭原文预览">关闭</button></header><pre tabIndex={0}>{value.content}</pre>{Boolean(value.warnings?.length) && <p className="general-notice">解析提示：{value.warnings.join("；")}</p>}{value.locators?.length > 1 && <details><summary>本段包含的来源位置</summary><ul>{value.locators.map((locator,index) => <li key={index}>{sourceLocator({locator})}</li>)}</ul></details>}{value.has_more_after && <button onClick={onMore}>继续读取原文</button>}</section>;
}
function SourceCard({source,onPreview}) {
  const url = safeSourceUrl(source.url || source.metadata?.url);
  return <article className="general-source"><b>{source.id && <span className="general-source-id">[{source.id}] </span>}{source.title || source.metadata?.filename || source.filename || '来源文档'}</b><small>{sourceLocator(source)}</small>{source.content && <p>{source.content}</p>}{url ? <a href={url} target="_blank" rel="noreferrer noopener">查看公开来源 ↗</a> : source.file_id && onPreview ? <button onClick={() => onPreview(source)}>查看原文</button> : null}</article>;
}

function Library({client,kb}) {
  const [documents,setDocuments] = useState([]); const [page,setPage] = useState({total:0,has_more:false});
  const [preview,setPreview] = useState(null); const [results,setResults] = useState(null);
  const [busy,setBusy] = useState(''); const [error,setError] = useState(''); const [pending,setPending] = useState({});
  const base = `/databases/${e(kb)}`;
  const load = async (offset = 0) => { const data = await client.request(`${base}/documents?offset=${offset}&limit=100`, {scope:'library',key:'documents'}); setDocuments(current => offset ? [...current,...data.documents] : data.documents); setPage(data); setPending(current => Object.fromEntries(Object.entries(current).filter(([id,stamp]) => data.documents.some(doc => doc.file_id === id && doc.status === stamp.status && doc.updated_at === stamp.updated_at)))); return data; };
  useEffect(() => { void load().catch(reason => setError(errorText(reason))); return () => client.invalidate('library'); }, [kb]);
  useEffect(() => { if (!Object.keys(pending).length && !documents.some(doc => ['parsing','indexing'].includes(doc.status))) return; const timer = setInterval(() => { void load().catch(reason => setError(errorText(reason))); },2000); return () => clearInterval(timer); }, [documents,pending]);
  const action = async (key,work) => { setBusy(key); setError(''); try { await work(); } catch (reason) { const message = errorText(reason); if (message) setError(message); } finally { setBusy(''); } };
  const showPreview = source => action('preview',async () => { const data = await client.request(`${base}/documents/${e(source.file_id)}/content?offset=0&limit=200`,{scope:'library',key:'preview'}); setPreview({...data,title:source.title || source.filename || source.metadata?.filename || '原文预览'}); });
  const morePreview = () => action('preview',async () => { const data = await client.request(`${base}/documents/${e(preview.file_id)}/content?offset=${preview.next_offset}&limit=200`,{scope:'library',key:'preview'}); setPreview(current => ({...data,title:current.title,content:`${current.content}\n${data.content}`})); });
  const upload = event => { event.preventDefault(); const form = event.currentTarget; const file = new FormData(form).get('file'); if (!file?.size) return; if (file.size > 10 * 1024 * 1024) { setError('每份文档不能超过 10 MiB。'); return; } void action('upload',async () => { const body = new FormData(); body.set('file',file); await client.request(`${base}/upload`,{method:'POST',body,scope:'library'}); form.reset(); await load(); notify('上传成功。请继续解析并建立索引。'); }); };
  const process = (doc,step) => action(doc.file_id,async () => { await client.request(`${base}/documents/${e(doc.file_id)}/${step}`,{method:'POST',body:{},scope:'library'}); setPending(current => ({...current,[doc.file_id]:{status:doc.status,updated_at:doc.updated_at}})); await load(); });
  const remove = doc => { if (!window.confirm(`删除“${doc.filename}”？关联的通用研究报告可能失效。`)) return; void action(doc.file_id,async () => { await client.request(`${base}/documents/${e(doc.file_id)}`,{method:'DELETE',scope:'library'}); client.invalidate('library'); setPreview(null); setResults(null); await load(); }); };
  const query = event => { event.preventDefault(); const data = new FormData(event.currentTarget); void action('query',async () => { const value = await client.request(`${base}/query`,{method:'POST',body:{query:data.get('query')},scope:'library',key:'query'}); setResults(value.results || []); }); };
  return <div className="general-stack"><section className="general-card"><header className="general-section-heading"><div><h2>文档</h2><p>{page.total} 份资料 · 支持文本型 PDF、DOCX、Markdown、TXT</p></div><button disabled={Boolean(busy)} onClick={() => action('refresh',load)}><RefreshCw size={14}/>刷新状态</button></header><form className="general-upload" onSubmit={upload}><label>上传文档<input name="file" type="file" accept=".md,.txt,.pdf,.docx" required/></label><span>每份最多 10 MiB；扫描件不支持。上传后依次解析、索引。</span><button disabled={Boolean(busy)} className="primary">{busy === 'upload' ? '上传中…' : '上传'}</button></form>{error && <p role="alert" className="general-notice error">{error}</p>}<div className="general-table-wrap"><table><thead><tr><th>文档名称</th><th>状态</th><th>操作</th></tr></thead><tbody>{documents.map(doc => <tr key={doc.file_id}><td><b>{doc.filename}</b><small>{doc.file_type?.toUpperCase()} · {Math.ceil(doc.file_size / 1024)} KB</small>{doc.error_message && <p className="general-error-text">{doc.error_message}</p>}{Boolean(doc.warnings?.length) && <small>解析提示：{doc.warnings.join("；")}</small>}</td><td><Status value={doc.status}/>{pending[doc.file_id] && <small>已提交，等待状态更新</small>}</td><td><div className="general-actions"><button disabled={Boolean(busy)} onClick={() => showPreview(doc)}>预览</button><button disabled={Boolean(busy) || Boolean(pending[doc.file_id]) || ['parsing','indexing'].includes(doc.status)} onClick={() => process(doc,'parse')}>解析</button><button disabled={Boolean(busy) || Boolean(pending[doc.file_id]) || !['parsed','indexed','error_indexing'].includes(doc.status)} onClick={() => process(doc,'index')}>索引</button><button disabled={Boolean(busy)} onClick={() => remove(doc)}>删除</button></div></td></tr>)}</tbody></table></div>{!documents.length && <p className="general-muted">资料库为空，请上传第一份需求文档。</p>}{page.has_more && <button disabled={Boolean(busy)} onClick={() => action('more',() => load(documents.length))}>加载更多</button>}</section>
    {preview && <Preview value={preview} onClose={() => { client.cancel('preview'); setPreview(null); }} onMore={morePreview}/>}
    <section className="general-card"><h2>关键词检索</h2><p>返回已索引资料的原文片段和定位；此处不生成模型回答。</p><form className="general-search" onSubmit={query}><input name="query" required maxLength={2000} placeholder="输入关键词或原文词句" aria-label="资料检索关键词"/><button disabled={Boolean(busy)}><Search size={15}/>查询</button></form>{results && <p>{results.length ? `找到 ${results.length} 个片段` : '未找到匹配片段。请检查资料是否已索引，或调整关键词。'}</p>}<div className="general-sources">{results?.map((source,index) => <SourceCard key={source.id || index} source={source} onPreview={showPreview}/>)}</div></section>
  </div>;
}

function Research({client,kb,status,openLibrary}) {
  const [tasks,setTasks] = useState([]); const [selected,setSelected] = useState('');
  const [documents,setDocuments] = useState([]); const [files,setFiles] = useState([]);
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const load = async () => { const data = await client.request('/research',{scope:'research',key:'tasks'}); setTasks(current => listTasks(data).map(incoming => mergeTask(current.find(item => item.id === incoming.id),incoming))); };
  useEffect(() => { void load().catch(reason => setError(errorText(reason))); return () => { client.invalidate('research'); client.invalidate('selection'); }; },[]);
  useEffect(() => { client.invalidate('selection'); setFiles([]); setDocuments([]); if (kb) void client.request(`/databases/${e(kb)}/documents?limit=500`,{scope:'selection',key:'selection-documents'}).then(value => setDocuments(value.documents || [])).catch(reason => setError(errorText(reason))); },[kb]);
  const create = async event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError(''); try { const task = asTask(await client.request('/research',{method:'POST',body:{objective:data.get('objective'),kb_id:kb,file_ids:files,max_calls:6},scope:'research'})); await load(); setSelected(task.id); form.reset(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); } };
  const toggle = id => setFiles(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 6 ? [...current,id] : current);
  return <div className="general-stack"><section className="general-config"><Bot size={19}/><div><b>{status?.research?.configured ? `${status.research.model} · ${modelHost(status)}` : '尚未配置研究模型'}</b><p>{status?.research?.configured ? '模型仅接收你确认的任务与必要资料片段；联网只使用确认后的公开检索词。' : '可先整理资料。研究需要在本机启动配置中设置模型地址、模型名称和密钥。'} {!status?.research?.searchConfigured && '公开检索服务未配置，含联网步骤的执行会受阻。'}</p></div></section>
    <div className="general-research-layout"><aside className="general-card general-task-list"><header><h2>研究任务</h2><button onClick={() => load().catch(reason => setError(errorText(reason)))} aria-label="刷新任务"><RefreshCw size={14}/></button></header><button className="primary" onClick={() => setSelected('')}>＋ 新建研究</button>{tasks.map(task => <button key={task.id} className={selected === task.id ? 'selected' : ''} onClick={() => setSelected(task.id)}><b>{task.objective}</b><span><Status value={task.status}/><small>{relativeTime(task.updated_at)}</small></span></button>)}{!tasks.length && <p>还没有任务。上传需求文档后，开始第一次研究。</p>}</aside><div className="general-stack">{error && <p role="alert" className="general-notice error">{error}</p>}{selected ? <TaskDetail key={selected} id={selected} client={client} status={status} changed={updated => setTasks(current => mergeTaskList(current,updated))}/> : <section className="general-card"><h2>创建研究任务</h2><p>先生成计划供你编辑；只有明确确认后，研究 Agent 才开始执行。</p><form onSubmit={create}><label>你想研究什么？<textarea name="objective" required maxLength={6000} rows={5} placeholder="结合我上传的需求文档和公开资料，比较三种开源文档解析方案，生成带来源引用、优缺点和推荐理由的选型报告。"/></label><fieldset><legend>选择作为依据的文档（最多 6 份）</legend>{!kb ? <p>请先选择或创建资料库。</p> : !documents.length ? <p>当前资料库没有文档。</p> : documents.map(doc => <label className="general-checkbox" key={doc.file_id}><input type="checkbox" checked={files.includes(doc.file_id)} disabled={doc.status !== 'indexed' || (!files.includes(doc.file_id) && files.length >= 6)} onChange={() => toggle(doc.file_id)}/><span>{doc.filename} <Status value={doc.status}/></span></label>)}<button type="button" onClick={openLibrary}>管理、解析与索引资料</button></fieldset><p className="general-muted">每次任务最多 6 次模型调用。规划、资料研究、公开资料研究、来源核验和报告撰写分别记录实际进度。</p><button className="primary" disabled={busy || !kb || !files.length}>{busy ? '创建中…' : '创建草稿'}</button></form></section>}</div></div>
  </div>;
}

function TaskDetail({id,client,status,changed}) {
  const [task,setTask] = useState(null); const [error,setError] = useState(''); const [busy,setBusy] = useState('');
  const [stream,setStream] = useState('正在连接'); const [events,setEvents] = useState([]); const [preview,setPreview] = useState(null);
  const [summary,setSummary] = useState(''); const [steps,setSteps] = useState(''); const [queries,setQueries] = useState(''); const [consent,setConsent] = useState(false); const [planConsent,setPlanConsent] = useState(false);
  const planRef = useRef(''); const taskRef = useRef(null); const changedRef = useRef(changed);
  const path = `/research/${e(id)}`;
  const update = value => { const next = asTask(value); const merged = mergeTask(taskRef.current,next); taskRef.current = merged; setTask(merged); };
  const load = async () => { const data = await client.request(path,{scope:'task',key:'task-detail'}); update(data); return asTask(data); };
  useEffect(() => { changedRef.current = changed; },[changed]);
  // Propagate server progress into the sidebar without another API request.
  // A callback ref avoids resubscribing streams or overwriting an edited plan.
  useEffect(() => { if (task) changedRef.current(task); },[task?.id,task?.status,task?.updated_at]);
  useEffect(() => {
    const planKey = `${task?.attempt}:${JSON.stringify(task?.plan)}`;
    if (!task?.plan || planRef.current === planKey) return;
    planRef.current = planKey; setSummary(task.plan.summary || ''); setSteps((task.plan.steps || []).join('\n')); setQueries((task.plan.public_queries || []).join('\n')); setConsent(false);
  },[task?.plan,task?.attempt]);
  useEffect(() => {
    let active = true; let connected = false; let timer; let failures = 0; let cursor = 0; const controller = new AbortController(); const stamp = client.snapshot('task');
    const valid = () => active && client.current(stamp);
    void load().catch(reason => { if (valid()) setError(errorText(reason)); });
    const poll = async () => { if (!valid()) return; try { await load(); if (!connected && ['planning','running'].includes(taskRef.current?.status)) void connect(); } catch (reason) { if (valid()) setError(errorText(reason)); } };
    const connect = async () => {
      if (!valid() || connected) return;
      clearTimeout(timer); connected = true;
      try {
        setStream(failures ? '正在重连' : '正在连接');
        await readDeepEventStream(`/general-api${path}/events?after=${cursor}`,{signal:controller.signal,headers:{Authorization:`Bearer ${client.token}`},fetchImpl: (url,options) => fetch(url,{...options,credentials:'omit',cache:'no-store',redirect:'error'}),onEvent: event => {
          if (!valid()) return;
          const value = JSON.parse(event.data); const seq = Number(value.seq || event.lastEventId || 0);
          if (seq && seq <= cursor) return;
          cursor = Math.max(cursor,seq); failures = 0; setStream('实时更新');
          setEvents(current => [...current,{...value,seq}].slice(-120)); void poll();
        }});
      } catch (reason) {
        if (!valid()) return;
        if (reason.status === 401) { client.setToken(''); client.onExpired(); return; }
        failures += 1; setStream('连接中断，正在恢复；可手动刷新');
      }
      if (valid()) await poll();
      connected = false;
      if (valid() && ['planning','running'].includes(taskRef.current?.status)) timer = setTimeout(connect,Math.min(1000 * 2 ** Math.min(failures,4),15000));
      else if (valid()) setStream('已同步');
    };
    void connect(); const polling = setInterval(poll,5000);
    return () => { active = false; clearTimeout(timer); clearInterval(polling); controller.abort(); client.invalidate('task'); };
  },[id]);
  const act = async (name,body) => { setBusy(name); setError(''); try { update(await client.request(`${path}/${name}`,{method:'POST',body,scope:'task',key:'task-action'})); } catch (reason) { const text = errorText(reason); if (text) setError(text); } finally { setBusy(''); } };
  const showSource = async source => { setError(''); try { const data = await client.request(`/databases/${e(source.kb_id || task.kb_id)}/documents/${e(source.file_id)}/content?offset=0&limit=200`,{scope:'task',key:'source-preview'}); setPreview({...data,title:source.title}); } catch (reason) { setError(errorText(reason)); } };
  const sourceMore = async () => { try { const data = await client.request(`/databases/${e(preview.kb_id || task.kb_id)}/documents/${e(preview.file_id)}/content?offset=${preview.next_offset}&limit=200`,{scope:'task',key:'source-preview'}); setPreview(current => ({...data,title:current.title,content:`${current.content}\n${data.content}`})); } catch (reason) { setError(errorText(reason)); } };
  if (!task) return <section className="general-card"><h2>正在读取任务</h2>{error && <p role="alert">{error}</p>}</section>;
  const canPlan = ['draft','failed','cancelled','interrupted'].includes(task.status);
  return <><section className="general-card"><header className="general-section-heading"><div><h2>{task.objective}</h2><div className="general-actions"><Status value={task.status}/><small>模型调用 {task.calls_used || 0}/{task.max_calls} · {stream}</small></div></div><button onClick={() => load().catch(reason => setError(errorText(reason)))}><RefreshCw size={14}/>刷新</button></header>{(error || task.error) && <p role="alert" className="general-notice error">{error || task.error.message || String(task.error)}</p>}
      {canPlan && <div className="general-plan-start"><p>生成计划会将任务描述与所选文档的必要片段发送给 <b>{modelHost(status)}</b>（{status?.research?.model || '未配置模型'}）。计划生成后将暂停，等待你确认；此按钮本身不会执行完整研究。</p><label className="general-checkbox"><input type="checkbox" checked={planConsent} onChange={event => setPlanConsent(event.target.checked)}/><span>允许发送本次任务和必要资料片段，用于生成研究计划。</span></label><button className="primary" disabled={Boolean(busy) || !planConsent || !status?.research?.configured} onClick={() => act('plan',{allow_external:true})}>{busy === 'plan' ? '提交中…' : task.status === 'draft' ? '生成可编辑研究计划' : '重新生成计划'}</button></div>}
      {task.status === 'awaiting_confirmation' && <form className="general-plan" onSubmit={event => { event.preventDefault(); void act('approve',{plan:approvalPlan(summary,steps,queries),allow_external:consent}); }}><h3>确认研究计划</h3><label>研究理解<textarea value={summary} onChange={event => setSummary(event.target.value)} rows={3} required maxLength={2000}/></label><label>研究步骤（1 至 8 项，每行一项）<textarea value={steps} onChange={event => setSteps(event.target.value)} rows={5} required maxLength={10000}/></label><label>公开检索词（1 至 3 项，每行一项；不要含私密原文）<textarea value={queries} onChange={event => setQueries(event.target.value)} rows={3} required maxLength={1502}/></label><label className="general-checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>我确认以上计划：将任务和必要文档片段发给 {modelHost(status)}，将上方公开检索词发给配置的搜索服务。</span></label><button className="primary" disabled={Boolean(busy) || !consent || !status?.research?.configured || (!status?.research?.searchConfigured && Boolean(queries.trim()))}>确认计划并开始研究</button></form>}
      {['planning','running','awaiting_confirmation'].includes(task.status) && <button disabled={Boolean(busy)} onClick={() => act('cancel',{})}>{busy === 'cancel' ? '正在提交取消…' : '取消此任务'}</button>}
      {task.plan && task.status !== 'awaiting_confirmation' && <details className="general-plan-summary"><summary>查看本次研究计划</summary><p>{task.plan.summary}</p><ol>{task.plan.steps?.map((step,index) => <li key={index}>{step}</li>)}</ol><p>公开检索词：{task.plan.public_queries?.join('；') || '无'}</p></details>}
    </section><section className="general-card"><h2>Agent 执行进度</h2><p className="general-muted">下方状态来自服务端任务记录。无实际执行的步骤保持“等待开始”。</p><div className="general-agents">{(task.agents || []).map(agent => <article key={agent.role}><header><Bot size={16}/><b>{roles[agent.role] || agent.role}</b><Status value={agent.status}/></header>{agent.error && <p className="general-error-text">{typeof agent.error === 'string' ? agent.error : agent.error.message}</p>}{agent.output && <details><summary>查看结果</summary><pre>{typeof agent.output === 'string' ? agent.output : JSON.stringify(agent.output,null,2)}</pre></details>}</article>)}</div><details className="general-events"><summary>执行记录（最近 {events.length} 条）</summary><ul>{events.map((event,index) => <li key={event.seq || index}><time>{new Date(event.created_at).toLocaleTimeString()}</time><span>{roles[event.role] || ''} {event.message || event.type}</span></li>)}</ul></details></section>
    {task.report && task.status !== 'invalidated' && <section className="general-card"><header className="general-section-heading"><div><h2>{task.status === 'completed' ? '研究报告' : '已有报告内容'}</h2><p>引用标记对应下方来源；外部链接仅在已保存的来源卡片中提供。核验失败、资料缺失和不确定性应保留在结论中。</p></div><button onClick={() => downloadText(`研究报告-${task.id}.md`,task.report)}><Download size={15}/>下载 Markdown</button></header><div className="general-report"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{img: () => null, a: ({children}) => <span>{children}</span>}}>{task.report}</ReactMarkdown></div></section>}
    {Boolean(task.sources?.length) && task.status !== 'invalidated' && <section className="general-card"><h2>报告依据</h2><div className="general-sources">{task.sources.map(source => <SourceCard key={source.id} source={source} onPreview={showSource}/>)}</div></section>}{preview && task.status !== 'invalidated' && <Preview value={preview} onClose={() => { client.cancel('source-preview'); setPreview(null); }} onMore={sourceMore}/>}
  </>;
}
