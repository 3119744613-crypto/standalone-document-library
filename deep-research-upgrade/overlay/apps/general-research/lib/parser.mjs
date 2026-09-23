import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LibraryError, MAX_FILE_BYTES} from './common.mjs';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const parserPath = fileURLToPath(new URL('../scripts/parse-document.py', import.meta.url));
const error = (code, message) => new LibraryError(400, code, message);

function normalizedResult(data) {
  if (!data || !Array.isArray(data.units) || !data.units.length || data.units.length > 20000) throw error('INVALID_PARSE_RESULT', '解析器未返回有效文本。');
  let size = 0, nextLine = 1;
  const units = data.units.map(unit => {
    if (typeof unit.content !== 'string' || !unit.locator || !['text', 'pdf', 'docx'].includes(unit.locator.kind)) throw error('INVALID_PARSE_RESULT', '解析器返回的来源位置无效。');
    const content = unit.content.replace(/\r\n?/g, '\n');
    if (content.includes('\0')) throw error('INVALID_TEXT', '文件含有不支持的二进制内容。');
    size += Buffer.byteLength(content, 'utf8') + 1;
    if (size > MAX_TEXT_BYTES) throw error('TEXT_LIMIT', '提取文本超过 2 MiB 限制，请拆分文件。');
    const start_line = nextLine, end_line = nextLine + content.split('\n').length - 1;
    nextLine = end_line + 1;
    return {content, locator: unit.locator, start_line, end_line};
  });
  if (!units.some(unit => unit.content.trim())) throw error('NO_TEXT', '文件中未提取到文本；扫描件和图片暂不支持 OCR。');
  return {content: units.map(unit => unit.content).join('\n'), units, warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 200).map(String) : []};
}

export async function parseDocument(filename, raw, {signal, python = process.env.GENERAL_PYTHON || 'python3', timeoutMs = 20000} = {}) {
  const bytes = Buffer.from(raw);
  if (signal?.aborted) throw error('PARSE_CANCELLED', '解析已取消。');
  if (bytes.length > MAX_FILE_BYTES) throw error('FILE_TOO_LARGE', '文件超过 10 MiB 限制。');
  const type = filename.split('.').at(-1).toLowerCase();
  if (['md', 'txt'].includes(type)) {
    let content;
    try { content = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch { throw error('INVALID_ENCODING', '请上传 UTF-8 编码的 Markdown 或 TXT 文件。'); }
    return normalizedResult({units: [{content, locator: {kind: 'text'}}]});
  }
  if (!['pdf', 'docx'].includes(type)) throw error('UNSUPPORTED_FILE', '只支持 PDF、DOCX、Markdown 或 TXT 文档。');
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, outputSize = 0;
    const output = [];
    const finish = (cause, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (cause) { child?.kill('SIGKILL'); reject(cause); } else resolve(result);
    };
    const cancel = () => finish(error('PARSE_CANCELLED', '解析已取消。'));
    try { child = spawn(python, ['-I', parserPath, type], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true}); }
    catch { finish(error('PARSER_UNAVAILABLE', '无法启动 Python 解析器；请安装 Python 3.11+ 与 requirements-parser.txt 中的依赖。')); return; }
    timer = setTimeout(() => finish(error('PARSE_TIMEOUT', '解析超过 20 秒限制，请拆分或检查文件后重试。')), timeoutMs);
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) { cancel(); return; }
    child.on('error', () => finish(error('PARSER_UNAVAILABLE', '无法启动 Python 解析器；请安装 Python 3.11+ 与 requirements-parser.txt 中的依赖。')));
    child.stdin.on('error', () => {}); // A rejected file may close stdin before all bytes have been sent.
    child.stderr.resume(); // Never relay document content, paths or a Python traceback to clients.
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT_BYTES) finish(error('PARSE_OUTPUT_LIMIT', '解析输出超过限制，请拆分文件。'));
      else output.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const data = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (data.error) {
          const allowed = new Set(['PYTHON_VERSION', 'PARSER_DEPENDENCY', 'INVALID_FILE', 'PDF_ENCRYPTED', 'PAGE_LIMIT', 'TEXT_LIMIT', 'NO_TEXT', 'ZIP_LIMIT', 'UNSUPPORTED_DOCX', 'XML_UNSAFE']);
          if (!allowed.has(data.error.code) || typeof data.error.message !== 'string') throw new Error('Invalid error');
          finish(error(data.error.code, data.error.message)); return;
        }
        if (code !== 0) throw new Error('Parser exited unsuccessfully');
        finish(null, normalizedResult(data));
      } catch (cause) { finish(cause instanceof LibraryError ? cause : error('PARSE_FAILED', '文件解析失败，请检查文件是否损坏或超出资源限制。')); }
    });
    child.stdin.end(bytes);
  });
}
