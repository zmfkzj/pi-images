import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENTS_CHANNEL, clipboardPasteKey, imagePathsInText, pastedImagePaths, registerPastedImages, splitPastedWords } from "../src/paste.ts";
import { halvesPng } from "./png-fixture.ts";

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
  function setup(commands: { name: string; source: string }[] = [], options: { env?: NodeJS.ProcessEnv; mode?: string } = {}) {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const appendEntry = vi.fn();
    let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
    const channels = new Map<string, (data: unknown) => void>();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => any) => { handlers.set(name, handler); },
      registerEntryRenderer: (_type: string, fn: typeof renderer) => { renderer = fn; },
      appendEntry,
      getCommands: () => commands,
      events: { on: (channel: string, handler: (data: unknown) => void) => { channels.set(channel, handler); return () => channels.delete(channel); } },
    } as unknown as ExtensionAPI;
    registerPastedImages(pi, { env: options.env ?? {} });
    let editorText = "";
    let input: ((data: string) => { data?: string } | undefined) | undefined;
    const setWidget = vi.fn();
    const ctx = {
      hasUI: true,
      mode: options.mode,
      cwd: dir,
      ui: {
        onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; },
        getEditorText: () => editorText,
        setWidget,
      },
    };
    handlers.get("session_start")!({ type: "session_start" }, ctx);
    const emit = (name: string, event: any) => handlers.get(name)!(event, ctx);
    /** What another extension (session-bus's queue) gets on ATTACHMENTS_CHANNEL for a prompt it holds back. */
    const request = (text: string, existing: unknown[] = []) => {
      let provided: unknown[] | undefined;
      channels.get(ATTACHMENTS_CHANNEL)!({ text, cwd: dir, existing, provide: (images: unknown[]) => { provided = images; } });
      return provided;
    };
    return {
      ctx, setWidget, appendEntry, emit, request,
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

  it("provides the images of a prompt that another extension holds back, ends its paste state, and never doubles them", () => {
    vi.useFakeTimers();
    const { setWidget, appendEntry, emit, type, setText, request } = setup([{ name: "review", source: "prompt" }]);
    const image = { type: "image", data: PNG, mimeType: "image/png" };
    const rpc = { type: "image", data: "QUJD", mimeType: "image/png" };
    type(`\x1b[200~${png}\x1b[201~`, `${png} what is this?`);
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    setText(""); // submitted
    // session-bus's queue asks before the input chain reaches this extension, then holds the prompt back.
    expect(request(`${png} what is this?`, [rpc])).toEqual([image]);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
    // The paste is over: the same path typed later is not an image paste, and the replayed message is an extension's.
    expect(request(`${png} again`)).toEqual([]);
    expect(emit("input", { type: "input", text: `${png} what is this?`, source: "extension", images: [rpc, image] })).toEqual({ action: "continue" });
    // A clipboard file is recognized by name, so a prompt that already carries its image does not get it again.
    const clip = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(clip, Buffer.from(PNG, "base64"));
    expect(request(`compare ${clip}`, [image])).toEqual([]);
    expect(request(`/review ${clip}`)).toEqual([]);
    // A prompt that runs at once arrives with the provided image: nothing is added, and the transcript shows it.
    expect(request(`compare ${clip}`)).toEqual([image]);
    expect(emit("input", { type: "input", text: `compare ${clip}`, source: "interactive", images: [image] })).toEqual({ action: "continue" });
    emit("message_end", { message: { role: "user", content: [{ type: "text", text: "x" }, image] } });
    emit("agent_end", {});
    expect(appendEntry).toHaveBeenCalledWith("pasted-images", { paths: [clip] });
  });

  it("clears the preview when a real slash command is submitted with Enter", () => {
    vi.useFakeTimers();
    const { setWidget, emit, type } = setup([{ name: "review", source: "prompt" }]);
    type(`\x1b[200~${png}\x1b[201~`, `/review ${png}`);
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    // Pi's editor empties itself before it submits; the command is not given the image.
    type("\r", "");
    expect(emit("input", { type: "input", text: `/review ${png}`, source: "interactive" })).toEqual({ action: "continue" });
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
  });

  it("does not attach typed paths or ordinary text pastes", () => {
    const { emit, type } = setup();
    type(`\x1b[200~see ${png}\x1b[201~`, `see ${png}`);
    expect(emit("input", { type: "input", text: `see ${png}`, source: "interactive" })).toEqual({ action: "continue" });
  });

  it("attaches an image whose path starts the message or is the whole message", () => {
    vi.useFakeTimers();
    const { setWidget, emit, type, setText } = setup();
    const clip = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(clip, Buffer.from(PNG, "base64"));
    const image = { type: "image", data: PNG, mimeType: "image/png" };
    // Ctrl+V into an empty editor inserts the clipboard file's absolute path; the description follows it.
    type("\x16", "");
    setText(`${clip} describe this`);
    vi.advanceTimersByTime(100);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    expect(emit("input", { type: "input", text: `${clip} describe this`, source: "interactive" }))
      .toEqual({ action: "transform", text: `${clip} describe this`, images: [image] });
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
    expect(emit("input", { type: "input", text: clip, source: "interactive" }))
      .toEqual({ action: "transform", text: clip, images: [image] });
  });

  it("attaches a dropped image whose path starts the message and then forgets the paste", () => {
    vi.useFakeTimers();
    const { setWidget, emit, type, setText } = setup();
    type(`\x1b[200~${png}\x1b[201~`, `${png} what is this?`);
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    setText(""); // Pi clears the editor before the input event
    expect(emit("input", { type: "input", text: `${png} what is this?`, source: "interactive" }))
      .toEqual({ action: "transform", text: `${png} what is this?`, images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
    vi.advanceTimersByTime(3000);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
    // Only the paste made the path an image paste: the same path typed into the next message is not attached.
    expect(emit("input", { type: "input", text: `${png} again`, source: "interactive" })).toEqual({ action: "continue" });
  });

  it("leaves slash commands, shell commands and extension messages alone", () => {
    const { emit } = setup([{ name: "review", source: "prompt" }, { name: "skill:demo", source: "skill" }]);
    const clip = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(clip, Buffer.from(PNG, "base64"));
    for (const text of [`/review ${clip}`, `/review\n${clip}`, `/skill:demo ${clip}`, `!ls ${clip}`, `  !!file ${clip}`]) {
      expect(emit("input", { type: "input", text, source: "interactive" })).toEqual({ action: "continue" });
    }
    expect(emit("input", { type: "input", text: `${clip} describe`, source: "extension" })).toEqual({ action: "continue" });
    // Text that merely starts with a slash is sent to the model as typed, so its images are attached.
    expect(emit("input", { type: "input", text: `/reviewer ${clip}`, source: "interactive" }))
      .toMatchObject({ action: "transform", images: [{ type: "image", mimeType: "image/png" }] });
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

  it("still picks up a clipboard image that Pi inserts while the user keeps typing, and drops it with its path", () => {
    vi.useFakeTimers();
    const { setWidget, type, setText } = setup();
    const clip = join(dir, `pi-clipboard-${randomUUID()}.png`);
    writeFileSync(clip, Buffer.from(PNG, "base64"));
    type("\x16", "");
    vi.advanceTimersByTime(50);
    expect(type("a", "a")).toBeUndefined(); // typing goes on before the clipboard read finishes
    vi.advanceTimersByTime(10);
    expect(setWidget).not.toHaveBeenCalled();
    setText(`a ${clip}`); // inserted after the last keystroke
    vi.advanceTimersByTime(400);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
    type("\x7f", "a "); // the path is deleted again
    vi.advanceTimersByTime(0);
    expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
  });

  describe("in a herdr pane (cell previews)", () => {
    const herdr = { TERM_PROGRAM: "herdr" };
    const theme = { fg: (_c: string, s: string) => s };
    /** A red cell then a blue one: the picture itself, as colored half blocks. */
    const PICTURE = /\x1b\[38;2;255;0;0m(?:\x1b\[48;2;255;0;0m)?\u2580.*\x1b\[38;2;0;0;255m(?:\x1b\[48;2;0;0;255m)?\u2580/;
    const pictureRows = (lines: string[]) => lines.filter((line) => PICTURE.test(line)).length;
    let screenshot: string;
    beforeEach(() => {
      screenshot = join(dir, "paste-20261016-222317-fc181c35.png");
      writeFileSync(screenshot, halvesPng(300, 190));
    });

    it("shows the draft image while typing and the submitted image in the transcript, without Kitty graphics", async () => {
      vi.useFakeTimers();
      const { setWidget, appendEntry, emit, type, render } = setup([], { env: herdr });
      // herdr-web-ui uploads a pasted image and pastes its quoted path.
      type(`\x1b[200~'${screenshot}' \x1b[201~`, `'${screenshot}' `);
      vi.advanceTimersByTime(0);
      expect(setWidget).toHaveBeenLastCalledWith("pasted-images", expect.any(Function));
      const tui = { requestRender: vi.fn() };
      const widget = setWidget.mock.lastCall![1](tui, theme);
      expect(widget.render(80).join("\n")).toContain("image paste-20261016-222317-fc181c35.png");
      await vi.waitFor(() => expect(tui.requestRender).toHaveBeenCalled());
      const draft = widget.render(80);
      expect(pictureRows(draft)).toBe(10);
      expect(draft.join("")).not.toContain("\x1b_G");
      for (const width of [80, 30]) for (const line of widget.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

      // Typing goes on: keys reach the editor, and the preview is not rebuilt.
      const calls = setWidget.mock.calls.length;
      expect(type("w", `'${screenshot}' w`)).toBeUndefined();
      vi.advanceTimersByTime(0);
      expect(setWidget.mock.calls.length).toBe(calls);

      const text = `'${screenshot}' what is this?`;
      const result = emit("input", { type: "input", text, source: "interactive" });
      expect(result).toEqual({ action: "transform", text, images: [{ type: "image", data: halvesPng(300, 190).toString("base64"), mimeType: "image/png" }] });
      expect(setWidget).toHaveBeenLastCalledWith("pasted-images", undefined);
      emit("message_end", { message: { role: "user", content: [{ type: "text", text }, result.images[0]] } });
      emit("message_start", { message: { role: "assistant" } });
      expect(appendEntry).toHaveBeenCalledWith("pasted-images", { paths: [screenshot] });
      // The submitted entry was decoded for the draft already: drawn at once, up to its 15 rows.
      const entry = render({ data: { paths: [screenshot] } }).render(80);
      expect(entry[0]).toContain("image paste-20261016-222317-fc181c35.png");
      expect(pictureRows(entry)).toBe(15);
      expect(entry.join("")).not.toContain("\x1b_G");
    });

    it("redraws a resumed transcript entry once decoded and removes its render hook on shutdown", async () => {
      const { setWidget, emit, render } = setup([], { env: herdr, mode: "tui" });
      const hook = setWidget.mock.calls.find((call) => call[0] === "pasted-images-render")!;
      expect(hook[2]).toEqual({ placement: "belowEditor" });
      const tui = { requestRender: vi.fn() };
      expect(hook[1](tui, theme).render(80)).toEqual([]);
      const resumed = join(dir, "resumed.png");
      writeFileSync(resumed, halvesPng(64, 32));
      const entry = render({ data: { paths: [resumed, join(dir, "gone.png")] } });
      expect(pictureRows(entry.render(80))).toBe(0);
      await vi.waitFor(() => expect(tui.requestRender).toHaveBeenCalled());
      const lines = entry.render(80);
      expect(pictureRows(lines)).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain(`image unavailable: ${join(dir, "gone.png")}`);
      emit("session_shutdown", {});
      expect(setWidget).toHaveBeenCalledWith("pasted-images-render", undefined);
    });

    it("keeps Pi's own image outside herdr and with PI_IMAGES_CELL_PREVIEWS=0", () => {
      for (const env of [{}, { TERM_PROGRAM: "ghostty" }, { ...herdr, PI_IMAGES_CELL_PREVIEWS: "0" }]) {
        const { setWidget, render } = setup([], { env, mode: "tui" });
        expect(setWidget).not.toHaveBeenCalled();
        const entry = render({ data: { paths: [screenshot] } });
        expect(entry.children[1]).toBeInstanceOf(Image);
        expect(pictureRows(entry.render(80))).toBe(0);
      }
    });
  });
});
