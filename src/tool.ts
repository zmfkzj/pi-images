import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Type, type ImageContent, type ImagesContext, type Usage } from "@earendil-works/pi-ai";
import {
  truncateToVisualLines, withFileMutationQueue, type ExtensionContext, type Theme, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "generate_image";
/** Reference images larger than this are rejected before upload. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: "What to draw, or how to change the reference images." }),
  references: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Input images to edit or use as references. Each entry is an image file path (absolute, ~/..., "
      + "or relative to the working directory; pasted clipboard images arrive as such paths), or \"attached\" for "
      + "every image attached to the most recent user message with images, or \"attached:N\" for its N-th image (1-based).",
  })),
  path: Type.Optional(Type.String({ minLength: 1, description:
    "Where to save the result (relative to the working directory). Default: a new file in the system temp directory." })),
  background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
  size: Type.Optional(Type.String({ description: "Requested size such as 1024x1024, 1536x1024, 1024x1536 or auto (the gateway may ignore it)." })),
  quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")])),
  model: Type.Optional(Type.String({ description: "Image model as provider/id. Default: cliproxyapi-images/gpt-image-2.5." })),
});

export interface SavedImage { path: string; mimeType: string; width?: number; height?: number }
export interface GenerateImageDetails { model: string; images: SavedImage[]; references: string[]; elapsedMs: number }

export interface GenerateImageToolOptions {
  /** Default image model as provider/id. */
  defaultModel: string;
  timeoutMs: number;
  /** Directory for results without an explicit path. Default: <tmpdir>/pi-images. */
  outputDir?: string;
}

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

