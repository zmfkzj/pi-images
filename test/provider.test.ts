import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageModel, ImagesOptions } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gatewayImages, { createProviderConfig, generateImages, IMAGE_API, MODEL_ID, normalizeOrigin,
  PROVIDER_ID, resolveConnection } from "../src/index.ts";

let agentDir: string;
const env = { CLIPROXYAPI_BASE_URL: "http://gateway.test:8317/backend-api", CLIPROXYAPI_API_KEY: "unit-test-key" };
const input = { input: [{ type: "text" as const, text: "gold coin" }, { type: "text" as const, text: "pixel art" }] };

function model(): ImageModel<string> {
  const definition = createProviderConfig({ agentDir, env }).models![0];
  return { ...definition, provider: PROVIDER_ID, type: "image", api: IMAGE_API,
    baseUrl: definition.baseUrl!, output: ["image"] };
}

function success() {
  return Response.json({ data: [{ b64_json: "aW1hZ2U=", generation_id: "generation-1" }, { b64_json: "b3RoZXI=" }],
    output_format: "png", usage: { input_tokens: 14, output_tokens: 2058, total_tokens: 2072,
      input_tokens_details: { text_tokens: 14, image_tokens: 0 }, output_tokens_details: { image_tokens: 2058 } } });
}

function adapter(options: ImagesOptions = {}, fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success())) {
  const config = createProviderConfig({ agentDir, env });
  return { fetch, run: () => config.images![IMAGE_API]!.generateImages(model(), input, { fetch, ...options }) };
}

beforeEach(() => { agentDir = mkdtempSync(join(tmpdir(), "pi-images-unit-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(agentDir, { recursive: true, force: true }); });

describe("provider registration and credentials", () => {
  it("registers a separate image provider without capturing a real key", () => {
    const registerProvider = vi.fn();
    const registerTool = vi.fn();
    const on = vi.fn();
    gatewayImages({ registerProvider, registerTool, on, registerEntryRenderer: vi.fn(), events: { on: vi.fn() } } as unknown as ExtensionAPI);
    expect(on.mock.calls.map((call) => call[0])).toContain("input");
    expect(registerProvider.mock.calls[0][0]).toBe(PROVIDER_ID);
    expect(registerTool.mock.calls[0][0].name).toBe("generate_image");
    const config = createProviderConfig({ agentDir, env });
    expect(config.name).toBe("CLIProxyAPI Images");
    expect(config.models).toEqual([{ type: "image", id: MODEL_ID, name: "GPT Image 2.5", api: IMAGE_API,
      baseUrl: "http://gateway.test:8317/v1", input: ["text", "image"], output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
    expect(config.apiKey).not.toBe(env.CLIPROXYAPI_API_KEY);
  });

  it("resolves environment, config and OAuth refresh metadata in priority order", () => {
    writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ baseUrl: "https://config.test/v1", apiKey: "config-key" }));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cliproxyapi: { type: "oauth", access: "auth-key",
      refresh: JSON.stringify({ baseUrl: "https://auth.test/backend-api" }) } }));
    expect(resolveConnection({ agentDir, env })).toEqual({ origin: "http://gateway.test:8317", apiKey: "unit-test-key" });
    expect(resolveConnection({ agentDir, env: {} })).toEqual({ origin: "https://config.test", apiKey: "config-key" });
    writeFileSync(join(agentDir, "cliproxyapi.json"), "{}");
    expect(resolveConnection({ agentDir, env: {} })).toEqual({ origin: "https://auth.test", apiKey: "auth-key" });
    expect(resolveConnection({ agentDir, env: { CLIPROXYAPI_BASE_URL: "http://mixed.test/v1" } }))
      .toEqual({ origin: "http://mixed.test", apiKey: "auth-key" });
  });

  it("supports stored api_key credentials, whitespace and malformed files safely", () => {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cliproxyapi: { type: "api_key", key: " stored-key " } }));
    writeFileSync(join(agentDir, "cliproxyapi.json"), "invalid JSON");
    expect(resolveConnection({ agentDir, env: {} })).toEqual({ origin: "http://127.0.0.1:8317", apiKey: "stored-key" });
    expect(resolveConnection({ agentDir, env: { CLIPROXYAPI_API_KEY: "  " } }).apiKey).toBe("stored-key");
    expect(normalizeOrigin("gateway.test:8317/v1/path")).toBe("http://gateway.test:8317");
    expect(() => normalizeOrigin("http://[")).toThrow("Invalid CLIProxyAPI base URL");
  });

  it.each(["ftp://gateway.test:8317", "FTP://gateway.test:8317", "custom+transport://gateway.test:8317"])(
    "rejects unsupported URL schemes: %s", (baseUrl) => {
      expect(() => normalizeOrigin(baseUrl)).toThrow("Invalid CLIProxyAPI base URL");
    });

  it.each(["localhost:8317", "gateway:8317"])("supports bare host:port: %s", (baseUrl) => {
    expect(normalizeOrigin(baseUrl)).toBe(`http://${baseUrl}`);
  });

  it("rejects an unsupported URL before sending credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await adapter({ env: { CLIPROXYAPI_BASE_URL: "ftp://gateway.test:8317" } }, fetch).run();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/Invalid CLIProxyAPI base URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers without credentials and returns a helpful error before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const config = createProviderConfig({ agentDir, env: {} });
    const result = await config.images![IMAGE_API]!.generateImages(model(), input, { fetch });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/CLIPROXYAPI_API_KEY/);
    expect(result.errorMessage).toMatch(/CLIPROXYAPI_BASE_URL/);
    expect(result.errorMessage).toMatch(/cliproxyapi.json/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves getAgentDir and live process env for the exported adapter", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("CLIPROXYAPI_BASE_URL", env.CLIPROXYAPI_BASE_URL);
    vi.stubEnv("CLIPROXYAPI_API_KEY", env.CLIPROXYAPI_API_KEY);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success());
    expect((await generateImages(model(), input, { fetch })).stopReason).toBe("stop");
    expect(fetch.mock.calls[0][0]).toBe("http://gateway.test:8317/v1/images/generations");
  });

  it("dispatches through real ModelRuntime, including useful missing-key errors", async () => {
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
    runtime.registerProvider(PROVIDER_ID, createProviderConfig({ agentDir, env: {} }));
    const painter = runtime.getModelOfType("image", PROVIDER_ID, MODEL_ID)!;
    expect(painter).toBeDefined();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await runtime.generateImages(painter, input, { fetch });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/cliproxyapi.json/);
    expect(fetch).not.toHaveBeenCalled();
    runtime.unregisterProvider(PROVIDER_ID);
  });
});

