import * as NodeZlib from "node:zlib";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** The sidecar's 32-bit top-down BMP (BGRA) as an RGB PNG. Level 1 deflate: a window picture should cost milliseconds. */
export const bmpToPng = (bmp: Buffer): Buffer => {
  const offset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const height = Math.abs(bmp.readInt32LE(22));
  if (bmp.readUInt16LE(28) !== 32) throw new Error("Expected a 32-bit picture.");
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    let o = y * (1 + width * 3);
    rows[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = offset + (y * width + x) * 4;
      rows[o++] = bmp[p + 2]!;
      rows[o++] = bmp[p + 1]!;
      rows[o++] = bmp[p]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
