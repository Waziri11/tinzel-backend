import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProofText, recognizePage } from '../src/services/proofOcrService.js';
import { watermarkOverlay } from '../src/services/proofWatermark.js';
import { createCanvas } from '@napi-rs/canvas';

test('mixed pages preserve native text, discard unusable mappings, and deduplicate OCR over rotated runs', () => {
  const native = [{ str: 'Native', x: .1, y: .1, width: .4, height: .1 }, { str: 'Rotated', x: .8, y: .2, width: .2, height: .1, angle: 90 }, { str: '\uFFFD', x: .1, y: .8, width: .4, height: .1 }];
  const recognized = [{ str: 'Duplicate', x: .2, y: .1, width: .1, height: .1 }, { str: 'Rotated duplicate', x: .7, y: .3, width: .1, height: .05 }, { str: 'Scanned', x: .1, y: .8, width: .4, height: .1 }];
  assert.deepEqual(mergeProofText(native, recognized, 1000, 1000).map(t => t.str), ['Native', 'Rotated', 'Scanned']);
});
test('OCR supports empty pages and cancellation without leaving a worker running', async () => {
  const controller = new AbortController(); controller.abort(new Error('Cancelled test'));
  await assert.rejects(recognizePage(Buffer.from('unused'), 1, 1, controller.signal), /Cancelled test/);
  const canvas = createCanvas(400, 300), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 300);
  assert.deepEqual(await recognizePage(await canvas.encode('png'), 400, 300), []);
});
test('bundled watermark draws distinct readable letter shapes without system fonts', () => {
  const a = watermarkOverlay(600, 800, 'Hassan · TNZ-2026 · v1');
  const b = watermarkOverlay(600, 800, 'WWWWWW · TNZ-2026 · v1');
  assert.ok(a.length > 1000); assert.notDeepEqual(a, b);
});
