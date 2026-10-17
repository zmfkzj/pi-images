import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image } from "@earendil-works/pi-tui";

/**
 * Terminal image references (marker v1) for web terminals that cannot receive Kitty graphics.
 *
 * herdr's attach stream (and so herdr-web-ui's terminal) carries text, cursor and OSC 8 hyperlinks,
 * but drops Kitty graphics. Next to each native Kitty image of a tool result, this module writes, on
 * every image row except the first of a multi-row image, one cell immediately right of the image:
 * U+2800 (a blank glyph) wrapped in an OSC 8 link
 *
 *   x-pi-image:v1?s=<session id>&ref=<pi:toolCallId:n>&h=<32 hex>&c=<cols>&r=<rows>&y=<row>
 *
 * The web terminal resolves `ref` through its authenticated, pane-scoped image endpoint, checks the
 * pane's session against `s` and the bytes against `h`, and draws the image inline at
 * (markerX - c, markerY - y). Markers carry no URL or image bytes. Images of tool results on the current branch
 * of this session are named by `pi:<toolCallId>:<n>`; a picture drawn from a file (a pasted image, marked with
 * markFileImage) by `file:<absolute path>`, which the web serves only for a marker's session- and digest-bound
 * read. Native output is unchanged unless the gate holds (Kitty images inside a herdr pane, or
 * PI_IMAGES_TERMINAL_REFS=1).
 */
export const MARKER_SCHEME = "x-pi-image";
export const MARKER_VERSION = "v1";
/** BRAILLE PATTERN BLANK: one blank cell a consumer can tell apart from an erased or overwritten cell. */
export const MARKER_CELL = "\u2800";
export const MAX_MARKER_URI = 512;
/** Tool-result images remembered per session (most recent kept). */
export const MAX_INDEXED_IMAGES = 1000;
/** Same MIME types the web endpoint serves; `n` counts only blocks it would count. */
const SERVED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PATCH = Symbol.for("pi-images:terminal-refs:image-render");

export interface ImageRef { ref: string; data: string }
type MarkerProvider = (image: Image, lines: string[]) => string[] | undefined;
interface PatchState { original: Image["render"]; provider?: MarkerProvider; owner?: symbol }

/** `ref` names of the served images in a tool result's content, in the order the web counts them. */
export function toolResultImageRefs(toolCallId: string, content: unknown): ImageRef[] {
  if (!toolCallId || !Array.isArray(content)) return [];
  const refs: ImageRef[] = [];
  for (const block of content) {
    const image = block as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
    if (image?.type !== "image" || typeof image.data !== "string" || !image.data
      || typeof image.mimeType !== "string" || !SERVED_TYPES.has(image.mimeType)) continue;
    refs.push({ ref: `pi:${toolCallId}:${refs.length}`, data: image.data });
  }
  return refs;
}

/** Image data -> ref for one session's current branch; bounded, newest wins. */
export class ImageRefIndex {
  private byLength = new Map<number, ImageRef[]>();
  private order: ImageRef[] = [];
  private refs = new Set<string>();
  constructor(private readonly limit = MAX_INDEXED_IMAGES) {}

  get size(): number { return this.order.length; }
  /** Changes whenever a lookup could answer differently. */
  version = 0;

  clear(): void { this.byLength.clear(); this.order = []; this.refs.clear(); this.version++; }

  add(toolCallId: string, content: unknown): void {
    for (const entry of toolResultImageRefs(toolCallId, content)) {
      if (this.refs.has(entry.ref)) continue;
      this.refs.add(entry.ref);
      this.version++;
      this.order.push(entry);
      const bucket = this.byLength.get(entry.data.length);
      if (bucket) bucket.push(entry); else this.byLength.set(entry.data.length, [entry]);
    }
    while (this.order.length > this.limit) this.remove(this.order.shift()!);
  }

  /** Rebuild from the tool results of a branch (session entries, root first). */
  rebuild(entries: readonly unknown[]): void {
    this.clear();
    for (const entry of entries) {
      const item = entry as { type?: unknown; message?: { role?: unknown; toolCallId?: unknown; content?: unknown } } | null;
      if (item?.type !== "message" || item.message?.role !== "toolResult" || typeof item.message.toolCallId !== "string") continue;
      this.add(item.message.toolCallId, item.message.content);
    }
  }

  /** The newest ref whose data equals `data` (string comparison only among equal lengths). */
  find(data: string): string | undefined {
    const bucket = this.byLength.get(data.length);
    if (!bucket) return undefined;
    for (let i = bucket.length - 1; i >= 0; i--) if (bucket[i]!.data === data) return bucket[i]!.ref;
    return undefined;
  }

