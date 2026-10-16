import { inflateSync } from "node:zlib";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, getCellDimensions, getTerminalColorMode, rgbColor, type CellDimensions,
  type Component, type TerminalColorMode } from "@earendil-works/pi-tui";

/**
 * Pasted-image previews drawn with text cells: each cell is an upper half block (U+2580) whose foreground is
 * the upper pixel and background the lower one. herdr 0.9.5's attach stream (herdr-web-ui's terminal) keeps
 * cells and their RGB colors but drops Kitty graphics, and the web side's x-pi-image markers serve only stored
 * tool-result images, so a paste preview (a file, not part of the session) can only reach it as cells.
 */

/** Whether paste previews use cells: an explicit PI_IMAGES_CELL_PREVIEWS=0|1, else inside a herdr pane. */
export function cellPreviewsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.PI_IMAGES_CELL_PREVIEWS?.trim();
  if (override === "0" || override === "1") return override === "1";
  return env.TERM_PROGRAM === "herdr";
}

export interface Pixels { width: number; height: number; rgba: Uint8Array }

/** Larger sources are scaled down by Pi first; the preview needs at most 60 x 30 pixels. */
const SOURCE_MAX_PX = 256;
/** Bounds the decode (and the inflate before it) of a PNG that did not come from that scaling. */
const MAX_DECODED_PIXELS = 1024 * 1024;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * RGBA pixels of a non-interlaced 8- or 16-bit PNG (grey, RGB, palette with tRNS alpha, grey+alpha, RGBA),
 * or undefined for anything else. Grey/RGB tRNS keys are ignored.
 */
export function decodePng(bytes: Uint8Array): Pixels | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 33 || data.toString("hex", 0, 8) !== "89504e470d0a1a0a") return undefined;
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  let palette: Buffer | undefined, alpha: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= data.length;) {
    const length = data.readUInt32BE(at);
    const name = data.toString("latin1", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return undefined;
    if (name === "IHDR" && length >= 13) {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; type = body[9]!; interlace = body[12]!;
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") alpha = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[type];
  if (!channels || interlace !== 0 || !(depth === 8 || (depth === 16 && type !== 3)) || (type === 3 && !palette)) return undefined;
  if (width < 1 || height < 1 || width * height > MAX_DECODED_PIXELS) return undefined;
  const bpp = channels * depth / 8;
  const stride = width * bpp;
  let raw: Buffer;
  const size = (stride + 1) * height;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: size }); } catch { return undefined; }
  if (raw.length < size) return undefined;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1) + 1;
    const filter = raw[start - 1]!;
    if (filter > 4) return undefined;
    for (let i = 0; i < stride; i++) {
      const x = raw[start + i]!, a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      line[i] = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1)
        : x + paeth(a, b, c);
    }
    // 16-bit samples keep their high byte.
    const sample = (i: number) => line[depth === 16 ? i * 2 : i]!;
    for (let x = 0, out = y * width * 4; x < width; x++, out += 4) {
      const s = x * channels;
      if (type === 3) {
        const index = line[x]!;
        rgba[out] = palette![index * 3] ?? 0; rgba[out + 1] = palette![index * 3 + 1] ?? 0;
        rgba[out + 2] = palette![index * 3 + 2] ?? 0; rgba[out + 3] = alpha?.[index] ?? 255;
      } else if (type === 2 || type === 6) {
        rgba[out] = sample(s); rgba[out + 1] = sample(s + 1); rgba[out + 2] = sample(s + 2);
        rgba[out + 3] = type === 6 ? sample(s + 3) : 255;
      } else {
        const grey = sample(s);
        rgba[out] = grey; rgba[out + 1] = grey; rgba[out + 2] = grey; rgba[out + 3] = type === 4 ? sample(s + 1) : 255;
      }
    }
    [prev, line] = [line, prev];
  }
  return { width, height, rgba };
}

/** Box-filter `source` down (or up) to exactly `width` x `height`; colors are averaged by alpha. */
export function resample(source: Pixels, width: number, height: number): Pixels {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * source.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * source.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / width));
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0, at = (sy * source.width + x0) * 4; sx < x1; sx++, at += 4) {
          const weight = source.rgba[at + 3]!;
          r += source.rgba[at]! * weight; g += source.rgba[at + 1]! * weight; b += source.rgba[at + 2]! * weight; a += weight;
        }
      }
      const out = (y * width + x) * 4;
      const count = (y1 - y0) * (x1 - x0);
      if (a > 0) { rgba[out] = Math.round(r / a); rgba[out + 1] = Math.round(g / a); rgba[out + 2] = Math.round(b / a); }
      rgba[out + 3] = Math.round(a / count);
    }
  }
  return { width, height, rgba };
}

