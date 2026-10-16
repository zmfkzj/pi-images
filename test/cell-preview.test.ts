import { deflateSync } from "node:zlib";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CellImage, cellGrid, cellPreviewsEnabled, decodePng, halfBlockLines, loadPreviewPixels, previewPixels,
  resample, type Pixels } from "../src/cell-preview.ts";
import { chunk, encodePng } from "./png-fixture.ts";

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], GREEN = [0, 255, 0, 255], CLEAR = [0, 0, 0, 0];
const pixels = (width: number, height: number, at: (x: number, y: number) => number[]): Pixels => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(at(x, y), (y * width + x) * 4);
  return { width, height, rgba };
};
const pixel = (p: Pixels, x: number, y: number) => [...p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
/** Left half red, right half blue. */
const halves = (width: number, height: number) => pixels(width, height, (x) => x < width / 2 ? RED : BLUE);
const rgbaRows = (p: Pixels) => Array.from({ length: p.height }, (_, y) => p.rgba.slice(y * p.width * 4, (y + 1) * p.width * 4));

// The same 16 x 8 left-red / right-blue picture in the other formats a paste may have.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4vr5Door+qP2Zf/NV/wDcj/7uH9qftDP+aZ/7nf8A3UP/2Q==";
const WEBP = "UklGRiYAAABXRUJQVlA4TBkAAAAvD8ABAA8Q87//8x8OxILJ/KU7U4jof+QAAA==";
const GIF = "R0lGODdhEAAIAIEAAP8AAAAA/wAAAAAAACwAAAAAEAAIAAAIJAABCBwoMIDBgwYJEkSIUOFAhgcdFoQYQCIAihUlYrS4USPFgAA7";

describe("cellPreviewsEnabled", () => {
  it("is on inside herdr panes, and PI_IMAGES_CELL_PREVIEWS overrides it", () => {
    expect(cellPreviewsEnabled({ TERM_PROGRAM: "herdr" })).toBe(true);
    expect(cellPreviewsEnabled({ TERM_PROGRAM: "ghostty" })).toBe(false);
    expect(cellPreviewsEnabled({})).toBe(false);
    expect(cellPreviewsEnabled({ TERM_PROGRAM: "herdr", PI_IMAGES_CELL_PREVIEWS: "0" })).toBe(false);
    expect(cellPreviewsEnabled({ TERM_PROGRAM: "kitty", PI_IMAGES_CELL_PREVIEWS: " 1 " })).toBe(true);
  });
});

describe("decodePng", () => {
  it("decodes RGBA rows with every filter type", () => {
    const source = pixels(5, 5, (x, y) => [x * 50, y * 50, (x * y * 13) & 255, 255 - x * 10]);
    expect(decodePng(encodePng(5, 5, rgbaRows(source), { filters: [0, 1, 2, 3, 4] }))).toEqual(source);
  });

  it("decodes RGB, grey, grey+alpha, 16-bit and palette images with transparency", () => {
    expect(pixel(decodePng(encodePng(1, 1, [Uint8Array.of(1, 2, 3)], { type: 2, bpp: 3 }))!, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixel(decodePng(encodePng(1, 1, [Uint8Array.of(7)], { type: 0, bpp: 1 }))!, 0, 0)).toEqual([7, 7, 7, 255]);
    expect(pixel(decodePng(encodePng(1, 1, [Uint8Array.of(7, 9)], { type: 4, bpp: 2 }))!, 0, 0)).toEqual([7, 7, 7, 9]);
    expect(pixel(decodePng(encodePng(1, 1, [Uint8Array.of(200, 1, 100, 2, 50, 3)], { type: 2, depth: 16, bpp: 6, filters: [1] }))!, 0, 0))
      .toEqual([200, 100, 50, 255]);
    const indexed = decodePng(encodePng(2, 1, [Uint8Array.of(0, 1)], { type: 3, bpp: 1, palette: [255, 0, 0, 0, 0, 255], trns: [0] }))!;
    expect([pixel(indexed, 0, 0), pixel(indexed, 1, 0)]).toEqual([[255, 0, 0, 0], [0, 0, 255, 255]]);
  });

  it("refuses what it does not decode instead of guessing", () => {
    const row = [Uint8Array.of(1, 2, 3, 4)];
    expect(decodePng(encodePng(1, 1, row, { interlace: 1 }))).toBeUndefined();
    expect(decodePng(encodePng(1, 1, [Uint8Array.of(1)], { type: 0, depth: 4, bpp: 1 }))).toBeUndefined();
    expect(decodePng(encodePng(1, 1, [Uint8Array.of(0)], { type: 3, bpp: 1 }))).toBeUndefined(); // no palette
    expect(decodePng(Buffer.from("not a png at all, really not one"))).toBeUndefined();
    const truncated = encodePng(2, 2, [Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)]);
    expect(decodePng(truncated)).toBeUndefined(); // one row short
    // A huge header is refused before anything is inflated or allocated.
    const huge = encodePng(1, 1, row);
    huge.writeUInt32BE(50_000, 16); huge.writeUInt32BE(50_000, 20);
    expect(decodePng(huge)).toBeUndefined();
    // A bad filter byte.
    const bad = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
      chunk("IDAT", deflateSync(Buffer.from([9, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))]);
    expect(decodePng(bad)).toBeUndefined();
  });
});

describe("cell drawing", () => {
  it("sizes like Pi's Image: aspect kept for the cell size, within the limits", () => {
    // The screenshot's paste: 3024 x 1898 in a transcript entry (60 x 15 cells of 9 x 18 px).
    expect(cellGrid(3024, 1898, 60, 15, { widthPx: 9, heightPx: 18 })).toEqual({ cols: 48, pixelRows: 30 });
    expect(cellGrid(100, 1000, 60, 10, { widthPx: 9, heightPx: 18 })).toEqual({ cols: 2, pixelRows: 20 });
    expect(cellGrid(16, 8, 60, 10, { widthPx: 9, heightPx: 18 })).toEqual({ cols: 40, pixelRows: 20 });
    expect(cellGrid(1, 1, 1, 1, { widthPx: 9, heightPx: 18 })).toEqual({ cols: 1, pixelRows: 1 });
  });

  it("averages by alpha when resampling", () => {
    const out = resample(pixels(4, 2, (x) => x === 0 ? RED : x === 1 ? CLEAR : BLUE), 2, 1);
    expect([pixel(out, 0, 0), pixel(out, 1, 0)]).toEqual([[255, 0, 0, 128], [0, 0, 255, 255]]);
  });

  it("draws two pixel rows per line with upper/lower half blocks and resets styling", () => {
    // Column 0: red over blue; column 1: clear over green; column 2: clear over clear. Row 2 has no lower half.
    const source = pixels(3, 3, (x, y) => y === 2 ? (x === 0 ? GREEN : CLEAR)
      : x === 0 ? (y === 0 ? RED : BLUE) : x === 1 ? (y === 0 ? CLEAR : GREEN) : CLEAR);
    expect(halfBlockLines(source, "truecolor")).toEqual([
      " \x1b[0m\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m\u2580\x1b[0m\x1b[38;2;0;255;0m\u2584\x1b[0m ",
      " \x1b[0m\x1b[38;2;0;255;0m\u2580\x1b[0m  ",
    ]);
    expect(halfBlockLines(pixels(1, 1, () => RED), "256color")[0]).toMatch(/^ \x1b\[0m\x1b\[38;5;\d+m\u2580\x1b\[0m$/);
  });
});

describe("loadPreviewPixels", () => {
  const sides = (p: Pixels) => {
    const y = Math.floor(p.height / 2);
    return [pixel(p, 1, y), pixel(p, p.width - 2, y)];
  };

  it.each([["image/jpeg", JPEG], ["image/webp", WEBP], ["image/gif", GIF]])("decodes %s through Pi's converter", async (mime, data) => {
    const p = (await loadPreviewPixels(data, mime))!;
    expect([p.width, p.height]).toEqual([16, 8]);
    const [left, right] = sides(p);
    expect(left![0]).toBeGreaterThan(200); expect(left![2]).toBeLessThan(60);
    expect(right![2]).toBeGreaterThan(200); expect(right![0]).toBeLessThan(60);
  });

  it("scales a large screenshot down before decoding it", async () => {
    const big = halves(1024, 640);
    const p = (await loadPreviewPixels(encodePng(1024, 640, rgbaRows(big)).toString("base64"), "image/png"))!;
    expect(Math.max(p.width, p.height)).toBe(256);
    const [left, right] = sides(p);
    expect(left).toEqual(RED); expect(right).toEqual(BLUE);
  });

  it("gives undefined for bytes that are not an image", async () => {
    expect(await loadPreviewPixels(Buffer.from("nope").toString("base64"), "image/png")).toBeUndefined();
  });
});

describe("CellImage", () => {
  const png = (width: number, height: number) => ({ data: encodePng(width, height, rgbaRows(halves(width, height))).toString("base64"), mimeType: "image/png" });

  it("shows nothing while decoding, asks for a render, then draws colored cells within the width", async () => {
    const requestRender = vi.fn();
    const image = new CellImage(png(40, 20), { maxWidthCells: 60, maxHeightCells: 10, requestRender, fallback: () => { throw new Error("no fallback"); } });
    expect(image.render(80)).toEqual([]);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));
    const lines = image.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.join("")).toContain("\x1b[38;2;255;0;0m");
    expect(lines.join("")).toContain("\x1b[38;2;0;0;255m");
    expect(lines.join("")).not.toContain("\x1b_G");
    for (const width of [80, 20, 3]) for (const line of image.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(image.render(80)).toBe(image.render(80)); // cached per width
  });

  it("falls back to the given component when the image cannot be decoded", async () => {
    const requestRender = vi.fn();
    const image = new CellImage({ data: Buffer.from("broken").toString("base64"), mimeType: "image/png" },
      { maxWidthCells: 60, maxHeightCells: 10, requestRender, fallback: () => ({ render: () => ["fallback"], invalidate: () => {} }) });
    image.render(80);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(image.render(80)).toEqual(["fallback"]);
  });

  it("decodes one image once for every component that shows it", async () => {
    const shared = png(8, 8);
    const first = vi.fn(), second = vi.fn();
    expect(previewPixels(shared, first)).toBeUndefined();
    expect(previewPixels(shared, second)).toBeUndefined();
    await vi.waitFor(() => expect(second).toHaveBeenCalled());
    expect(first).toHaveBeenCalledTimes(1);
    const third = vi.fn();
    expect(previewPixels(shared, third)).toMatchObject({ width: 8, height: 8 });
    expect(third).not.toHaveBeenCalled();
  });
});
