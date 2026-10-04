import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantImages, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerateImageTool, resolveImagePath, sniffImageMime } from "../src/tool.ts";

// 1x1 PNG and a 3-byte JPEG header are enough for MIME sniffing and size parsing.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString("base64");
const model = { type: "image", provider: "cliproxyapi-images", id: "gpt-image-2.5", input: ["text", "image"] };

let cwd: string;
let outputDir: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-images-tool-"));
  outputDir = join(cwd, "out");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function setup(result: Partial<AssistantImages> = {}, branch: unknown[] = []) {
  const generateImages = vi.fn(async (_model: unknown, _context: ImagesContext, _options?: ImagesOptions): Promise<AssistantImages> => ({
    api: "openai-images", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    output: [{ type: "image", mimeType: "image/png", data: PNG }],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...result,
  }));
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      getModelOfType: (_type: string, provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getModelsOfType: () => [model],
      generateImages,
    },
  } as unknown as ExtensionToolContext;
  const tool = createGenerateImageTool({ defaultModel: `${model.provider}/${model.id}`, timeoutMs: 1000, outputDir });
  const run = (params: Parameters<typeof tool.execute>[1]) => tool.execute("call-1", params, undefined, undefined, ctx);
  return { tool, run, generateImages };
}

describe("generate_image tool", () => {
  it("saves, reports and returns the generated image so the TUI shows it", async () => {
    const { run, generateImages } = setup();
    const result = await run({ prompt: "a red dot", background: "transparent", size: "1024x1024" });
    expect(generateImages.mock.calls[0]![1]).toEqual({ input: [{ type: "text", text: "a red dot" }] });
    expect(generateImages.mock.calls[0]![2]).toMatchObject({ timeoutMs: 1000, metadata: { background: "transparent", size: "1024x1024" } });
    const saved = result.details!.images[0]!;
    expect(saved).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    expect(saved.path.startsWith(outputDir)).toBe(true);
    expect(readFileSync(saved.path).toString("base64")).toBe(PNG);
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("(1x1)") });
    expect(result.usage?.totalTokens).toBe(3);
  });

  it("uses image files and attached images as references", async () => {
    writeFileSync(join(cwd, "photo.jpg"), Buffer.from(JPEG, "base64"));
    const attached = [{ type: "text", text: "make it blue" }, { type: "image", mimeType: "image/png", data: "QQ==" },
      { type: "image", mimeType: "image/png", data: "Qg==" }];
    const branch = [{ type: "message", message: { role: "user", content: attached } },
      { type: "message", message: { role: "user", content: "no images here" } }];
    const { run, generateImages } = setup({}, branch);
    await run({ prompt: "edit", references: ["@photo.jpg", "attached:2", "attached"] });
    expect(generateImages.mock.calls[0]![1].input).toEqual([
      { type: "text", text: "edit" },
      { type: "image", mimeType: "image/jpeg", data: JPEG },
      attached[2], attached[1], attached[2],
    ]);
  });

  it("writes to the requested path with the extension of the produced format", async () => {
    const { run } = setup({ output: [{ type: "image", mimeType: "image/png", data: PNG }, { type: "image", mimeType: "image/jpeg", data: JPEG }] });
    const result = await run({ prompt: "two", path: "art/hero.jpg" });
    expect(result.details!.images.map((image) => image.path)).toEqual([join(cwd, "art/hero.png"), join(cwd, "art/hero-2.jpg")]);
    expect(result.content[0]).toMatchObject({ text: "Saved art/hero.png (1x1)\nSaved art/hero-2.jpg" });
  });

  it("fails clearly for bad references, unknown models and provider errors", async () => {
    writeFileSync(join(cwd, "notes.txt"), "hello");
    const { run } = setup({ stopReason: "error", errorMessage: "gateway down", output: [] });
    await expect(run({ prompt: "x", references: ["missing.png"] })).rejects.toThrow("not found");
    await expect(run({ prompt: "x", references: ["notes.txt"] })).rejects.toThrow("not a PNG");
    await expect(run({ prompt: "x", references: ["attached"] })).rejects.toThrow("No image is attached");
    await expect(run({ prompt: "x", model: "other/model" })).rejects.toThrow("Available: cliproxyapi-images/gpt-image-2.5");
    await expect(run({ prompt: "x" })).rejects.toThrow("gateway down");
  });
});

describe("helpers", () => {
  it("sniffs image types and resolves pasted paths", () => {
    expect(sniffImageMime(Buffer.from(PNG, "base64"))).toBe("image/png");
    expect(sniffImageMime(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("text"))).toBeUndefined();
    expect(resolveImagePath("/work", "'/tmp/a b.png'")).toBe("/tmp/a b.png");
    expect(resolveImagePath("/work", "@img/a.png")).toBe("/work/img/a.png");
    expect(resolveImagePath("/work", "~/a.png")).toBe(join(homedir(), "a.png"));
  });
});

describe("rendering", () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const context = (isError: boolean) => ({ isError }) as never;

  it("wraps long prompts within the width and summarizes results", () => {
    const { tool } = setup();
    const call = tool.renderCall!({ prompt: "아주 긴 프롬프트 ".repeat(40), references: ["attached"] }, theme, context(false));
    const lines = call.render(30);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.every((line) => line.length <= 30)).toBe(true);
    const done = { content: [{ type: "text" as const, text: "Saved a.png (1x1)" }],
      details: { model: "m", images: [], references: [], elapsedMs: 1500 } };
    expect(tool.renderResult!(done, { expanded: false, isPartial: false }, theme, context(false)).render(80).map((line) => line.trimEnd()))
      .toEqual(["Saved a.png (1x1) · 1.5s"]);
    expect(tool.renderResult!(done, { expanded: false, isPartial: true }, theme, context(false)).render(80).map((line) => line.trimEnd()))
      .toEqual(["Generating image…"]);
  });
});