  private remove(entry: ImageRef): void {
    this.refs.delete(entry.ref);
    const bucket = this.byLength.get(entry.data.length);
    if (!bucket) return;
    const index = bucket.indexOf(entry);
    if (index >= 0) bucket.splice(index, 1);
    if (!bucket.length) this.byLength.delete(entry.data.length);
  }
}

/** First 32 hex characters of the SHA-256 of the decoded image bytes. */
export function imageDigest(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex").slice(0, 32);
}

/** The longest image file path a `file:` ref names (herdr-web-ui's bound). */
export const MAX_FILE_REF_PATH = 1024;

/**
 * The `file:` ref of an image file pi drew from a path, or undefined when the web would not take it: absolute
 * (POSIX or a Windows drive), at most 1024 characters, no control character and no `.`/`..` segment.
 */
export function fileImageRef(path: string): string | undefined {
  if (path.length < 2 || path.length > MAX_FILE_REF_PATH || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return undefined;
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return undefined;
  return `file:${path}`;
}

const FILE_IMAGES = Symbol.for("pi-images:terminal-refs:file-images");
/** Image components drawn from a file (pasted pictures), shared by every runtime of this process. */
function fileImages(): WeakMap<Image, string> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<Image, string> | undefined>;
  return holder[FILE_IMAGES] ??= new WeakMap();
}

/**
 * Names `image` by the file it was read from: its markers carry `file:<path>` instead of a tool result's ref,
 * whatever tool result holds the same bytes, and the web reads the file, checking the digest of the bytes this
 * component drew. Returns `image`.
 */
export function markFileImage<T extends Image>(image: T, path: string): T {
  fileImages().set(image, path);
  return image;
}

/** Whether a marker provider is installed now (some session writes markers). */
export function markersActive(): boolean {
  return (Image.prototype as unknown as Record<symbol, PatchState | undefined>)[PATCH]?.provider !== undefined;
}

/**
 * Percent-encodes everything outside RFC 3986 unreserved characters (encodeURIComponent leaves `!'()*`).
 * Tool call ids are opaque and provider-specific (e.g. `call_…|fc_…` from Responses-style providers), so
 * every id must still give a URI inside the marker's safe character set instead of losing its marker.
 */
const encodeQueryValue = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function markerUri(fields: { session: string; ref: string; digest: string; cols: number; rows: number; row: number }): string {
  return `${MARKER_SCHEME}:${MARKER_VERSION}?s=${encodeQueryValue(fields.session)}&ref=${encodeQueryValue(fields.ref)}`
    + `&h=${fields.digest}&c=${fields.cols}&r=${fields.rows}&y=${fields.row}`;
}

const markerCell = (uri: string) => `\x1b]8;;${uri}\x1b\\${MARKER_CELL}\x1b]8;;\x1b\\`;

/** Placement size of a Kitty image line rendered by pi-tui's Image (`c=`/`r=` of its first command). */
export function kittyPlacement(line: string): { cols: number; rows: number } | undefined {
  const controls = /\x1b_G([^;\x1b]*)[;\x1b]/.exec(line)?.[1];
  if (controls === undefined) return undefined;
  const value = (key: string) => Number(new RegExp(`(?:^|,)${key}=(\\d{1,4})(?:,|$)`).exec(controls)?.[1] ?? NaN);
  const cols = value("c");
  const rows = value("r");
  return cols > 0 && rows > 0 ? { cols, rows } : undefined;
}

/**
 * The image's lines with markers added, or undefined to keep them. Never mutates `lines`. Rows 1..r-1
 * get `c` spaces then the marker (Pi's own lines there are empty); a one-row image gets a cursor move
 * past the image on its image line, which Pi never pads, slices or composites.
 */
export function addMarkers(lines: readonly string[], uri: (row: number) => string): string[] | undefined {
  const placement = lines.length ? kittyPlacement(lines[0]!) : undefined;
  if (!placement || placement.rows !== lines.length) return undefined;
  const { cols, rows } = placement;
  const out = [...lines];
  for (let row = rows === 1 ? 0 : 1; row < rows; row++) {
    const link = uri(row);
    if (link.length > MAX_MARKER_URI || !/^[A-Za-z0-9._~%:=&?-]+$/.test(link)) return undefined;
    if (row === 0) out[0] = `${out[0]}\x1b[${cols}C${markerCell(link)}`;
    else if (out[row] === "") out[row] = `${" ".repeat(cols)}${markerCell(link)}`;
    else return undefined;
  }
  return out;
}

