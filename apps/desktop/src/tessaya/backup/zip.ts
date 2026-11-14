/** A small zip writer and reader (stored or deflated entries, no zip64, no encryption): enough for our own backups. */
import * as NodeZlib from "node:zlib";

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of data) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export const makeZip = (entries: ReadonlyArray<ZipEntry>): Buffer => {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, e.data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(e.data.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + e.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
};

export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_BYTES = 200 * 1024 * 1024;

/** Entries of a zip, or an Error naming what is wrong. Checks every CRC and caps the size. */
export const readZip = (zip: Buffer): ReadonlyArray<ZipEntry> | Error => {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return new Error("That is not a zip file.");
  const count = zip.readUInt16LE(end + 10);
  if (count > ZIP_MAX_ENTRIES) return new Error("That zip has too many files.");
  let at = zip.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  let total = 0;
  try {
    for (let n = 0; n < count; n += 1) {
      if (zip.readUInt32LE(at) !== 0x02014b50) return new Error("The zip is damaged.");
      const method = zip.readUInt16LE(at + 10);
      const crc = zip.readUInt32LE(at + 16);
      const size = zip.readUInt32LE(at + 24);
      const nameLen = zip.readUInt16LE(at + 28);
      const extra = zip.readUInt16LE(at + 30);
      const comment = zip.readUInt16LE(at + 32);
      const local = zip.readUInt32LE(at + 42);
      const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      at += 46 + nameLen + extra + comment;
      total += size;
      if (total > ZIP_MAX_BYTES) return new Error("That zip is too large.");
      if (zip.readUInt32LE(local) !== 0x04034b50) return new Error("The zip is damaged.");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const packed = zip.subarray(start, start + zip.readUInt32LE(local + 18));
      if (method !== 0 && method !== 8)
        return new Error("That zip uses a method this cannot read.");
      // A crafted entry can declare a small size and inflate to gigabytes: stop at what it declares.
      const data =
        method === 0
          ? Buffer.from(packed)
          : NodeZlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
      if (data.length !== size || crc32(data) !== crc)
        return new Error(`${name} is damaged in the zip.`);
      if (!name.endsWith("/")) out.push({ name, data });
    }
  } catch {
    return new Error("The zip is damaged.");
  }
  return out;
};