/**
 * Columns and pixel rows (two per cell row) for an image shown within `maxCols` x `maxRows` cells, scaled like
 * pi-tui's Image (up or down, aspect kept for the terminal's cell size).
 */
export function cellGrid(widthPx: number, heightPx: number, maxCols: number, maxRows: number,
  cell: CellDimensions = getCellDimensions()): { cols: number; pixelRows: number } {
  const scale = Math.min(maxCols * cell.widthPx / widthPx, maxRows * cell.heightPx / heightPx);
  const clamp = (value: number, max: number) => Math.max(1, Math.min(max, Math.round(value)));
  return { cols: clamp(widthPx * scale / cell.widthPx, maxCols), pixelRows: clamp(heightPx * scale * 2 / cell.heightPx, maxRows * 2) };
}

const RESET = "\x1b[0m";
const UPPER = "\u2580";
const LOWER = "\u2584";

/** One line per two pixel rows of `pixels`, indented by one column; transparent pixels keep the terminal background. */
export function halfBlockLines(pixels: Pixels, mode: TerminalColorMode): string[] {
  const { width, height, rgba } = pixels;
  const color = (row: number, x: number) => {
    const at = (row * width + x) * 4;
    return row < height && rgba[at + 3]! >= 128 ? rgbColor(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!) : undefined;
  };
  const lines: string[] = [];
  for (let row = 0; row < height; row += 2) {
    let line = " ";
    let style = "";
    for (let x = 0; x < width; x++) {
      const top = color(row, x), bottom = color(row + 1, x);
      const next = top ? foregroundAnsi(top, mode) + (bottom ? backgroundAnsi(bottom, mode) : "")
        : bottom ? foregroundAnsi(bottom, mode) : "";
      if (next !== style) { line += RESET + next; style = next; }
      line += top ? UPPER : bottom ? LOWER : " ";
    }
    lines.push(style ? line + RESET : line);
  }
  return lines;
}

/** A small decoded copy of an image: Pi scales it down (EXIF-rotated) and re-encodes non-PNG input as PNG. */
export async function loadPreviewPixels(data: string, mimeType: string): Promise<Pixels | undefined> {
  const resized = await resizeImage(Buffer.from(data, "base64"), mimeType,
    { maxWidth: SOURCE_MAX_PX, maxHeight: SOURCE_MAX_PX, maxBytes: Number.MAX_SAFE_INTEGER });
  const png = resized && await convertToPng(resized.data, resized.mimeType);
  return png ? decodePng(Buffer.from(png.data, "base64")) : undefined;
}

interface Loaded { pixels?: Pixels | null; waiters: Set<() => void> }
/** Keyed by the image object, which the caller keeps while the file is unchanged. */
const loaded = new WeakMap<object, Loaded>();

/** The preview pixels of `image`, null when it cannot be decoded, or undefined while loading (`onReady` follows). */
export function previewPixels(image: { data: string; mimeType: string }, onReady: () => void): Pixels | null | undefined {
  let entry = loaded.get(image);
  if (!entry) {
    const created: Loaded = entry = { waiters: new Set() };
    loaded.set(image, created);
    loadPreviewPixels(image.data, image.mimeType).catch(() => undefined).then((pixels) => {
      created.pixels = pixels ?? null;
      for (const waiter of created.waiters) waiter();
      created.waiters.clear();
    });
  }
  if (entry.pixels === undefined) entry.waiters.add(onReady);
  return entry.pixels;
}

/**
 * An image drawn as cells within `maxWidthCells` x `maxHeightCells`. It shows nothing while decoding, calls
 * `requestRender` once ready, and renders `fallback()` when the image cannot be decoded.
 */
export class CellImage implements Component {
  private cached?: { width: number; mode: TerminalColorMode; lines: string[] };
  private fallbackComponent?: Component;

  constructor(private readonly image: { data: string; mimeType: string }, private readonly options: {
    maxWidthCells: number; maxHeightCells: number; requestRender: () => void; fallback: () => Component;
  }) {}

  render(width: number): string[] {
    const pixels = previewPixels(this.image, this.options.requestRender);
    if (pixels === undefined) return [];
    if (pixels === null) return (this.fallbackComponent ??= this.options.fallback()).render(width);
    const mode = getTerminalColorMode();
    if (this.cached?.width === width && this.cached.mode === mode) return this.cached.lines;
    const { cols, pixelRows } = cellGrid(pixels.width, pixels.height,
      Math.max(1, Math.min(width - 2, this.options.maxWidthCells)), this.options.maxHeightCells);
    const lines = halfBlockLines(resample(pixels, cols, pixelRows), mode);
    this.cached = { width, mode, lines };
    return lines;
  }

  invalidate(): void {
    this.cached = undefined;
    this.fallbackComponent?.invalidate();
  }
}
