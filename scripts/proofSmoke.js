import { createCanvas, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
import sharp from 'sharp';
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
// Build a real one-page document; exercise Linux font, canvas, PDF.js and WebP bindings.
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>','<< /Length 37 >>\nstream\nBT /F1 18 Tf 20 350 Td (Tinzel) Tj ET\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let source='%PDF-1.4\n';const offsets=[0];objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${body}\nendobj\n`;});const xref=Buffer.byteLength(source);source+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const task=getDocument({data:new Uint8Array(Buffer.from(source)),useSystemFonts:true,disableFontFace:true});
const pdf=await task.promise;try{const page=await pdf.getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(viewport.width,viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const bytes=await canvas.encode('webp',85);if((await sharp(bytes).metadata()).format!=='webp')throw new Error('WebP runtime failed');if(!(await page.getTextContent()).items.length||bytes.length<100)throw new Error('Renderer smoke failed');console.log(JSON.stringify({event:'proof_renderer_smoke',platform:process.platform,node:process.version,bytes:bytes.length}));}finally{await task.destroy();}
