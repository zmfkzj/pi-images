import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, isKeyRelease, matchesKey, Text, type Component } from "@earendil-works/pi-tui";
import { MAX_REFERENCE_BYTES, sniffImageMime } from "./tool.ts";

/** Session entry type that shows the images of a submitted message in the transcript. */
export const PASTED_IMAGES_ENTRY = "pasted-images";
const WIDGET_KEY = "pasted-images";
const MAX_IMAGES = 8;
const MAX_PASTE_LENGTH = 8192;
/** Pi's own Ctrl+V reads the clipboard asynchronously, so the editor is checked again for a while. */
const RESCAN_DELAYS_MS = [0, 100, 400, 1200, 3000];
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i;
/** Files that Pi's clipboard paste and herdr's remote image bridge create. */
const CLIPBOARD_FILE = /[/\\](?:pi-clipboard-[\da-f-]+|herdr-clipboard-images-\d+[/\\][^/\\]+)\.(?:png|jpe?g|webp|gif)$/i;
/** Keyboard-protocol terminals report Cmd+V as super+v; image-only clipboards often paste nothing. */
const PASTE_KEY = "\x16";
const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

export interface PastedImage { path: string; data: string; mimeType: string }

/** Splits pasted text into shell-like words: quotes and backslash escapes, as terminals use for dropped files. */
export function splitPastedWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < text.length && !/[\w.]/.test(text[i + 1]!)) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function imageFilePath(cwd: string, word: string): string | undefined {
  let path = word.replace(/^@/, "");
  if (/^file:\/\//i.test(path)) {
    try { path = fileURLToPath(path); } catch { return undefined; }
  }
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  if (!IMAGE_EXTENSION.test(path)) return undefined;
  path = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0 && stats.size <= MAX_REFERENCE_BYTES ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The image files of a paste that consists only of image paths (clipboard bridges and file drops),
 * or undefined for any other paste.
 */
export function pastedImagePaths(cwd: string, content: string): string[] | undefined {
  if (!content.trim() || content.length > MAX_PASTE_LENGTH) return undefined;
  const words = splitPastedWords(content);
  if (!words?.length || words.length > MAX_IMAGES) return undefined;
  const paths: string[] = [];
  for (const word of words) {
    const path = imageFilePath(cwd, word);
    if (!path) return undefined;
    paths.push(path);
  }
  return paths;
}

/** Image paths of `text` that were pasted (`pastes`: pasted text → its paths) or are clipboard files. */
export function imagePathsInText(cwd: string, text: string, pastes: ReadonlyMap<string, string[]>): string[] {
  const found = new Set<string>();
  for (const [pasted, paths] of pastes) if (text.includes(pasted)) for (const path of paths) found.add(path);
  for (const raw of text.split(/\s+/)) {
    // Prose punctuation around a path: "(see /tmp/x.png)?"
    const word = raw.replace(/^[("'`]+/, "").replace(/[)"'`,.;:!?]+$/, "");
    if (!CLIPBOARD_FILE.test(word)) continue;
    const path = imageFilePath(cwd, word);
    if (path) found.add(path);
  }
  return [...found].slice(0, MAX_IMAGES);
}

const imageCache = new Map<string, { key: string; image: PastedImage | undefined }>();

/** Reads a supported image file, or undefined when it is missing, too large or not an image. */
export function readPastedImage(path: string): PastedImage | undefined {
  let key: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_REFERENCE_BYTES) return undefined;
    key = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return undefined;
  }
  const cached = imageCache.get(path);
  if (cached?.key === key) return cached.image;
  let image: PastedImage | undefined;
  try {
    const bytes = readFileSync(path);
    const mimeType = sniffImageMime(bytes);
    image = mimeType ? { path, data: bytes.toString("base64"), mimeType } : undefined;
  } catch {
    image = undefined;
  }
  imageCache.delete(path);
  imageCache.set(path, { key, image });
  if (imageCache.size > 16) imageCache.delete(imageCache.keys().next().value!);
  return image;
}

/** A column of image previews; files that are gone are listed by path. */
export function imagesComponent(paths: readonly string[], theme: Theme, maxHeightCells: number): Component {
  const container = new Container();
  for (const path of paths) {
    const image = readPastedImage(path);
    if (!image) {
      container.addChild(new Text(theme.fg("dim", `image unavailable: ${path}`), 1, 0));
      continue;
    }
    container.addChild(new Text(theme.fg("dim", `image ${basename(path)}`), 1, 0));
    container.addChild(new Image(image.data, image.mimeType, { fallbackColor: (text) => theme.fg("dim", text) },
      { maxWidthCells: 60, maxHeightCells, filename: basename(path) }));
  }
  return container;
}

/**
 * Terminal input rewrite: Cmd+V (super+v) and an empty bracketed paste, which terminals send for an
 * image-only clipboard, become Ctrl+V so Pi pastes the clipboard image. Returns undefined otherwise.
 */
export function clipboardPasteKey(data: string): string | undefined {
  if (data === EMPTY_BRACKETED_PASTE) return PASTE_KEY;
  if (!isKeyRelease(data) && matchesKey(data, "super+v")) return PASTE_KEY;
  return undefined;
}

/**
 * Shows pasted images right away above the editor, attaches them to the submitted message so the
 * model sees them without a read call, and keeps them visible in the transcript.
 */
export function registerPastedImages(pi: ExtensionAPI): void {
  /** Pasted text → image paths, for the message being written. */
  const pastes = new Map<string, string[]>();
  let ui: ExtensionContext["ui"] | undefined;
  let cwd = process.cwd();
  let unsubscribe: (() => void) | undefined;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let shown = "";
  /** Images of the submitted message, rendered once Pi has shown that message. */
  let submitted: string[] | undefined;
  let pendingEntry: string[] | undefined;

  const showPreview = (paths: string[]) => {
    const key = paths.join("\n");
    if (!ui || key === shown) return;
    shown = key;
    if (!paths.length) ui.setWidget(WIDGET_KEY, undefined);
    else ui.setWidget(WIDGET_KEY, (_tui, theme) => imagesComponent(paths, theme, 10));
  };
  const scan = () => {
    if (!ui) return;
    const text = ui.getEditorText();
    for (const pasted of pastes.keys()) if (!text.includes(pasted)) pastes.delete(pasted);
    showPreview(imagePathsInText(cwd, text, pastes));
  };
  const scheduleScans = (delays: readonly number[]) => {
    for (const timer of timers) clearTimeout(timer);
    timers = delays.map((delay) => setTimeout(scan, delay));
  };
  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    ui?.setWidget(WIDGET_KEY, undefined);
    ui = undefined;
    shown = "";
    pastes.clear();
  };
  const flushEntry = () => {
    if (!pendingEntry) return;
    pi.appendEntry(PASTED_IMAGES_ENTRY, { paths: pendingEntry });
    pendingEntry = undefined;
  };

  pi.registerEntryRenderer<{ paths?: string[] }>(PASTED_IMAGES_ENTRY, (entry, _options, theme) =>
    entry.data?.paths?.length ? imagesComponent(entry.data.paths, theme, 15) : undefined);

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (!ctx.hasUI) return;
    ui = ctx.ui;
    cwd = ctx.cwd;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      const key = clipboardPasteKey(data);
      if (key) {
        scheduleScans(RESCAN_DELAYS_MS);
        return { data: key };
      }
      const paste = BRACKETED_PASTE.exec(data)?.[1];
      const paths = paste === undefined ? undefined : pastedImagePaths(cwd, paste);
      if (paths) pastes.set(paste!.trim(), paths);
      // Ctrl+V itself also reads the clipboard asynchronously.
      scheduleScans(paths || matchesKey(data, "ctrl+v") ? RESCAN_DELAYS_MS : [0]);
      return undefined;
    });
  });
  pi.on("session_shutdown", () => stop());

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || /^[!/]/.test(event.text.trimStart())) return { action: "continue" };
    const paths = imagePathsInText(ctx.cwd, event.text, pastes);
    pastes.clear();
    showPreview([]);
    const images: ImageContent[] = [];
    for (const path of paths) {
      const image = readPastedImage(path);
      if (image) images.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    if (!images.length) return { action: "continue" };
    submitted = paths.filter((path) => readPastedImage(path));
    return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
  });

  // The entry follows the user message: it is persisted at that message's end, so append on the next one.
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (!submitted || message.role !== "user" || !Array.isArray(message.content)) return;
    if (message.content.some((block) => (block as { type?: unknown })?.type === "image")) {
      pendingEntry = submitted;
      submitted = undefined;
    }
  });
  pi.on("message_start", (event) => {
    if ((event.message as { role?: string }).role !== "user") flushEntry();
  });
  pi.on("agent_end", () => flushEntry());
}
