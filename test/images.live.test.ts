import { inflateSync } from "node:zlib";
import type { AssistantImages, ImageContent, ImageModel } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createProviderConfig, IMAGE_API, PROVIDER_ID } from "../src/index.ts";

/** Validate PNG header/chunk framing and inflate the complete noninterlaced raster. */
function decodePng(result: AssistantImages): { image: ImageContent; width: number; height: number; alpha: boolean } {
  // Failure assertions never dump payloads, request headers, or credentials.
  if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? "Live images request failed.");
  const image = result.output.find((block): block is ImageContent => block.type === "image");
  if (!image) throw new Error("Live images response contains no image.");
  const png = Buffer.from(image.data, "base64");
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString()).toBe("IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(png[24]).toBe(8); // bit depth
  expect(png[25]).toBe(6); // RGBA
  expect(png[28]).toBe(0); // noninterlaced
  const chunks: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    expect(offset + length + 12 <= png.length).toBe(true);
    const type = png.subarray(offset + 4, offset + 8).toString();
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") { ended = true; break; }
  }
  expect(ended).toBe(true);
  const raster = inflateSync(Buffer.concat(chunks));
  expect(raster.length).toBe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) expect(raster[y * (1 + width * 4)]).toBeLessThanOrEqual(4);
  return { image, width, height, alpha: true };
}

it.skipIf(process.env.LIVE_IMAGES !== "1")("live generation and singular-image multipart edit decode as RGBA PNG", async () => {
  const config = createProviderConfig();
  const definition = config.models![0];
  const model: ImageModel<string> = { ...definition, provider: PROVIDER_ID, type: "image", api: IMAGE_API,
    baseUrl: definition.baseUrl!, output: ["image"] };
  const generate = config.images![IMAGE_API]!.generateImages;
  const generation = decodePng(await generate(model, {
    input: [{ type: "text", text: "A single simple gold coin icon, centered, no text, isolated on transparent background." }],
  }, { metadata: { background: "transparent", size: "1024x1024", quality: "low" } }));
  console.log(`Live generation: ${generation.width}x${generation.height}, PNG RGBA, alpha=${generation.alpha}`);
  const edit = decodePng(await generate(model, {
    input: [{ type: "text", text: "Make this coin blue instead of gold. Preserve its shape, centered composition and transparent background." },
      generation.image],
  }, { metadata: { background: "transparent" } }));
  console.log(`Live edit: ${edit.width}x${edit.height}, PNG RGBA, alpha=${edit.alpha}; multipart field=image (named file)`);
}, 360_000);
