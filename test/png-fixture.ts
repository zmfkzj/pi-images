import { crc32, deflateSync } from "node:zlib";

export const chunk = (name: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(name, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};

/** A PNG of `rows` (raw samples per row); row y uses filter `filters[y % filters.length]`. */
export function encodePng(width: number, height: number, rows: Uint8Array[], options: {
  type?: number; depth?: number; bpp?: number; filters?: number[]; palette?: number[]; trns?: number[]; interlace?: number;
} = {}): Buffer {
  const { type = 6, depth = 8, bpp = 4, filters = [0], interlace = 0 } = options;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = type; ihdr[12] = interlace;
  const filtered: number[] = [];
  let prev: Uint8Array = new Uint8Array(rows[0]?.length ?? 0);
  rows.forEach((row, y) => {
    const filter = filters[y % filters.length]!;
    filtered.push(filter);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      filtered.push((row[i]! - predictor) & 255);
    }
    prev = row;
  });
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    ...(options.palette ? [chunk("PLTE", Buffer.from(options.palette))] : []),
    ...(options.trns ? [chunk("tRNS", Buffer.from(options.trns))] : []),
    chunk("IDAT", deflateSync(Buffer.from(filtered))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An opaque PNG whose left half is red and right half blue. */
export function halvesPng(width: number, height: number): Buffer {
  const row = new Uint8Array(width * 4);
  for (let x = 0; x < width; x++) row.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], x * 4);
  return encodePng(width, height, Array.from({ length: height }, () => row));
}
