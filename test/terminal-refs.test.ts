import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image, resetCapabilitiesCache, setCapabilities, setImageTranscoder, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMarkers, fileImageRef, ImageRefIndex, imageDigest, installMarkerProvider, kittyPlacement, MARKER_CELL, markersActive,
  markersEnabled, markerUri, markFileImage, MAX_FILE_REF_PATH, MAX_MARKER_URI, registerTerminalImageRefs, toolResultImageRefs,
} from "../src/terminal-refs.ts";

// 4x2 PNG and 1x1 PNG, generated for these tests.
const WIDE = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP8z4AATEhsBgAZNQEDGy9LEgAAAABJRU5ErkJggg==";
const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// 6x4 JPEG, GIF and WebP (PIL), the non-PNG types the web endpoint serves; Kitty gets them converted to PNG.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z";
const GIF = "R0lGODdhBgAEAIEAAMgeHgAAAAAAAAAAACwAAAAABgAEAAAICwABCBxIsKDBgQEBADs=";
const WEBP = "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoGAAQAAUAmJaACdLoABDAAAP7x3I/4DdfFtMv/vYL/3YL/3YL/WwAA";
/** Tool call id shapes Pi stores: Responses-style providers (here via cliproxyapi) join two ids with `|`. */
const RESPONSES_ID = "call_y5Gh9z6NSxziUyBf7K4umrQV|fc_0fddae98c8d2a917016ad1bd4060f487d08a4bf4a4fde816c9";
const TOOLU_ID = "toolu_01LDmcnpkhPXRBeUZVheErcM|fc_0123456789abcdef0123456789abcdef0123456789abcdef01";
const KITTY_CAPS = { images: "kitty" as const, trueColor: true, hyperlinks: true };
const fallbackTheme = { fallbackColor: (text: string) => text };

/**
 * The web consumer's strict parser (herdr-web-ui contract v1, shared/terminal-images.ts), used to check what
 * we emit: query charset, six keys once each, pi's session id rule, and `ref` = `pi:<id>:<n>` with an opaque
 * id of 1..1024 printable non-space ASCII characters (parsePiImageRef: the last colon separates n), or
 * `file:<absolute path>` (parsePiFileRef: at most 1024 characters, no control character, no `.`/`..` segment).
 */
function parseMarker(uri: string) {
  const match = /^x-pi-image:v1\?(.*)$/.exec(uri);
  if (!match || uri.length > MAX_MARKER_URI || !/^[A-Za-z0-9._~%:=&-]+$/.test(match[1]!)) return undefined;
  const params = new URLSearchParams(match[1]);
  const keys = [...params.keys()];
  if (keys.length !== 6 || new Set(keys).size !== 6 || !["s", "ref", "h", "c", "r", "y"].every((key) => params.has(key))) return undefined;
  const fields = { s: params.get("s")!, ref: params.get("ref")!, h: params.get("h")!, c: +params.get("c")!, r: +params.get("r")!, y: +params.get("y")! };
  const file = /^file:(\/[^\u0000-\u001f\u007f]{0,1023})$/.exec(fields.ref)?.[1];
  const fileOk = file !== undefined && !file.split("/").some((segment) => segment === "." || segment === "..");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(fields.s) || !(fileOk || /^pi:[\x21-\x7e]{1,1024}:\d{1,3}$/.test(fields.ref)) || !/^[0-9a-f]{32}$/.test(fields.h)) return undefined;
  if (!(fields.c >= 1 && fields.c <= 1000 && fields.r >= 1 && fields.r <= 1000 && fields.y >= 0 && fields.y < fields.r)) return undefined;
  return fields;
}
const markersIn = (lines: readonly string[]) => lines.flatMap((line, row) =>
  [...line.matchAll(/\x1b\]8;;(x-pi-image:[^\x1b]*)\x1b\\\u2800\x1b\]8;;\x1b\\/g)].map((m) => ({ row, uri: m[1]!, fields: parseMarker(m[1]!) })));