/** Detect the image type from magic bytes, so a misnamed file is still sent with the right MIME type. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || sniffImageMime(bytes) !== "image/png") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Accepts `@path`, quoted paths and `~/` the way users paste them. */
export function resolveImagePath(cwd: string, raw: string): string {
  let path = raw.trim().replace(/^@/, "");
  if (/^(["']).*\1$/.test(path)) path = path.slice(1, -1);
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Image blocks of the most recent user message in the current branch that has any. */
export function latestAttachedImages(ctx: Pick<ExtensionContext, "sessionManager">): ImageContent[] {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const images = message.content.filter((block): block is ImageContent =>
      !!block && typeof block === "object" && (block as { type?: unknown }).type === "image");
    if (images.length) return images;
  }
  return [];
}

async function loadReferences(references: readonly string[], ctx: ExtensionContext): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  let attached: ImageContent[] | undefined;
  for (const reference of references) {
    const match = /^attached(?::(\d+))?$/i.exec(reference.trim());
    if (match) {
      attached ??= latestAttachedImages(ctx);
      if (!attached.length) throw new Error("No image is attached to a user message in this conversation; pass an image file path instead.");
      if (match[1] === undefined) { images.push(...attached); continue; }
      const index = Number(match[1]);
      const image = attached[index - 1];
      if (!image) throw new Error(`${reference}: the latest user message has ${attached.length} attached image(s).`);
      images.push(image);
      continue;
    }
    const path = resolveImagePath(ctx.cwd, reference);
    let size: number;
    try { size = (await stat(path)).size; } catch { throw new Error(`Reference image not found: ${path}`); }
    if (size > MAX_REFERENCE_BYTES) throw new Error(`Reference image is larger than ${MAX_REFERENCE_BYTES / 1024 / 1024} MiB: ${path}`);
    const bytes = await readFile(path);
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) throw new Error(`Reference is not a PNG, JPEG, WebP or GIF image: ${path}`);
    images.push({ type: "image", data: bytes.toString("base64"), mimeType });
  }
  return images;
}

/** The output path for result `index`, with the extension of the produced format. */
function outputPath(requested: string | undefined, index: number, count: number, mimeType: string,
  cwd: string, outputDir: string, stamp: string): string {
  const extension = EXTENSIONS[mimeType] ?? ".bin";
  if (!requested) return join(outputDir, `image-${stamp}${count > 1 ? `-${index + 1}` : ""}${extension}`);
  const target = resolveImagePath(cwd, requested);
  const base = extname(target) ? target.slice(0, -extname(target).length) : target;
  return `${base}${count > 1 && index > 0 ? `-${index + 1}` : ""}${extension}`;
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Wraps styled text to the render width, capped to a few visual lines. */
function lines(text: string, maxLines = 6) {
  return {
    render: (width: number) => truncateToVisualLines(text, maxLines, Math.max(1, width), 0, "start").visualLines,
    invalidate: () => {},
  };
}

function renderCall(args: { prompt?: string; references?: string[]; path?: string }, theme: Theme) {
  let text = theme.fg("toolTitle", theme.bold("generate_image "));
  text += theme.fg("muted", (args.prompt ?? "").replace(/\s+/g, " ").trim());
  if (args.references?.length) text += "\n" + theme.fg("dim", `references: ${args.references.join(", ")}`);
  if (args.path) text += "\n" + theme.fg("dim", `→ ${args.path}`);
  return lines(text);
}

export function createGenerateImageTool(options: GenerateImageToolOptions): ToolDefinition<typeof parameters, GenerateImageDetails | undefined> {
  return {
    name: TOOL_NAME,
    label: "Generate image",
    description: "Generate an image from a text prompt, or edit/restyle reference images. The result is saved to a file, "
      + "shown in the terminal, and returned to you as an image. Reference images can be file paths (including images "
      + "the user pasted, which appear as file paths in their message) or images attached to the latest user message.",
    promptSnippet: "Generate or edit raster images (shown inline in the terminal)",
    promptGuidelines: [
      "When the user asks to draw, create or edit a picture, use generate_image; pass the images they provided in references.",
      "Generation can take a few minutes. Reuse the saved path from a previous result as a reference to iterate on it.",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const started = Date.now();
      signal?.throwIfAborted();
      const modelName = params.model?.trim() || options.defaultModel;
      const slash = modelName.indexOf("/");
      if (slash <= 0 || slash === modelName.length - 1) throw new Error(`Image model must be provider/id, got "${modelName}".`);
      const model = ctx.modelRegistry.getModelOfType("image", modelName.slice(0, slash), modelName.slice(slash + 1));
      if (!model) {
        const known = ctx.modelRegistry.getModelsOfType("image").map((m) => `${m.provider}/${m.id}`);
        throw new Error(`Unknown image model ${modelName}.${known.length ? ` Available: ${known.join(", ")}` : ""}`);
      }
      const references = params.references ?? [];
      const input: ImagesContext["input"] = [{ type: "text", text: params.prompt }, ...await loadReferences(references, ctx)];
      if (input.length > 1 && !model.input.includes("image")) throw new Error(`${modelName} does not accept image input.`);
      const metadata: Record<string, string> = {};
      for (const name of ["background", "size", "quality"] as const) if (params[name]) metadata[name] = params[name]!;
      signal?.throwIfAborted();
      const response = await ctx.modelRegistry.generateImages(model, { input }, { signal, timeoutMs: options.timeoutMs, metadata });
      const usage: Usage | undefined = response.usage;
      if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Image generation ${response.stopReason}.`);
      const outputs = response.output.filter((block): block is ImageContent => block.type === "image");
      if (!outputs.length) throw new Error("The image model returned no image.");
      const stamp = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${randomUUID().slice(0, 8)}`;
      const outputDir = options.outputDir ?? join(tmpdir(), "pi-images");
      const saved: SavedImage[] = [];
      for (const [index, image] of outputs.entries()) {
        const bytes = Buffer.from(image.data, "base64");
        const mimeType = sniffImageMime(bytes) ?? image.mimeType;
        const target = outputPath(params.path, index, outputs.length, mimeType, ctx.cwd, outputDir, stamp);
        await withFileMutationQueue(target, async () => {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
        });
        saved.push({ path: target, mimeType, ...pngSize(bytes) });
      }
      const texts = response.output.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean);
      const summary = saved.map((image) => `Saved ${displayPath(ctx.cwd, image.path)}`
        + (image.width ? ` (${image.width}x${image.height})` : "")).join("\n");
      return {
        content: [
          { type: "text", text: [summary, ...texts].join("\n") },
          ...outputs.map((image, i) => ({ ...image, mimeType: saved[i]!.mimeType })),
        ],
        details: { model: modelName, images: saved, references, elapsedMs: Date.now() - started },
        ...(usage ? { usage } : {}),
      };
    },
    renderCall: (args, theme) => renderCall(args, theme),
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return lines(theme.fg("muted", "Generating image…"));
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (context.isError) return lines(theme.fg("error", text || "Image generation failed."));
      const details = result.details;
      const seconds = details ? theme.fg("dim", ` · ${(details.elapsedMs / 1000).toFixed(1)}s`) : "";
      return lines(theme.fg("success", text) + seconds);
    },
  };
}
