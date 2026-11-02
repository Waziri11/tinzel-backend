import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { recognizePage } from '../src/services/proofOcrService.js';
import { watermarkOverlay } from '../src/services/proofWatermark.js';

// Real recognition exercises the bundled WASM, English/Swahili models, and font.
// It is deliberately independent of databases, credentials and network access.
const canvas = createCanvas(1800, 2400), ctx = canvas.getContext('2d');
ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = '#222'; ctx.font = '38px "Tinzel Watermark"';
const english = ['Magazine story in print', 'Birthday memories and family', 'A beautiful day with friends'];
const swahili = ['Karibu kwenye jarida letu', 'Habari za familia na marafiki', 'Siku nzuri ya kukumbuka'];
for (let row = 0; row < 12; row++) {
  ctx.fillText(english[row % 3], 80, 150 + row * 165);
  ctx.fillText(swahili[row % 3], 940, 150 + row * 165);
}
const words = await recognizePage(await canvas.encode('png'), canvas.width, canvas.height, AbortSignal.timeout(40000));
assert.ok(words.some(w => w.str === 'Magazine'));
assert.ok(words.some(w => w.str === 'Karibu'));
assert.ok(words.every(w => w.x >= 0 && w.y >= 0 && w.x + w.width <= 1 && w.y + w.height <= 1));
assert.notDeepEqual(watermarkOverlay(600, 800, 'Hassan · TNZ-123'), watermarkOverlay(600, 800, 'WWWWWW · TNZ-123'));
console.log(JSON.stringify({ event: 'proof_ocr_smoke', platform: process.platform, arch: process.arch, words: words.length, dimensions: [canvas.width, canvas.height] }));
