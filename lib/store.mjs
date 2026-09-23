import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, chmodSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {LibraryError, textField, MAX_FILE_BYTES} from './common.mjs';

const deriveKey = promisify(scrypt);
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const SESSION_MS = 12 * 60 * 60 * 1000;
const missing = () => new LibraryError(404, 'NOT_FOUND', '资料不存在。');
const conflict = message => new LibraryError(409, 'STATE_CONFLICT', message);

function lockDirectory(directory) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const path = resolve(directory, 'server.lock');
  const claim = {pid: process.pid, nonce: randomUUID()};
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(claim)); } finally { closeSync(fd); }
    return () => {
      try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === claim.nonce) unlinkSync(path); } catch {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Data directory has an unreadable server.lock; verify no server is running before removing it.'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid data directory lock.');
    try { process.kill(previous.pid, 0); }
    catch (cause) {
      if (cause.code === 'ESRCH') throw new Error('A previous server left server.lock. After verifying no server is running, remove server.lock and restart.');
      throw new Error('Cannot verify whether the data directory is in use.');
    }
    throw new Error('Data directory is already in use by a running server.');
  }
}

function passwordInput(data) {
  const username = textField(data.username, '用户名', {max: 100});
  if (typeof data.password !== 'string' || data.password.length < 10 || data.password.length > 2048) throw new LibraryError(400, 'INVALID_PASSWORD', '密码应为 10 至 2048 个字符。');
  return {username, password: data.password};
}
function decode(bytes) {
  let value;
  try { value = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new LibraryError(400, 'INVALID_ENCODING', '请上传 UTF-8 编码的 Markdown 或 TXT 文件。'); }
  if (value.includes('\0')) throw new LibraryError(400, 'INVALID_TEXT', '文件含有不支持的二进制内容。');
  return value.replace(/\r\n?/g, '\n');
}
function documentView(row) {
  return {file_id: row.id, filename: row.filename, status: row.status, file_type: row.filename.split('.').at(-1).toLowerCase(), file_size: row.byte_size, size: row.byte_size, created_at: row.created_at, updated_at: row.updated_at, error_message: row.error_message || ''};
}
function databaseView(row) {
  return {kb_id: row.id, name: row.name, description: row.description, kb_type: 'local', supports_documents: true, can_manage: true};
}
function chunksFor(content) {
  const chunks = [];
  const lines = content.split('\n');
  let current = '', start = 1, end = 1, count = 0;
  const flush = () => { if (current.trim()) chunks.push({content: current, start_line: start, end_line: end}); current = ''; count = 0; };
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].match(/[\s\S]{1,4000}/gu) || [''];
    for (const part of parts) {
      if (current && (current.length + part.length + 1 > 4000 || count >= 40)) flush();
      if (!current) start = i + 1;
      current += (current ? '\n' : '') + part;
      end = i + 1;
      count++;
      if (part.length >= 4000) flush();
    }
  }
  flush();
  return chunks;
}

