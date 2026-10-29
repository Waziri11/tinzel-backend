export function proofPdf(pageCount = 2) {
  const stream = 'BT /F1 24 Tf 40 180 Td (Magazine correction text) Tj ET\n0.2 0.5 0.7 rg 40 40 120 80 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${Array.from({length:pageCount-1},(_,i)=>`${i+6} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...Array.from({length:pageCount-1},()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Rotate 90 /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i=0;i<objects.length;i++) { offsets.push(Buffer.byteLength(pdf)); pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start=Buffer.byteLength(pdf); pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf+=offsets.slice(1).map((o)=>`${String(o).padStart(10,'0')} 00000 n \n`).join('');
  pdf+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}
