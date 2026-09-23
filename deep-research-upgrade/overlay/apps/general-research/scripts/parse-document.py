"""Bounded text-only parser. Reads bytes on stdin and writes one JSON response."""
import io
import json
import posixpath
import sys
import zipfile

MAX_FILE = 10 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
MAX_ZIP_TOTAL = 64 * 1024 * 1024


class ParseFailure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class TextUnits(list):
    byte_count = 0


def fail(code, message):
    raise ParseFailure(code, message)


def checked_text(units, content, locator):
    content = content.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n')
    if '\x00' in content:
        fail('INVALID_FILE', '提取文本含有不支持的二进制内容。')
    if not content.strip():
        return
    units.append({'content': content, 'locator': locator})
    units.byte_count += len(content.encode('utf-8')) + 1
    if len(units) > 20000 or units.byte_count > MAX_TEXT:
        fail('TEXT_LIMIT', '提取文本超过 2 MiB 或段落数量限制，请拆分文件。')


def pdf_document(raw):
    from pypdf import PdfReader, filters
    # pypdf checks decompression limits before allocating unbounded stream output.
    for name in ['MAX_DECLARED_STREAM_LENGTH', 'MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH',
                 'JBIG2_MAX_OUTPUT_LENGTH', 'LZW_MAX_OUTPUT_LENGTH',
                 'RUN_LENGTH_MAX_OUTPUT_LENGTH', 'ZLIB_MAX_OUTPUT_LENGTH']:
        setattr(filters, name, MAX_XML)
    if not raw.startswith(b'%PDF-'):
        fail('INVALID_FILE', 'PDF 文件头无效。')
    reader = PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted:
        fail('PDF_ENCRYPTED', '不支持加密 PDF，请上传已解密的文本型文件。')
    if len(reader.pages) > 200:
        fail('PAGE_LIMIT', 'PDF 超过 200 页限制，请拆分文件。')
    units, warnings = TextUnits(), []
    total_stream = 0
    for index, page in enumerate(reader.pages):
        contents = page.get_contents()
        if contents is not None:
            total_stream += len(contents.get_data())
            if total_stream > MAX_ZIP_TOTAL:
                fail('TEXT_LIMIT', 'PDF 展开内容超过限制，请拆分文件。')
        text = page.extract_text() or ''
        checked_text(units, text, {'kind': 'pdf', 'page': index + 1})
        if not text.strip():
            warnings.append(f'第 {index + 1} 页未提取到文本，可能为空白页或扫描页；未执行 OCR。')
    return {'units': units, 'warnings': warnings}


def docx_document(raw):
    from lxml import etree
    from docx import Document
    if not raw.startswith(b'PK\x03\x04'):
        fail('INVALID_FILE', 'DOCX 文件头无效。')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000:
            fail('ZIP_LIMIT', 'DOCX 压缩包文件数量超过限制。')
        names, expanded = set(), 0
        xml_files = {}
        for member in entries:
            name = member.filename
            if name in names or '\\' in name or name.startswith('/') or ':' in name or posixpath.normpath(name).startswith('../') or '..' in name.split('/'):
                fail('ZIP_LIMIT', 'DOCX 包内文件名无效或重复。')
            names.add(name)
            expanded += member.file_size
            if member.flag_bits & 1 or member.file_size > MAX_XML or expanded > MAX_ZIP_TOTAL or member.file_size > max(1, member.compress_size) * 200:
                fail('ZIP_LIMIT', 'DOCX 压缩包超过安全展开限制或已加密。')
            if 'vbaproject' in name.lower() or name.lower().endswith('.bin'):
                fail('UNSUPPORTED_DOCX', '不支持含宏或内嵌可执行内容的 DOCX。')
            # Preflight every XML file because python-docx opens the OPC package.
            if name.endswith(('.xml', '.rels')):
                with archive.open(member) as stream:
                    content = stream.read(MAX_XML + 1)
                if len(content) > MAX_XML:
                    fail('ZIP_LIMIT', 'DOCX XML 内容超过限制。')
                parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False, recover=False)
                document = etree.fromstring(content, parser=parser)
                if document.getroottree().docinfo.doctype or any(isinstance(node, etree._Entity) for node in document.iter()):
                    fail('XML_UNSAFE', 'DOCX 不允许包含 DTD 或实体声明。')
                xml_files[name] = document
        if '[Content_Types].xml' not in xml_files or 'word/document.xml' not in xml_files:
            fail('INVALID_FILE', 'DOCX 缺少必要正文文件。')
        content_types = xml_files['[Content_Types].xml']
        main_types = [node.get('ContentType', '') for node in content_types if node.get('PartName') == '/word/document.xml']
        if main_types != ['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']:
            fail('UNSUPPORTED_DOCX', '只支持普通 DOCX 文本，不支持宏文档或模板。')
    document = Document(io.BytesIO(raw))
    units, warnings = TextUnits(), []
    paragraphs, tables = 0, 0
    for block in document.iter_inner_content():
        if hasattr(block, 'text'):
            paragraphs += 1
            checked_text(units, block.text, {'kind': 'docx', 'part': 'word/document.xml', 'paragraph': paragraphs})
        else:
            tables += 1
            seen = set()
            for row_index, row in enumerate(block.rows):
                for column_index, cell in enumerate(row.cells):
                    if cell._tc in seen:
                        continue
                    seen.add(cell._tc)
                    for paragraph_index, paragraph in enumerate(cell.paragraphs):
                        checked_text(units, paragraph.text, {'kind': 'docx', 'part': 'word/document.xml', 'table': tables, 'row': row_index + 1, 'cell': column_index + 1, 'paragraph': paragraph_index + 1})
    body = xml_files['word/document.xml']
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    if body.xpath('.//w:ins|.//w:del|.//w:txbxContent|.//w:tbl/w:tr/w:tc/w:tbl', namespaces=ns):
        warnings.append('正文含修订、文本框或嵌套表格，首版提取可能不完整；请确认预览或上传无修订的简化文档。')
    warnings.append('DOCX 按正文段落和表格定位；页眉、页脚、批注和图片未提取，不提供页码。')
    return {'units': units, 'warnings': warnings}


def main():
    if sys.version_info < (3, 11):
        fail('PYTHON_VERSION', 'PDF/DOCX 解析需要 Python 3.11 或更新版本。')
    raw = sys.stdin.buffer.read(MAX_FILE + 1)
    if len(raw) > MAX_FILE:
        fail('INVALID_FILE', '文件超过 10 MiB 限制。')
    kind = sys.argv[1] if len(sys.argv) == 2 else ''
    if kind not in ('pdf', 'docx'):
        fail('INVALID_FILE', '不支持的文件格式。')
    result = pdf_document(raw) if kind == 'pdf' else docx_document(raw)
    if not result['units']:
        fail('NO_TEXT', '文件中未提取到文本；扫描件和图片暂不支持 OCR。')
    return result


if __name__ == '__main__':
    try:
        result = main()
    except ParseFailure as error:
        result = {'error': {'code': error.code, 'message': error.message}}
    except ImportError:
        result = {'error': {'code': 'PARSER_DEPENDENCY', 'message': '缺少 PDF/DOCX 解析依赖，请安装 requirements-parser.txt 中的固定版本。'}}
    except Exception:
        result = {'error': {'code': 'INVALID_FILE', 'message': '文件损坏、格式不支持或解析资源超出限制。'}}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    sys.exit(1 if 'error' in result else 0)