export class LibraryStore {
  constructor(dataDir) {
    this.closed = false;
    this.timers = new Set();
    this.loginFailures = [];
    this.releaseLock = lockDirectory(resolve(dataDir));
    const databasePath = resolve(dataDir, 'library.sqlite');
    try {
      this.db = new DatabaseSync(databasePath);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('The data directory uses a newer unsupported schema. Use the application version that created it.');
      chmodSync(databasePath, 0o600);
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
          filename TEXT NOT NULL, byte_size INTEGER NOT NULL, content_hash TEXT NOT NULL, raw BLOB NOT NULL, content TEXT,
          status TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(library_id, content_hash));
        CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL, searchable TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS chunk_document ON chunks(document_id);
        CREATE INDEX IF NOT EXISTS document_library ON documents(library_id);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          operation TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.transaction(() => {
        this.db.prepare("UPDATE documents SET status=CASE status WHEN 'parsing' THEN 'error_parsing' ELSE 'error_indexing' END, error_message=?, updated_at=? WHERE status IN ('parsing','indexing')").run('上次服务停止时任务未完成，请重新提交。', now());
        this.db.prepare("UPDATE jobs SET status='interrupted' WHERE status='queued'").run();
        this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      });
      for (const suffix of ['-wal', '-shm']) if (existsSync(databasePath + suffix)) chmodSync(databasePath + suffix, 0o600);
    } catch (error) { this.db?.close(); this.releaseLock(); throw error; }
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setupRequired() { return !this.db.prepare('SELECT id FROM owner').get(); }
  issueSession() {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(tokenHash(token), Date.now() + SESSION_MS);
    return {access_token: token, token_type: 'bearer', expires_in: SESSION_MS / 1000};
  }
  async setup(data) {
    if (!this.setupRequired()) throw conflict('本地账号已初始化，请登录。');
    if (this.settingUp) throw conflict('账号正在初始化，请稍后重试。');
    const {username, password} = passwordInput(data);
    this.settingUp = true;
    try {
      const salt = randomBytes(32).toString('hex');
      const passwordHash = (await deriveKey(password, salt, 64)).toString('hex');
      return this.transaction(() => {
        if (!this.setupRequired()) throw conflict('本地账号已初始化，请登录。');
        this.db.prepare('INSERT INTO owner VALUES (1,?,?,?)').run(username, salt, passwordHash);
        return this.issueSession();
      });
    } finally { this.settingUp = false; }
  }
  async login(data) {
    this.loginFailures = this.loginFailures.filter(attempt => attempt.time > Date.now() - 60000);
    if (this.loginFailures.length >= 10) throw new LibraryError(429, 'LOGIN_LIMIT', '登录尝试过多，请一分钟后重试。');
    // Count pending attempts too, so concurrent requests cannot bypass the limit.
    const attempt = {time: Date.now()}; this.loginFailures.push(attempt);
    const username = textField(data.username, '用户名', {max: 100});
    if (typeof data.password !== 'string' || !data.password || data.password.length > 2048) throw new LibraryError(400, 'INVALID_PASSWORD', '密码格式或长度无效。');
    const owner = this.db.prepare('SELECT * FROM owner').get();
    const actual = await deriveKey(data.password, owner?.salt || 'uninitialized-local-library', 64);
    if (!owner || username !== owner.username || !timingSafeEqual(actual, Buffer.from(owner.password_hash, 'hex'))) throw new LibraryError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
    this.loginFailures = this.loginFailures.filter(pending => pending !== attempt);
    return this.issueSession();
  }
  authenticate(token) {
    const session = this.db.prepare('SELECT expires FROM sessions WHERE token_hash=?').get(tokenHash(token));
    if (!session || session.expires <= Date.now()) throw new LibraryError(401, 'AUTH_REQUIRED', '请登录本地资料库。');
    const owner = this.db.prepare('SELECT username FROM owner').get();
    return {id: 'local-owner', username: owner.username, name: owner.username, role: 'owner'};
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); }
  library(id) {
    const row = this.db.prepare('SELECT * FROM libraries WHERE id=?').get(id);
    if (!row) throw missing();
    return row;
  }
  document(libraryId, id) {
    this.library(libraryId);
    const row = this.db.prepare('SELECT * FROM documents WHERE id=? AND library_id=?').get(id, libraryId);
    if (!row) throw missing();
    return row;
  }
  listLibraries() { return {databases: this.db.prepare('SELECT * FROM libraries ORDER BY created_at,id').all().map(databaseView), canCreate: true}; }
  createLibrary(data) {
    const row = {id: randomUUID(), name: textField(data.database_name, '资料库名称', {max: 100}), description: textField(data.description ?? '', '说明', {max: 1000, empty: true})};
    this.db.prepare('INSERT INTO libraries VALUES (?,?,?,?)').run(row.id, row.name, row.description, now());
    return {database: databaseView(row)};
  }
  listDocuments(libraryId, offset, limit) {
    this.library(libraryId);
    const total = this.db.prepare('SELECT count(*) AS n FROM documents WHERE library_id=?').get(libraryId).n;
    const documents = this.db.prepare('SELECT id,filename,status,byte_size,created_at,updated_at,error_message FROM documents WHERE library_id=? ORDER BY created_at,id LIMIT ? OFFSET ?').all(libraryId, limit, offset).map(documentView);
    return {documents, total, offset, limit, has_more: offset + documents.length < total, canManage: true};
  }
  upload(libraryId, filename, bytes) {
    this.library(libraryId);
    if (bytes.length > MAX_FILE_BYTES) throw new LibraryError(413, 'FILE_TOO_LARGE', '文件超过 10 MiB 限制。');
    const hash = tokenHash(bytes);
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM documents WHERE library_id=? AND content_hash=?').get(libraryId, hash)) throw new LibraryError(409, 'DUPLICATE_DOCUMENT', '此资料库已存在内容相同的文档。');
      const hasSameName = Boolean(this.db.prepare('SELECT id FROM documents WHERE library_id=? AND filename=?').get(libraryId, filename));
      const id = randomUUID(), timestamp = now();
      this.db.prepare('INSERT INTO documents (id,library_id,filename,byte_size,content_hash,raw,status,created_at,updated_at) VALUES (?,?,?,?,?,?,\'uploaded\',?,?)').run(id, libraryId, filename, bytes.length, hash, bytes, timestamp, timestamp);
      return {status: 'success', document: documentView(this.document(libraryId, id)), hasSameName};
    });
  }
  basic(libraryId, id) { return {meta: documentView(this.document(libraryId, id))}; }
  content(libraryId, id, offset, limit) {
    const row = this.document(libraryId, id);
    if (row.content == null) throw conflict('文档尚未解析，请先解析后预览。');
    const lines = row.content.split('\n');
    const page = lines.slice(offset, offset + limit);
    return {kb_id: libraryId, file_id: id, content: page.join('\n'), start_line: page.length ? offset + 1 : 0, end_line: page.length ? offset + page.length : 0, total_lines: lines.length, offset, window_size: page.length, has_more_before: offset > 0, has_more_after: offset + page.length < lines.length, next_offset: offset + page.length};
  }
  queue(libraryId, id, operation) {
    const row = this.document(libraryId, id);
    const valid = operation === 'parse' ? ['uploaded', 'error_parsing'] : ['parsed', 'error_indexing'];
    if (!valid.includes(row.status)) throw conflict(operation === 'parse' ? '当前文档状态不能提交解析。' : '请等待解析完成后再提交索引。');
    const jobId = randomUUID();
    this.transaction(() => {
      this.db.prepare('UPDATE documents SET status=?,error_message=NULL,updated_at=? WHERE id=?').run(operation === 'parse' ? 'parsing' : 'indexing', now(), id);
      this.db.prepare("INSERT INTO jobs VALUES (?,?,?,'queued',?)").run(jobId, id, operation, now());
    });
    const timer = setTimeout(() => { this.timers.delete(timer); this.performJob(jobId); }, 25);
    this.timers.add(timer);
    return {status: 'queued', task_id: jobId};
  }
  performJob(jobId) {
    if (this.closed) return;
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=? AND status='queued'").get(jobId);
    if (!job) return;
    try {
      const document = this.db.prepare('SELECT * FROM documents WHERE id=?').get(job.document_id);
      if (!document) return;
      const content = job.operation === 'parse' ? decode(document.raw) : document.content;
      if (content == null) throw new Error('Content unavailable');
      const chunks = job.operation === 'index' ? chunksFor(content) : null;
      this.transaction(() => {
        if (chunks) {
          this.db.prepare('DELETE FROM chunks WHERE document_id=?').run(document.id);
          const insert = this.db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?)');
          for (const chunk of chunks) insert.run(randomUUID(), document.id, chunk.content, chunk.content.toLowerCase(), chunk.start_line, chunk.end_line);
        }
        this.db.prepare('UPDATE documents SET content=?,status=?,error_message=NULL,updated_at=? WHERE id=?').run(content, job.operation === 'parse' ? 'parsed' : 'indexed', now(), document.id);
        this.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(jobId);
      });
    } catch (error) {
      try {
        this.transaction(() => {
          this.db.prepare('UPDATE documents SET status=?,error_message=?,updated_at=? WHERE id=?').run(job.operation === 'parse' ? 'error_parsing' : 'error_indexing', error instanceof LibraryError ? error.message : '处理未完成，请重新提交；若持续失败，请检查可用磁盘空间。', now(), job.document_id);
          this.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobId);
        });
      } catch { console.error('Could not persist document task failure. Restart to recover interrupted tasks.'); }
    }
  }
  deleteDocument(libraryId, id) {
    this.document(libraryId, id);
    this.db.prepare('DELETE FROM documents WHERE id=? AND library_id=?').run(id, libraryId);
    return {status: 'success', physicalDeletionVerified: false};
  }
  query(libraryId, value) {
    this.library(libraryId);
    const query = textField(value, '查询内容', {max: 2000});
    const terms = [...new Set(query.toLowerCase().split(/\s+/u))];
    if (terms.length > 16) throw new LibraryError(400, 'QUERY_TOO_COMPLEX', '一次查询最多包含 16 个空格分隔的关键词。');
    const rows = this.db.prepare(`SELECT c.id,c.content,c.start_line,c.end_line,d.id AS file_id,d.filename FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.library_id=? AND d.status='indexed' AND ${terms.map(() => 'instr(c.searchable,?)>0').join(' AND ')} ORDER BY d.created_at,d.id,c.start_line,c.id LIMIT 20`).all(libraryId, ...terms);
    return {results: rows.map(row => ({id: row.id, kb_id: libraryId, file_id: row.file_id, content: row.content, metadata: {filename: row.filename, start_line: row.start_line, end_line: row.end_line}})), searchMode: 'keyword'};
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { this.db.close(); this.releaseLock(); }
  }
}
