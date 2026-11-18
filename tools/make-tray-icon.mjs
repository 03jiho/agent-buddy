// assets/tray.png (32x32) 를 외부 의존성 없이 생성한다. 트레이 아이콘 용도.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const W = 32, H = 32;
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const dx = x - 15.5, dy = y - 17;
    const inBody = dx * dx / 196 + dy * dy / 225 <= 1 && y >= 4; // 둥근 몸
    const eye = (Math.abs(x - 11) < 2 && Math.abs(y - 14) < 2) || (Math.abs(x - 20) < 2 && Math.abs(y - 14) < 2);
    const i = y * (W * 4 + 1) + 1 + x * 4;
    if (inBody) {
      const c = eye ? [36, 66, 74] : [110, 193, 180];
      raw.set([...c, 255], i);
    } else raw.set([0, 0, 0, 0], i);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