describe("OpenAI Images requests and results", () => {
  it("posts generations JSON with gateway URL, auth, joined prompt and recognized metadata", async () => {
    const { run, fetch } = adapter({ metadata: { background: "transparent", size: "1024x1024", quality: "low", ignored: true },
      headers: { "X-Test": "test-header" } });
    const result = await run();
    expect(result.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("http://gateway.test:8317/v1/images/generations");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer unit-test-key");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request?.headers).get("X-Test")).toBe("test-header");
    expect(JSON.parse(request?.body as string)).toEqual({ model: MODEL_ID, prompt: "gold coin\npixel art", n: 1,
      output_format: "png", background: "transparent", size: "1024x1024", quality: "low" });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts edits with named image Blob parts using singular image field", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success());
    const result = await createProviderConfig({ agentDir, env }).images![IMAGE_API]!.generateImages(model(),
      { input: [...input.input, { type: "image", mimeType: "image/png", data: "cG5nLWJ5dGVz" },
        { type: "image", mimeType: "image/jpeg", data: "anBlZy1ieXRlcw==" }] },
      { fetch, metadata: { background: "transparent" } });
    expect(result.stopReason).toBe("stop");
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("http://gateway.test:8317/v1/images/edits");
    expect(new Headers(request?.headers).has("Content-Type")).toBe(false); // fetch supplies the boundary
    const form = request?.body as FormData;
    expect(form.get("model")).toBe(MODEL_ID);
    expect(form.get("prompt")).toBe("gold coin\npixel art");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("output_format")).toBe("png");
    expect(form.has("image[]")).toBe(false);
    const files = form.getAll("image") as File[];
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("reference-0.png");
    expect(files[0].type).toBe("image/png");
    expect(Buffer.from(await files[0].arrayBuffer()).toString()).toBe("png-bytes");
    expect(files[1].name).toBe("reference-1.jpg");
  });

  it("maps all image blocks, generation id, usage and model token costs", async () => {
    const painter = model();
    painter.cost = { input: 2, output: 4, cacheRead: 10, cacheWrite: 10 };
    const result = await createProviderConfig({ agentDir, env }).images![IMAGE_API]!.generateImages(painter, input,
      { fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(success()) });
    expect(result.output).toEqual([{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "image", mimeType: "image/png", data: "b3RoZXI=" }]);
    expect(result.responseId).toBe("generation-1");
    expect(result.api).toBe(IMAGE_API);
    expect(result.provider).toBe(PROVIDER_ID);
    expect(result.model).toBe(MODEL_ID);
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.usage).toEqual({ input: 14, output: 2058, cacheRead: 0, cacheWrite: 0, totalTokens: 2072,
      cost: { input: 0.000028, output: 0.008232, cacheRead: 0, cacheWrite: 0, total: 0.00826 } });
  });

  it("maps fallback total tokens, absent usage and output mime", async () => {
    const { run } = adapter({}, vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ output_format: "jpeg",
      data: [{ b64_json: "abc" }], usage: { input_tokens: 2, output_tokens: 3 } })));
    const result = await run();
    expect(result.usage?.totalTokens).toBe(5);
    expect(result.output[0]).toMatchObject({ mimeType: "image/jpeg" });
    const withoutUsage = await adapter({}, vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ data: [{ b64_json: "abc" }] }))).run();
    expect(withoutUsage.usage).toBeUndefined();
  });

  it("supports payload and response hooks, fetch override and suppressed headers", async () => {
    const onPayload = vi.fn().mockReturnValue({ model: MODEL_ID, prompt: "replacement", n: 1 });
    const onResponse = vi.fn();
    const { run, fetch } = adapter({ onPayload, onResponse, headers: { "Content-Type": null } });
    await run();
    expect(onPayload).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).prompt).toBe("replacement");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("Content-Type")).toBe(false);
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), expect.objectContaining({ id: MODEL_ID }));
  });
});