/** Whether markers are written: an explicit PI_IMAGES_TERMINAL_REFS=0|1, else Kitty images in a herdr pane. */
export function markersEnabled(env: NodeJS.ProcessEnv = process.env, imageProtocol = getCapabilities().images): boolean {
  if (imageProtocol !== "kitty") return false;
  const override = env.PI_IMAGES_TERMINAL_REFS?.trim();
  if (override === "0" || override === "1") return override === "1";
  return env.TERM_PROGRAM === "herdr";
}

/** The patch shared by every runtime of this process (reload re-imports this module, not pi-tui). */
function patchState(): PatchState {
  const proto = Image.prototype as unknown as Record<symbol, PatchState | undefined> & { render: Image["render"] };
  let state = proto[PATCH];
  if (!state) {
    state = { original: proto.render };
    const shared = state;
    proto[PATCH] = shared;
    proto.render = function render(this: Image, width: number): string[] {
      const lines = shared.original.call(this, width);
      if (!shared.provider) return lines;
      try { return shared.provider(this, lines) ?? lines; } catch { return lines; }
    };
  }
  return state;
}

/** Install a marker provider; returns an idempotent function that removes it again. */
export function installMarkerProvider(provider: MarkerProvider): () => void {
  const state = patchState();
  const owner = Symbol("provider");
  state.provider = provider;
  state.owner = owner;
  return () => {
    if (state.owner !== owner) return;
    state.provider = undefined;
    state.owner = undefined;
  };
}

interface Rendered { source: string[]; key: string; lines: string[] }

/** Writes terminal image references for this session's tool-result images (see module comment). */
export function registerTerminalImageRefs(pi: ExtensionAPI, options: { env?: NodeJS.ProcessEnv } = {}): void {
  const index = new ImageRefIndex();
  let session: string | undefined;
  let uninstall: (() => void) | undefined;
  const digests = new WeakMap<Image, { data: string; digest: string }>();
  /** Ref lookups per component, valid while its data, the session and the index are unchanged. */
  const lookups = new WeakMap<Image, { data: string; session: string; version: number; ref: string | undefined }>();
  const rendered = new WeakMap<Image, Rendered>();

  const provider: MarkerProvider = (image, lines) => {
    const data = (image as unknown as { base64Data?: unknown }).base64Data;
    if (!session || typeof data !== "string") return undefined;
    let ref: string | undefined;
    const file = fileImages().get(image);
    if (file !== undefined) {
      const mimeType = (image as unknown as { mimeType?: unknown }).mimeType;
      ref = typeof mimeType === "string" && SERVED_TYPES.has(mimeType) ? fileImageRef(file) : undefined;
    } else {
      let lookup = lookups.get(image);
      if (lookup?.data !== data || lookup.session !== session || lookup.version !== index.version) {
        lookups.set(image, lookup = { data, session, version: index.version, ref: index.find(data) });
      }
      ref = lookup.ref;
    }
    if (!ref) return undefined;
    let digest = digests.get(image);
    if (digest?.data !== data) digests.set(image, digest = { data, digest: imageDigest(data) });
    const key = `${session}\n${ref}\n${digest.digest}`;
    const cached = rendered.get(image);
    if (cached?.source === lines && cached.key === key) return cached.lines;
    const placement = kittyPlacement(lines[0] ?? "");
    const out = placement && addMarkers(lines, (row) => markerUri({ session: session!, ref, digest: digest!.digest,
      cols: placement.cols, rows: placement.rows, row }));
    if (!out) return undefined;
    rendered.set(image, { source: lines, key, lines: out });
    return out;
  };

  const stop = () => {
    uninstall?.();
    uninstall = undefined;
    session = undefined;
    index.clear();
  };
  const sync = (ctx: ExtensionContext) => {
    session = ctx.sessionManager.getSessionId();
    index.rebuild(ctx.sessionManager.getBranch());
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI || !markersEnabled(options.env ?? process.env)) return;
    sync(ctx);
    uninstall = installMarkerProvider(provider);
  });
  pi.on("session_tree", (_event, ctx) => { if (uninstall) sync(ctx); });
  // The interactive transcript draws a tool's images from this event's result.
  pi.on("tool_execution_end", (event) => {
    if (uninstall && !event.parentToolCallId) index.add(event.toolCallId, (event.result as { content?: unknown } | undefined)?.content);
  });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: unknown; toolCallId?: unknown; content?: unknown };
    if (uninstall && message.role === "toolResult" && typeof message.toolCallId === "string") index.add(message.toolCallId, message.content);
  });
  pi.on("session_shutdown", () => stop());
}
