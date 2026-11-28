// Minimal PNG-encoder (RGBA, filter 0) för Workers — använder DeflateStream (zlib),
// så ingen extern beroende behövs. Räcker för våra små väder-frames.

// DeflateStream finns i Workers runtime men inte i TS DOM-lib för denna version:
declare class DeflateStream extends TransformStream<BlobPart, Uint8Array> {
  constructor(format: "deflate" | "gzip" | "deflate-raw");
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) throw new Error("rgba size mismatch");
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // råa scanlines med filter-byte 0 före varje rad
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const comp = new ((globalThis as unknown as { DeflateStream?: typeof CompressionStream }).DeflateStream ?? CompressionStream)("deflate");
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(comp);
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(sig.length + 25 + idat.length + 12);
  out.set(sig, 0);
  out.set(chunk("IHDR", ihdr), sig.length);
  out.set(chunk("IDAT", idat), sig.length + 25);
  out.set(chunk("IEND", new Uint8Array(0)), sig.length + 25 + idat.length);
  return out;
}
