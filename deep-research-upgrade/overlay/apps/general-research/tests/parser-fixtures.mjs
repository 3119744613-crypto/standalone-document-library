import {execFileSync} from 'node:child_process';

export const python = process.env.GENERAL_PYTHON || 'python3';
export function runPython(source, input = Buffer.alloc(0)) {
  return execFileSync(python, ['-I', '-c', source], {input, maxBuffer: 20 * 1024 * 1024, timeout: 10000});
}

export function textPdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageRefs = [];
  for (const text of pages) {
    const id = objects.length + 1;
    pageRefs.push(`${id} 0 R`);
    const stream = text === null ? 'q 100 0 0 100 50 600 cm BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID FF> EI Q' : text ? `BT /F1 12 Tf 50 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET` : 'q Q';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.join(' ')}] >>`;
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

export function textDocx() {
  return runPython(`import io,sys\nfrom docx import Document\nd=Document();d.add_paragraph('First requirement alpha');t=d.add_table(rows=1,cols=2);t.cell(0,0).text='Table beta';t.cell(0,1).text='Table gamma';d.add_paragraph('Final requirement delta');b=io.BytesIO();d.save(b);sys.stdout.buffer.write(b.getvalue())`);
}

export function alteredDocx(bytes, mode) {
  return runPython(`import io,sys,zipfile\nmode=${JSON.stringify(mode)}\nsrc=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));out=io.BytesIO()\nwith zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:\n for item in src.infolist():\n  data=src.read(item.filename)\n  if mode=='entity' and item.filename=='word/document.xml':\n   data=b'<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///unavailable-private-file">]>'+data[data.find(b'<w:document'):]\n  z.writestr(item.filename,data)\n if mode=='bomb':z.writestr('large.xml',b'x'*(17*1024*1024))\n if mode=='traversal':z.writestr('../outside.xml',b'<x/>')\n if mode=='duplicate':z.writestr('word/document.xml',b'<x/>')\nsys.stdout.buffer.write(out.getvalue())`, bytes);
}
