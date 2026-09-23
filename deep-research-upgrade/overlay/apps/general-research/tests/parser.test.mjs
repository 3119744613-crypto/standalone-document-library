import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseDocument, MAX_TEXT_BYTES} from '../lib/parser.mjs';
import {textPdf, textDocx, alteredDocx, runPython, python} from './parser-fixtures.mjs';

test('real PDF extraction keeps page locators and discloses pages without text', async () => {
  const data = await parseDocument('requirements.pdf', textPdf(['First source alpha', '', 'Third source beta']), {python});
  assert.deepEqual(data.units.map(unit => unit.locator), [{kind: 'pdf', page: 1}, {kind: 'pdf', page: 3}]);
  assert.equal(data.content, 'First source alpha\nThird source beta');
  assert.match(data.warnings[0], /第 2 页.*未执行 OCR/);
});

test('real DOCX extraction preserves body/table order and paragraph or cell locators', async () => {
  const data = await parseDocument('requirements.docx', textDocx(), {python});
  assert.deepEqual(data.units.map(unit => unit.content), ['First requirement alpha', 'Table beta', 'Table gamma', 'Final requirement delta']);
  assert.equal(data.units[0].locator.paragraph, 1);
  assert.deepEqual(data.units[1].locator, {kind: 'docx', part: 'word/document.xml', table: 1, row: 1, cell: 1, paragraph: 1});
  assert.equal(data.units[3].locator.paragraph, 2);
  assert.match(data.warnings[0], /不提供页码/);
});

test('empty/image-only PDF, encrypted PDF and excess pages fail explicitly', async () => {
  await assert.rejects(parseDocument('scan.pdf', textPdf(['']), {python}), {code: 'NO_TEXT'});
  await assert.rejects(parseDocument('image.pdf', textPdf([null]), {python}), {code: 'NO_TEXT'});
  await assert.rejects(parseDocument('large.pdf', textPdf(Array.from({length: 201}, () => 'Page')), {python}), {code: 'PAGE_LIMIT'});
  const encrypted = runPython("import io,sys\nfrom pypdf import PdfReader,PdfWriter\nr=PdfReader(io.BytesIO(sys.stdin.buffer.read()));w=PdfWriter();w.append_pages_from_reader(r);w.encrypt('test-fixture-only');o=io.BytesIO();w.write(o);sys.stdout.buffer.write(o.getvalue())", textPdf(['Encrypted source']));
  await assert.rejects(parseDocument('locked.pdf', encrypted, {python}), {code: 'PDF_ENCRYPTED'});
});

test('DOCX rejects compression bombs, traversal, duplicate members and XML entities', async () => {
  const good = textDocx();
  for (const mode of ['bomb', 'traversal', 'duplicate']) await assert.rejects(parseDocument('bad.docx', alteredDocx(good, mode), {python}), {code: 'ZIP_LIMIT'});
  await assert.rejects(parseDocument('entities.docx', alteredDocx(good, 'entity'), {python}), {code: 'XML_UNSAFE'});
});

test('plain UTF-8 text remains Python independent and bounded', async () => {
  const data = await parseDocument('notes.md', Buffer.from('第一行\r\n第二行'), {python: '/definitely/missing/python'});
  assert.equal(data.content, '第一行\n第二行');
  assert.equal(data.units[0].end_line, 2);
  await assert.rejects(parseDocument('bad.txt', Buffer.from([255])), {code: 'INVALID_ENCODING'});
  await assert.rejects(parseDocument('binary.txt', Buffer.from('a\0b')), {code: 'INVALID_TEXT'});
  await assert.rejects(parseDocument('large.txt', Buffer.alloc(MAX_TEXT_BYTES + 1, 'x')), {code: 'TEXT_LIMIT'});
});

test('parser absence is reported with installation instructions', async () => {
  await assert.rejects(parseDocument('x.pdf', textPdf(['x']), {python: '/definitely/missing/python'}), {code: 'PARSER_UNAVAILABLE'});
});

test('missing parser dependencies fail explicitly without reporting a completed parse', () => {
  const path = fileURLToPath(new URL('../scripts/parse-document.py', import.meta.url));
  const result = spawnSync(python, ['-I', '-S', path, 'pdf'], {input: textPdf(['Text source']), timeout: 10000});
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout.toString('utf8'));
  assert.equal(data.error.code, 'PARSER_DEPENDENCY');
  assert.equal(data.units, undefined);
});

test('parser timeout, cancellation and excessive output are bounded', {skip: process.platform === 'win32' ? 'POSIX fake executable; Windows process termination requires platform validation.' : false}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'general-parser-timeout-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const fake = join(dir, 'slow-python');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 10\n', {mode: 0o700});
  await assert.rejects(parseDocument('x.pdf', textPdf(['x']), {python: fake, timeoutMs: 50}), {code: 'PARSE_TIMEOUT'});
  const controller = new AbortController();
  const pending = parseDocument('x.pdf', textPdf(['x']), {python: fake, signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, {code: 'PARSE_CANCELLED'});
  const excessive = join(dir, 'excessive-python');
  writeFileSync(excessive, '#!/bin/sh\nexec head -c 17000000 /dev/zero\n', {mode: 0o700});
  await assert.rejects(parseDocument('x.pdf', textPdf(['x']), {python: excessive}), {code: 'PARSE_OUTPUT_LIMIT'});
});
