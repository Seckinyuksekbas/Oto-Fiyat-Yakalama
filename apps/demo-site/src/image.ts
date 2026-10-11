import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** /img/:id.jpg için kabul edilen ilan kimliği biçimi. */
export const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const WIDTH = 64;
const HEIGHT = 48;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Kimlikten türetilen deterministik, bağımlılıksız küçük PNG (64x48, iki renkli yatay gradyan bandı).
 * Aynı kimlik her zaman aynı baytları üretir; gerçek fotoğraf değildir.
 */
export function listingImagePng(id: string): Buffer {
  const h = createHash('sha256').update(id).digest();
  const top = [h[0]!, h[1]!, h[2]!];
  const bottom = [h[3]!, h[4]!, h[5]!];
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (1 + WIDTH * 3);
    raw[row] = 0; // filtre: yok
    const t = y / (HEIGHT - 1);
    for (let x = 0; x < WIDTH; x++) {
      const o = row + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(top[c]! * (1 - t) + bottom[c]! * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit derinliği
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
