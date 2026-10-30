import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const args=process.argv.slice(2);
if(args.length&&(args.length!==2||args[0]!=='--function-dir'))throw new Error('Usage: npm run proof:smoke [-- --function-dir FUNCTION_DIRECTORY]');
// Resolve from the isolated function, preventing local dependencies from hiding missing bundle files.
const resolve=createRequire(args.length?path.join(path.resolve(args[1]),'package.json'):import.meta.url);
const load=(name)=>import(pathToFileURL(resolve.resolve(name)).href);
const {createCanvas,DOMMatrix,Path2D,ImageData}=await load('@napi-rs/canvas');
const {default:sharp}=await load('sharp');
Object.assign(globalThis,{DOMMatrix,Path2D,ImageData});
const {getDocument}=await load('pdfjs-dist/legacy/build/pdf.mjs');
// Build a real one-page document; exercise Linux font, canvas, PDF.js and WebP bindings.
const stream='BT /F1 18 Tf 20 350 Td (Tinzel) Tj ET\nq 80 0 0 80 20 200 cm /Im1 Do Q';
const pixels='ff000000ff000000ffffffff>';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`];
let source='%PDF-1.4\n';const offsets=[0];objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${body}\nendobj\n`;});const xref=Buffer.byteLength(source);source+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const task=getDocument({data:new Uint8Array(Buffer.from(source)),useSystemFonts:true,disableFontFace:true});
const pdf=await task.promise;try{const page=await pdf.getPage(1),viewport=page.getViewport({scale:1}),canvas=createCanvas(viewport.width,viewport.height);await page.render({canvasContext:canvas.getContext('2d'),canvas,viewport,recordImages:true}).promise;const bytes=await canvas.encode('webp',85);if((await sharp(bytes).metadata()).format!=='webp')throw new Error('WebP runtime failed');if(!(await page.getTextContent()).items.length||bytes.length<100||!page.imageCoordinates?.length)throw new Error('Renderer smoke failed');console.log(JSON.stringify({event:'proof_renderer_smoke',platform:process.platform,node:process.version,bytes:bytes.length,imageCoordinates:page.imageCoordinates.length}));}finally{await task.destroy();}
