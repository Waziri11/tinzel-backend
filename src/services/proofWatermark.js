import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

const font = GlobalFonts.registerFromPath(fileURLToPath(new URL('../../assets/fonts/NotoSans.ttf', import.meta.url)), 'Tinzel Watermark');
export function watermarkOverlay(width, height, identity) {
  if (!font) throw new Error('Bundled watermark font is unavailable');
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  const lines = String(identity).split(' · ').map(part => part.slice(0, 160));
  const size = Math.max(9, Math.min(18, (width - 40) / (Math.max(...lines.map(l => l.length)) * .65)));
  ctx.font = `${size}px "Tinzel Watermark"`;
  ctx.fillStyle = 'rgba(51,51,51,0.30)';
  for (let y = 45; y < height; y += 200) for (let x = 20; x < width; x += Math.max(300, width / 2))
    lines.forEach((line, i) => ctx.fillText(line, x, y + i * (size + 4)));
  return canvas.toBuffer('image/png');
}