function toolResult(toolCallId: string, content: unknown[]) {
  return { type: "message", message: { role: "toolResult", toolCallId, content } };
}

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); } } as unknown as ExtensionAPI;
  const emit = (name: string, event: object, ctx?: object) => { for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx); };
  return { pi, emit };
}
function context(branch: unknown[], overrides: object = {}) {
  return { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "01a142f0-cec2-7551-9aed-c54190245745", getBranch: () => branch }, ...overrides };
}

beforeEach(() => setCapabilities(KITTY_CAPS));
afterEach(() => resetCapabilitiesCache());

describe("refs and index", () => {
  it("counts n among served image blocks only, like the web endpoint", () => {
    const refs = toolResultImageRefs("call_1", [
      { type: "text", text: "x" },
      { type: "image", data: WIDE, mimeType: "image/png" },
      { type: "image", data: DOT, mimeType: "image/bmp" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", mimeType: "image/png" },
      { type: "image", data: DOT, mimeType: "image/jpeg" },
    ]);
    expect(refs).toEqual([{ ref: "pi:call_1:0", data: WIDE }, { ref: "pi:call_1:1", data: DOT }]);
    expect(toolResultImageRefs("", [{ type: "image", data: DOT, mimeType: "image/png" }])).toEqual([]);
    expect(toolResultImageRefs("call_2", "text")).toEqual([]);
  });

  it("finds the newest ref with equal data, rebuilds from a branch and stays bounded", () => {
    const index = new ImageRefIndex(3);
    index.rebuild([
      { type: "message", message: { role: "user", content: [{ type: "image", data: DOT, mimeType: "image/png" }] } },
      toolResult("a", [{ type: "image", data: DOT, mimeType: "image/png" }]),
      { type: "custom", data: {} },
    ]);
    expect(index.find(DOT)).toBe("pi:a:0");
    expect(index.find(WIDE)).toBeUndefined();
    index.add("b", [{ type: "image", data: DOT, mimeType: "image/png" }]);
    index.add("b", [{ type: "image", data: DOT, mimeType: "image/png" }]);
    expect(index.size).toBe(2);
    expect(index.find(DOT)).toBe("pi:b:0");
    index.add("c", [{ type: "image", data: WIDE, mimeType: "image/png" }, { type: "image", data: WIDE, mimeType: "image/png" }]);
    expect(index.size).toBe(3);
    index.add("d", [{ type: "image", data: WIDE, mimeType: "image/png" }]);
    expect(index.size).toBe(3);
    expect(index.find(DOT)).toBeUndefined(); // a:0 and b:0 evicted, oldest first
    expect(index.find(WIDE)).toBe("pi:d:0");
    index.rebuild([]);
    expect(index.find(WIDE)).toBeUndefined();
  });

  it("digests the decoded original bytes", () => {
    expect(imageDigest(WIDE)).toBe(createHash("sha256").update(Buffer.from(WIDE, "base64")).digest("hex").slice(0, 32));
    expect(imageDigest(WIDE)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("builds URIs the web parser accepts", () => {
    const uri = markerUri({ session: "01a142f0-cec2-7551-9aed-c54190245745", ref: "pi:toolu_01:Ab.c-d:2", digest: "0".repeat(32), cols: 60, rows: 19, row: 3 });
    expect(uri).toBe("x-pi-image:v1?s=01a142f0-cec2-7551-9aed-c54190245745&ref=pi%3Atoolu_01%3AAb.c-d%3A2&h=00000000000000000000000000000000&c=60&r=19&y=3");
    expect(parseMarker(uri)).toEqual({ s: "01a142f0-cec2-7551-9aed-c54190245745", ref: "pi:toolu_01:Ab.c-d:2", h: "0".repeat(32), c: 60, r: 19, y: 3 });
  });

  it("keeps opaque tool call ids, including Responses-style `call_…|fc_…` ids, inside the marker charset", () => {
    for (const id of [RESPONSES_ID, TOOLU_ID, "weird!'()*~ id/+=?&#", "ид:1"]) {
      const ref = `pi:${id}:0`;
      const uri = markerUri({ session: "01a135da-d28a-7523-a034-93c7938f8304", ref, digest: "a".repeat(32), cols: 56, rows: 30, row: 1 });
      expect(uri.length).toBeLessThanOrEqual(MAX_MARKER_URI);
      expect(uri).toMatch(/^x-pi-image:v1\?[A-Za-z0-9._~%:=&-]+$/);
      expect(new URLSearchParams(uri.slice(uri.indexOf("?") + 1)).get("ref")).toBe(ref);
      // not dropped by the line-level safety check
      expect(markersIn(addMarkers([`\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=7;${DOT}\x1b\\`, ""], () => uri)!)).toHaveLength(1);
    }
    const live = markerUri({ session: "01a135da-d28a-7523-a034-93c7938f8304", ref: `pi:${RESPONSES_ID}:0`, digest: "299eb06818ec04fb1cacb2494cad94e3", cols: 56, rows: 30, row: 1 });
    expect(live).toBe("x-pi-image:v1?s=01a135da-d28a-7523-a034-93c7938f8304&ref=pi%3Acall_y5Gh9z6NSxziUyBf7K4umrQV%7Cfc_0fddae98c8d2a917016ad1bd4060f487d08a4bf4a4fde816c9%3A0"
      + "&h=299eb06818ec04fb1cacb2494cad94e3&c=56&r=30&y=1");
    expect(parseMarker(live)?.ref).toBe(`pi:${RESPONSES_ID}:0`);
    expect(markerUri({ session: "s", ref: "pi:a(1)*:0", digest: "a".repeat(32), cols: 1, rows: 1, row: 0 })).toContain("ref=pi%3Aa%281%29%2A%3A0");
  });
});

describe("marker lines", () => {
  const apc = (cols: number, rows: number) => `\x1b_Ga=T,f=100,q=2,C=1,c=${cols},r=${rows},i=7;${DOT}\x1b\\`;
  const uri = (row: number) => `x-pi-image:v1?s=s&ref=pi%3Ac%3A0&h=${"a".repeat(32)}&c=4&r=3&y=${row}`;

  it("reads the placement size of a Kitty line", () => {
    expect(kittyPlacement(apc(12, 5))).toEqual({ cols: 12, rows: 5 });
    expect(kittyPlacement(`\x1b_Ga=T,f=100,q=2,C=1,c=3,r=2,i=1,m=1;AAAA\x1b\\\x1b_Gm=0;BBBB\x1b\\`)).toEqual({ cols: 3, rows: 2 });
    expect(kittyPlacement(`\x1b_Ga=T,f=100,q=2;${DOT}\x1b\\`)).toBeUndefined();
    expect(kittyPlacement("\x1b]1337;File=inline=1:AAAA\x07")).toBeUndefined();
    expect(kittyPlacement("plain")).toBeUndefined();
  });

  it("marks rows 1..r-1 right of the image, never row 0 of a multi-row image, without mutating the input", () => {
    const lines = Object.freeze([apc(4, 3), "", ""]);
    const out = addMarkers(lines, uri)!;
    expect(out).not.toBe(lines);
    expect(out[0]).toBe(lines[0]);
    expect(markersIn(out).map((m) => [m.row, m.fields?.y])).toEqual([[1, 1], [2, 2]]);
    for (const line of out.slice(1)) {
      expect(line.startsWith("    \x1b]8;;")).toBe(true);
      expect(visibleWidth(line)).toBe(5);
    }
  });

  it("moves the cursor past a one-row image on its own line", () => {
    const out = addMarkers([apc(4, 1)], uri)!;
    expect(out[0]).toBe(`${apc(4, 1)}\x1b[4C\x1b]8;;${uri(0)}\x1b\\${MARKER_CELL}\x1b]8;;\x1b\\`);
  });

  it("leaves lines alone when they do not have Pi's Kitty shape or the URI is unsafe", () => {
    expect(addMarkers([apc(4, 3), ""], uri)).toBeUndefined();
    expect(addMarkers([apc(4, 2), "text"], uri)).toBeUndefined();
    expect(addMarkers(["fallback [image/png 1x1]"], uri)).toBeUndefined();
    expect(addMarkers([apc(4, 2), ""], () => `x-pi-image:v1?${"a".repeat(MAX_MARKER_URI)}`)).toBeUndefined();
    expect(addMarkers([apc(4, 2), ""], () => "x-pi-image:v1?s=a b")).toBeUndefined();
    expect(addMarkers([apc(4, 2), ""], () => "x-pi-image:v1?s=\x1b]8;;")).toBeUndefined();
  });

  it("is enabled for Kitty images in herdr panes unless overridden", () => {
    expect(markersEnabled({ TERM_PROGRAM: "herdr" }, "kitty")).toBe(true);
    expect(markersEnabled({ TERM_PROGRAM: "kitty" }, "kitty")).toBe(false);
    expect(markersEnabled({}, "kitty")).toBe(false);
    expect(markersEnabled({ TERM_PROGRAM: "herdr" }, "iterm2")).toBe(false);
    expect(markersEnabled({ TERM_PROGRAM: "herdr" }, null)).toBe(false);
    expect(markersEnabled({ TERM_PROGRAM: "herdr", PI_IMAGES_TERMINAL_REFS: "0" }, "kitty")).toBe(false);
    expect(markersEnabled({ PI_IMAGES_TERMINAL_REFS: "1" }, "kitty")).toBe(true);
    expect(markersEnabled({ PI_IMAGES_TERMINAL_REFS: "1" }, "iterm2")).toBe(false);
  });
});

describe("Pi image components", () => {
  const herdr = { TERM_PROGRAM: "herdr" };
  const wideResult = toolResult("call_wide", [{ type: "text", text: "Read image" }, { type: "image", data: WIDE, mimeType: "image/png" }]);
  const render = (image: Image) => image.render(80);
  let cleanup: (() => void)[] = [];
  afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
  const start = (branch: unknown[], env: NodeJS.ProcessEnv = herdr, ctx: object = {}) => {
    const { pi, emit } = fakePi();
    registerTerminalImageRefs(pi, { env });
    emit("session_start", { reason: "startup" }, context(branch, ctx));
    cleanup.push(() => emit("session_shutdown", { reason: "quit" }));
    return emit;
  };

  it("adds markers to images of the session's tool results, once per render and stable across frames", () => {
    const native = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 }).render(80);
    start([wideResult]);
    const image = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    const lines = render(image);
    const placement = kittyPlacement(lines[0]!)!;
    expect(lines).toHaveLength(placement.rows);
    expect(lines[0]).toBe(native[0]!.replace(/i=\d+/, lines[0]!.match(/i=\d+/)![0]));
    const markers = markersIn(lines);
    expect(markers.map((m) => m.row)).toEqual(Array.from({ length: placement.rows - 1 }, (_, i) => i + 1));
    for (const marker of markers) expect(marker.fields).toEqual({ s: "01a142f0-cec2-7551-9aed-c54190245745", ref: "pi:call_wide:0",
      h: imageDigest(WIDE), c: placement.cols, r: placement.rows, y: marker.row });
    expect(render(image)).toBe(lines);
    expect(markersIn(render(image))).toHaveLength(markers.length);
  });

  it("marks stored JPEG/GIF/WebP read results with Responses-style ids, digesting the stored bytes, not Kitty's PNG", () => {
    // Pi registers a real transcoder at startup; a fixed PNG stands in for its output here
    setImageTranscoder(() => WIDE);
    cleanup.push(() => setImageTranscoder(undefined));
    for (const [data, mimeType] of [[JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"]] as const) {
      // what the session JSONL holds for Pi's read tool: a text block, then the image
      const emit = start([toolResult(RESPONSES_ID, [{ type: "text", text: `Read image file [${mimeType}]` }, { type: "image", data, mimeType }])]);
      const lines = render(new Image(data, mimeType, fallbackTheme, { maxWidthCells: 20 }));
      expect(lines[0]).toContain(`;${WIDE}`); // Kitty receives the PNG conversion
      const placement = kittyPlacement(lines[0]!)!;
      const markers = markersIn(lines);
      expect(markers.map((m) => m.row)).toEqual(Array.from({ length: placement.rows - 1 }, (_, i) => i + 1));
      for (const marker of markers) {
        expect(marker.fields).toEqual({ s: "01a142f0-cec2-7551-9aed-c54190245745", ref: `pi:${RESPONSES_ID}:0`, h: imageDigest(data),
          c: placement.cols, r: placement.rows, y: marker.row });
        expect(marker.uri).toContain("%7Cfc_");
      }
      expect(imageDigest(data)).not.toBe(imageDigest(WIDE));
      emit("session_shutdown", { reason: "quit" });
    }
  });

  it("keeps native output for images that are not stored tool results, outside herdr, and after shutdown", () => {
    const emit = start([wideResult]);
    const other = new Image(DOT, "image/png", fallbackTheme, { maxWidthCells: 20 });
    expect(markersIn(render(other))).toEqual([]);
    const image = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    expect(markersIn(render(image)).length).toBeGreaterThan(0);
    emit("session_shutdown", { reason: "quit" });
    const after = render(image);
    expect(markersIn(after)).toEqual([]);
    expect(after.slice(1).every((line) => line === "")).toBe(true);

    start([wideResult], {});
    expect(markersIn(render(new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 })))).toEqual([]);
  });

  it("returns the original render result untouched when no marker applies", () => {
    start([wideResult], {});
    const image = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    const first = render(image);
    expect(render(image)).toBe(first);
    expect(first.slice(1).every((line) => line === "")).toBe(true);
  });

  it("does not run outside the TUI or for other image protocols", () => {
    start([wideResult], herdr, { mode: "rpc" });
    expect(markersIn(render(new Image(WIDE, "image/png", fallbackTheme)))).toEqual([]);
    for (const fn of cleanup.splice(0)) fn();
    start([wideResult], herdr, { hasUI: false });
    expect(markersIn(render(new Image(WIDE, "image/png", fallbackTheme)))).toEqual([]);
    for (const fn of cleanup.splice(0)) fn();
    setCapabilities({ ...KITTY_CAPS, images: "iterm2" });
    start([wideResult]);
    expect(markersIn(render(new Image(WIDE, "image/png", fallbackTheme)))).toEqual([]);
  });

  it("learns new tool results from tool_execution_end and message_end, ignoring nested calls", () => {
    const emit = start([]);
    const image = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    expect(markersIn(render(image))).toEqual([]);
    emit("tool_execution_end", { toolCallId: "outer/1", parentToolCallId: "outer", result: { content: wideResult.message.content } });
    expect(markersIn(render(image))).toEqual([]);
    emit("tool_execution_end", { toolCallId: "call_live", toolName: "read", result: { content: wideResult.message.content }, isError: false });
    expect(markersIn(render(image))[0]!.fields!.ref).toBe("pi:call_live:0");
    const dot = new Image(DOT, "image/png", fallbackTheme, { maxWidthCells: 20 });
    emit("message_end", { message: { role: "toolResult", toolCallId: "call_dot", content: [{ type: "image", data: DOT, mimeType: "image/png" }] } });
    expect(new Set(markersIn(render(dot)).map((m) => m.fields!.ref))).toEqual(new Set(["pi:call_dot:0"]));
  });

  it("follows /tree: refs of an abandoned branch stop resolving", () => {
    const branch: unknown[] = [wideResult];
    const emit = start(branch);
    const image = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    expect(markersIn(render(image)).length).toBeGreaterThan(0);
    branch.length = 0;
    emit("session_tree", { newLeafId: null, oldLeafId: "x" }, context(branch));
    expect(markersIn(render(image))).toEqual([]);
  });

  it("shares one patch across runtimes and only the latest provider runs", () => {
    const first = installMarkerProvider(() => ["first"]);
    const second = installMarkerProvider(() => ["second"]);
    const image = new Image(DOT, "image/png", fallbackTheme);
    expect(image.render(80)).toEqual(["second"]);
    first();
    expect(image.render(80)).toEqual(["second"]);
    second();
    second();
    expect(image.render(80)[0]).toContain("\x1b_G");
    const failing = installMarkerProvider(() => { throw new Error("boom"); });
    expect(image.render(80)[0]).toContain("\x1b_G");
    failing();
  });

  it("names a picture drawn from a file by `file:<path>`, whatever tool result holds the same bytes", () => {
    expect(markersActive()).toBe(false);
    start([wideResult]);
    expect(markersActive()).toBe(true);
    const path = "/home/u/.herdr-web-ui/붙여넣기 #1 100%.png";
    const pasted = markFileImage(new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 }), path);
    const lines = render(pasted);
    const markers = markersIn(lines);
    const placement = kittyPlacement(lines[0]!)!;
    expect(markers.map((m) => m.row)).toEqual(Array.from({ length: placement.rows - 1 }, (_, i) => i + 1));
    for (const marker of markers) {
      expect(marker.fields).toBeDefined();
      expect(marker.fields!.ref).toBe(`file:${path}`);
      expect(marker.fields!.h).toBe(imageDigest(WIDE));
      // percent-encoded: spaces, Korean, `#` and `%` never reach the URI raw
      expect(marker.uri).toContain("ref=file%3A%2Fhome%2Fu%2F.herdr-web-ui%2F%EB%B6%99%EC%97%AC%EB%84%A3%EA%B8%B0%20%231%20100%25.png");
    }
    // the same bytes drawn by a tool result's component keep that result's ref
    const tool = new Image(WIDE, "image/png", fallbackTheme, { maxWidthCells: 20 });
    expect(markersIn(render(tool)).every((m) => m.fields!.ref === "pi:call_wide:0")).toBe(true);
    // a file needs no tool result, and a /tree change keeps it
    const dot = markFileImage(new Image(DOT, "image/png", fallbackTheme, { maxWidthCells: 20 }), "/tmp/dot.png");
    const refs = markersIn(render(dot)).map((m) => m.fields?.ref);
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set(["file:/tmp/dot.png"]));
  });

  it("gives no marker to a file picture the web would not take, and none without a provider", () => {
    const image = (path: string, mimeType = "image/png", data = WIDE) =>
      markFileImage(new Image(data, mimeType, fallbackTheme, { maxWidthCells: 20 }), path);
    expect(markersIn(render(image("/tmp/a.png")))).toEqual([]);
    start([]);
    expect(markersIn(render(image("relative.png")))).toEqual([]);
    expect(markersIn(render(image("/tmp/../etc/a.png")))).toEqual([]);
    expect(markersIn(render(image("/tmp/a\nb.png")))).toEqual([]);
    expect(markersIn(render(image(`/${"a".repeat(MAX_FILE_REF_PATH)}`)))).toEqual([]);
    // a path within the ref bound whose encoded marker passes 512 characters gets none either
    expect(markersIn(render(image(`/${"한".repeat(60)}.png`)))).toEqual([]);
    expect(markersIn(render(image("/tmp/a.bmp", "image/bmp", DOT)))).toEqual([]);
    expect(fileImageRef("C:\\Users\\a.png")).toBe("file:C:\\Users\\a.png");
    expect(fileImageRef("/tmp/./a.png")).toBeUndefined();
    expect(fileImageRef("/")).toBeUndefined();
  });
});