describe("safe failures and cancellation", () => {
  it("maps HTTP status and gateway message and redacts repeated/encoded keys", async () => {
    const error = `Denied unit-test-key; unit-test-key; ${encodeURIComponent("override secret")}`;
    const { run, fetch } = adapter({ apiKey: "override secret" }, vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ error: { message: error } }, { status: 401 })));
    const result = await run();
    expect(result.stopReason).toBe("error");
    expect(result.output).toEqual([]);
    expect(result.errorMessage).toBe("CLIProxyAPI images HTTP 401: Denied [redacted]; [redacted]; [redacted]");
    expect(fetch).toHaveBeenCalledOnce(); // no potentially-billable retries
  });

  it("scrubs thrown fetch errors and ignores unsafe invalid JSON response contents", async () => {
    const result = await adapter({}, vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("network unit-test-key"))).run();
    expect(result.errorMessage).toBe("network [redacted]");
    const invalid = await adapter({}, vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("unit-test-key", { status: 502 }))).run();
    expect(invalid.errorMessage).toBe("CLIProxyAPI images HTTP 502: invalid JSON response.");
  });

  it("reports malformed/empty image responses as errors", async () => {
    const result = await adapter({}, vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [] }))).run();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/no base64 images/);
  });

  it("honors an already aborted signal without fetching", async () => {
    const controller = new AbortController();
    controller.abort("unit-test-key");
    const { run, fetch } = adapter({ signal: controller.signal });
    const result = await run();
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("CLIProxyAPI image request aborted.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates in-flight caller abort to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(new Error("cancelled unit-test-key")), { once: true });
      controller.abort();
    }));
    const result = await adapter({ signal: controller.signal }, fetch).run();
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).not.toContain("unit-test-key");
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("applies a finite timeout and distinguishes it from caller abort", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    }));
    const result = await adapter({ timeoutMs: 5 }, fetch).run();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("CLIProxyAPI image request timed out.");
    const invalid = await adapter({ timeoutMs: 0 }).run();
    expect(invalid.stopReason).toBe("error");
    expect(invalid.errorMessage).toMatch(/positive finite/);
  });
});
