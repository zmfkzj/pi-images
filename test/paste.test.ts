import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboardPasteKey, imagePathsInText, pastedImagePaths, registerPastedImages, splitPastedWords } from "../src/paste.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let dir: string;
let png: string;
let spaced: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-images-paste-"));
  png = join(dir, "shot.png");
  spaced = join(dir, "my shot.png");
  writeFileSync(png, Buffer.from(PNG, "base64"));
  writeFileSync(spaced, Buffer.from(PNG, "base64"));
  writeFileSync(join(dir, "notes.txt"), "hello");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("paste parsing", () => {
  it("splits pasted words like a shell", () => {
    expect(splitPastedWords("/a/b.png  '/c d.png'\n/e\\ f.png")).toEqual(["/a/b.png", "/c d.png", "/e f.png"]);
    expect(splitPastedWords("'unterminated")).toBeUndefined();
  });

  it("accepts pastes made only of existing image paths", () => {
    expect(pastedImagePaths(dir, png)).toEqual([png]);
    expect(pastedImagePaths(dir, ` ${spaced.replace(/ /g, "\\ ")}\n`)).toEqual([spaced]);
    expect(pastedImagePaths(dir, `"${spaced}" @shot.png file://${png}`)).toEqual([spaced, png, png]);
    expect(pastedImagePaths(dir, `look at ${png}`)).toBeUndefined();
    expect(pastedImagePaths(dir, join(dir, "missing.png"))).toBeUndefined();
    expect(pastedImagePaths(dir, join(dir, "notes.txt"))).toBeUndefined();
    expect(pastedImagePaths(dir, "")).toBeUndefined();
  });

  it("finds pasted paths and clipboard files in the editor text", () => {
    const herdrDir = join(dir, "herdr-clipboard-images-1000");
    mkdirSync(herdrDir);
    const herdr = join(herdrDir, "client-2-clipboard-1-0.png");
    const pi = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(herdr, Buffer.from(PNG, "base64"));
    writeFileSync(pi, Buffer.from(PNG, "base64"));
    const pastes = new Map([[`'${spaced}'`, [spaced]]]);
    expect(imagePathsInText(dir, `${herdr} what is '${spaced}' and ${pi}? ${png}`, pastes)).toEqual([spaced, herdr, pi]);
    expect(imagePathsInText(dir, png, new Map())).toEqual([]);
  });

  it("maps Cmd+V and empty pastes to Pi's clipboard paste key", () => {
    expect(clipboardPasteKey("\x1b[118;9u")).toBe("\x16");
    expect(clipboardPasteKey("\x1b[200~\x1b[201~")).toBe("\x16");
    expect(clipboardPasteKey("\x1b[118;9:3u")).toBeUndefined();
    expect(clipboardPasteKey("v")).toBeUndefined();
    expect(clipboardPasteKey("\x1b[200~text\x1b[201~")).toBeUndefined();
  });
});

describe("registerPastedImages", () => {
  function setup() {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const appendEntry = vi.fn();
    let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => any) => { handlers.set(name, handler); },
      registerEntryRenderer: (_type: string, fn: typeof renderer) => { renderer = fn; },
      appendEntry,
    } as unknown as ExtensionAPI;
    registerPastedImages(pi);
    let editorText = "";
    let input: ((data: string) => { data?: string } | undefined) | undefined;
    const setWidget = vi.fn();
    const ctx = {
      hasUI: true,
      cwd: dir,
      ui: {
        onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; },
        getEditorText: () => editorText,
        setWidget,
      },
    };
    handlers.get("session_start")!({ type: "session_start" }, ctx);
    const emit = (name: string, event: any) => handlers.get(name)!(event, ctx);
    return {
      ctx, setWidget, appendEntry, emit,
      type: (data: string, text: string) => { const result = input!(data); editorText = text; return result; },
      setText: (text: string) => { editorText = text; },
      render: (entry: any) => renderer!(entry, { expanded: false }, { fg: (_c: string, s: string) => s }),
    };
  }

  it("previews a pasted image at once, attaches it and keeps it in the transcript", () => {
    vi.useFakeTimers();
    const { setWidget, appendEntry, emit, type, render } = setup();
    expect(type(`\x1b[200~${png}\x1b[201~`, `what is ${png}`)).toBeUndefined();
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    const theme = { fg: (_c: string, s: string) => s };
    expect(setWidget.mock.lastCall![1](undefined, theme).render(80).join("\n")).toContain("shot.png");

    const result = emit("input", { type: "input", text: `what is ${png}`, source: "interactive" });
    expect(result).toEqual({ action: "transform", text: `what is ${png}`,
      images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);

    emit("message_start", { message: { role: "user" } });
    emit("message_end", { message: { role: "user", content: [{ type: "text", text: "x" }, result.images[0]] } });
    expect(appendEntry).not.toHaveBeenCalled();
    emit("message_start", { message: { role: "assistant" } });
    expect(appendEntry).toHaveBeenCalledWith("pasted-images", { paths: [png] });
    expect(render({ data: { paths: [png, join(dir, "gone.png")] } }).render(80).join("\n")).toContain("image unavailable");
  });

  it("does not attach typed paths or ordinary text pastes", () => {
    const { emit, type } = setup();
    type(`\x1b[200~see ${png}\x1b[201~`, `see ${png}`);
    expect(emit("input", { type: "input", text: `see ${png}`, source: "interactive" })).toEqual({ action: "continue" });
  });

  it("turns Cmd+V into Pi's clipboard paste and picks up the inserted file", () => {
    vi.useFakeTimers();
    const { setWidget, type, setText } = setup();
    const clip = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(clip, Buffer.from(PNG, "base64"));
    expect(type("\x1b[118;9u", "")).toEqual({ data: "\x16" });
    vi.advanceTimersByTime(50);
    expect(setWidget).not.toHaveBeenCalled();
    setText(clip); // Pi's asynchronous clipboard read inserted the file
    vi.advanceTimersByTime(400);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
  });
});
