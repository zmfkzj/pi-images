import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionToolContext, type ProviderConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelSettings, MODELS_CONFIG_FILE, MODELS_CONFIG_PATH, parseModelSettings, resolveModelSettings,
  splitModelId, userModelsConfigPath } from "../src/models.ts";
import { createGenerateImageTool } from "../src/tool.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Settings file content: the model part of the default contains a slash on purpose. */
const ALTERNATE_RAW = {
  defaultModel: "cliproxyapi/vendor/custom-painter",
  models: [
    { id: "cliproxyapi/gpt-image-2.5", name: "GPT Image 2.5" },
    { id: "cliproxyapi/vendor/custom-painter", name: "Custom Painter", cost: { input: 2, output: 4 } },
  ],
};
const ALTERNATE = parseModelSettings(ALTERNATE_RAW, "alternate.json");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-images-models-")); });
afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("bundled model settings file", () => {
  it("is resolved next to the module, not the working directory", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    expect(MODELS_CONFIG_FILE).toBe("image.models.json");
    expect(MODELS_CONFIG_PATH).toBe(join(testDir, "..", "src", "image.models.json"));
  });

  it("defaults to cliproxyapi/gpt-image-2.5, registered and sent as gpt-image-2.5", async () => {
    expect(loadModelSettings()).toEqual({ defaultModel: "cliproxyapi/gpt-image-2.5", models: [{ id: "cliproxyapi/gpt-image-2.5",
      provider: "cliproxyapi", modelId: "gpt-image-2.5", name: "GPT Image 2.5", input: ["text", "image"], cost: ZERO }] });
    const index = await import("../src/index.ts");
    expect(index.DEFAULT_MODEL).toBe("cliproxyapi/gpt-image-2.5");
    expect(index.MODEL_ID).toBe("gpt-image-2.5");
    expect(index.PROVIDER_ID).toBe("cliproxyapi-images");
    expect(index.MODEL_SETTINGS).toEqual(loadModelSettings());
    expect(index.MODEL_SETTINGS_PATH).toBe(MODELS_CONFIG_PATH);
    expect(index.modelAliases()).toEqual({ "cliproxyapi/gpt-image-2.5": "cliproxyapi-images/gpt-image-2.5" });
  });
});

describe("parseModelSettings / loadModelSettings", () => {
  it("splits full ids at the first slash and fills defaults for name, input and cost", () => {
    expect(splitModelId("cliproxyapi/gpt-image-2.5")).toEqual({ provider: "cliproxyapi", modelId: "gpt-image-2.5" });
    expect(splitModelId("cliproxyapi/vendor/model")).toEqual({ provider: "cliproxyapi", modelId: "vendor/model" });
    for (const bad of ["gpt-image-2.5", "/m", "cliproxyapi/", "cliproxyapi//m", "cliproxyapi/m/", "a b/m", "p/ m"]) {
      expect(splitModelId(bad)).toBeUndefined();
    }
    expect(parseModelSettings({ defaultModel: " cliproxyapi/m ", models: [{ id: " cliproxyapi/m " }] }, "x.json")).toEqual({
      defaultModel: "cliproxyapi/m",
      models: [{ id: "cliproxyapi/m", provider: "cliproxyapi", modelId: "m", name: "m", input: ["text", "image"], cost: ZERO }] });
    expect(ALTERNATE.models[1]).toMatchObject({ id: "cliproxyapi/vendor/custom-painter", provider: "cliproxyapi",
      modelId: "vendor/custom-painter", cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } });
  });

  it("accepts other providers' models as registry references, including the same model name under two providers", () => {
    const settings = parseModelSettings({ defaultModel: "openrouter/google/gemini-2.5-flash-image", models: [
      { id: "cliproxyapi/gpt-image-2.5" }, { id: "other/gpt-image-2.5", name: "Ignored", cost: { input: 9 } },
      { id: "openrouter/google/gemini-2.5-flash-image" }] }, "x.json");
    expect(settings.defaultModel).toBe("openrouter/google/gemini-2.5-flash-image");
    expect(settings.models.map(({ id, provider, modelId }) => [id, provider, modelId])).toEqual([
      ["cliproxyapi/gpt-image-2.5", "cliproxyapi", "gpt-image-2.5"], ["other/gpt-image-2.5", "other", "gpt-image-2.5"],
      ["openrouter/google/gemini-2.5-flash-image", "openrouter", "google/gemini-2.5-flash-image"]]);
  });

  const id = "cliproxyapi/m";
  it.each([
    [[], /expected a JSON object/],
    [{ defaultModel: id, models: [] }, /"models" must be a non-empty array/],
    [{ defaultModel: id, models: [id] }, /models\[0\] must be an object/],
    [{ defaultModel: id, models: [{ id: "" }] }, /models\[0\]\.id must be a non-empty string/],
    // Legacy bare ids get a migration hint.
    [{ defaultModel: "m", models: [{ id: "m" }] }, /models\[0\]\.id "m" must be a full provider\/model id such as "cliproxyapi\/m"\. Bare model ids are no longer supported: prefix the provider in both models\[\]\.id and "defaultModel"\./],
    [{ defaultModel: "m", models: [{ id }] }, /"defaultModel" "m" must be a full provider\/model id such as "cliproxyapi\/m"\. Bare/],
    [{ defaultModel: id, models: [{ id: "cliproxyapi/" }] }, /models\[0\]\.id "cliproxyapi\/" must be a full provider\/model id/],
    [{ defaultModel: id, models: [{ id: "/m" }] }, /models\[0\]\.id "\/m" must be a full provider\/model id/],
    // This package's internal registry id is not a settings provider.
    [{ defaultModel: id, models: [{ id }, { id: "cliproxyapi-images/m" }] }, /models\[1\]\.id "cliproxyapi-images\/m" uses this package's internal registry provider "cliproxyapi-images"; write "cliproxyapi\/m" instead\./],
    [{ defaultModel: id, models: [{ id: "openai/m" }, { id: "openai/m" }] }, /duplicate model id "openai\/m"/],
    [{ defaultModel: "openai/m", models: [{ id }] }, /"defaultModel" "openai\/m" is not one of the configured model ids \(cliproxyapi\/m\)/],
    [{ defaultModel: id, models: [{ id }, { id }] }, /duplicate model id "cliproxyapi\/m"/],
    [{ defaultModel: id, models: [{ id, name: 3 }] }, /models\[0\]\.name/],
    [{ defaultModel: id, models: [{ id, input: ["audio"] }] }, /models\[0\]\.input/],
    [{ defaultModel: id, models: [{ id, input: [] }] }, /models\[0\]\.input/],
    [{ defaultModel: id, models: [{ id, cost: { input: -1 } }] }, /models\[0\]\.cost\.input must be a non-negative number/],
    [{ defaultModel: id, models: [{ id, cost: { output: "1" } }] }, /models\[0\]\.cost\.output/],
    [{ models: [{ id }] }, /"defaultModel" must be a non-empty string/],
    [{ defaultModel: "cliproxyapi/other", models: [{ id }] }, /"defaultModel" "cliproxyapi\/other" is not one of the configured model ids \(cliproxyapi\/m\)/],
  ])("rejects invalid settings %#", (raw, message) => {
    expect(() => parseModelSettings(raw, "bad.json")).toThrow(/^Invalid image model settings in bad\.json: /);
    expect(() => parseModelSettings(raw, "bad.json")).toThrow(message);
  });

  it("names the file for missing or malformed JSON and validates loaded files", () => {
    const path = join(dir, "image.models.json");
    expect(() => loadModelSettings(path)).toThrow(`Cannot read image model settings ${path}`);
    writeFileSync(path, "{ not json");
    expect(() => loadModelSettings(path)).toThrow(`Cannot read image model settings ${path}`);
    writeFileSync(path, JSON.stringify({ defaultModel: "cliproxyapi/x", models: [{ id: "cliproxyapi/y" }] }));
    expect(() => loadModelSettings(path)).toThrow(`Invalid image model settings in ${path}`);
    writeFileSync(path, JSON.stringify(ALTERNATE_RAW));
    expect(loadModelSettings(path)).toEqual(ALTERNATE);
  });
});

describe("user settings ~/.pi/agent/image.models.json", () => {
  it("lives in Pi's agent directory: ~/.pi/agent by default, PI_CODING_AGENT_DIR when set", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    expect(userModelsConfigPath()).toBe(join(homedir(), ".pi", "agent", "image.models.json"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    expect(userModelsConfigPath()).toBe(join(dir, "image.models.json"));
    expect(userModelsConfigPath("/agent")).toBe(join("/agent", "image.models.json"));
  });

  it("replaces the bundled settings completely when present", () => {
    writeFileSync(join(dir, "image.models.json"), JSON.stringify({ defaultModel: "cliproxyapi/only", models: [{ id: "cliproxyapi/only" }] }));
    expect(resolveModelSettings(dir)).toEqual({ path: join(dir, "image.models.json"), settings: { defaultModel: "cliproxyapi/only",
      models: [{ id: "cliproxyapi/only", provider: "cliproxyapi", modelId: "only", name: "only", input: ["text", "image"], cost: ZERO }] } });
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    expect(resolveModelSettings().path).toBe(join(dir, "image.models.json"));
  });

  it("falls back to the bundled file only when the user file is missing", () => {
    const bundled = { path: MODELS_CONFIG_PATH, settings: loadModelSettings() };
    expect(resolveModelSettings(dir)).toEqual(bundled);
    expect(resolveModelSettings(join(dir, "missing-agent-dir"))).toEqual(bundled);
  });

  it("reports invalid, malformed or unreadable user files instead of falling back", () => {
    const path = join(dir, "image.models.json");
    writeFileSync(path, JSON.stringify({ defaultModel: "cliproxyapi/x", models: [{ id: "cliproxyapi/y" }] }));
    expect(() => resolveModelSettings(dir)).toThrow(`Invalid image model settings in ${path}: "defaultModel" "cliproxyapi/x"`);
    writeFileSync(path, "{ not json");
    expect(() => resolveModelSettings(dir)).toThrow(`Cannot read image model settings ${path}: `);
    rmSync(path);
    mkdirSync(path);
    expect(() => resolveModelSettings(dir)).toThrow(`Cannot read image model settings ${path}: `);
  });

  it("fails extension loading loudly for an invalid or legacy bare-id user file", async () => {
    const path = join(dir, "image.models.json");
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    writeFileSync(path, JSON.stringify({ defaultModel: "cliproxyapi/m", models: [] }));
    vi.resetModules();
    await expect(import("../src/index.ts")).rejects.toThrow(`Invalid image model settings in ${path}: "models" must be a non-empty array.`);
    writeFileSync(path, JSON.stringify({ defaultModel: "gpt-image-2.5", models: [{ id: "gpt-image-2.5" }] }));
    vi.resetModules();
    await expect(import("../src/index.ts")).rejects.toThrow(
      `Invalid image model settings in ${path}: models[0].id "gpt-image-2.5" must be a full provider/model id such as "cliproxyapi/gpt-image-2.5".`);
  });
});

function chatProvider(models: string[]): ProviderConfig {
  return { baseUrl: "http://chat.test/v1", apiKey: "chat-key", api: "openai-completions", models: models.map((id) => ({
    id, name: id, reasoning: false, input: ["text"], cost: ZERO, contextWindow: 1000, maxTokens: 100 })) } as ProviderConfig;
}

/** Write `<agentDir>/image.models.json`, reload the extension and run its default export like Pi does. */
async function loadExtension(raw: unknown) {
  writeFileSync(join(dir, "image.models.json"), JSON.stringify(raw));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.resetModules();
  const index = await import("../src/index.ts");
  const registerProvider = vi.fn();
  const registerTool = vi.fn();
  index.default({ registerProvider, registerTool, on: vi.fn(), registerEntryRenderer: vi.fn(), registerCommand: vi.fn(), events: { on: vi.fn() } } as unknown as ExtensionAPI);
  expect(registerTool).toHaveBeenCalledTimes(1);
  return { index, registerProvider, tool: registerTool.mock.calls[0][0] as ToolDefinition };
}

function createRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false });
}

function toolContext(runtime: ModelRuntime): ExtensionToolContext {
  return { cwd: dir, sessionManager: { getBranch: () => [] }, modelRegistry: runtime } as unknown as ExtensionToolContext;
}

function gatewayFetch() {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
    data: [{ b64_json: PNG }], output_format: "png", usage: { input_tokens: 10, output_tokens: 1000 } }));
}

describe("other providers' image models selected in image.models.json", () => {
  const SAME_NAME_MODELS = [
    { id: "cliproxyapi/gpt-image-2.5", name: "Gateway", cost: { input: 2, output: 4 } },
    // Settings metadata of another provider's model is validated but never applied.
    { id: "other/gpt-image-2.5", name: "Ignored name", input: ["text", "image"], cost: { input: 1000, output: 1000 } },
  ];
  const OTHER_COST = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

  function otherProvider(otherImages: ReturnType<typeof vi.fn>): ProviderConfig {
    return { baseUrl: "http://other.test", apiKey: "other-key", models: [{ type: "image", id: "gpt-image-2.5", name: "Other",
      api: "other-images", input: ["text"], output: ["image"], cost: OTHER_COST }],
      images: { "other-images": { generateImages: otherImages } } } as unknown as ProviderConfig;
  }

  it("routes an external default to its registry provider and cliproxyapi/<same id> to the gateway", async () => {
    const { registerProvider, tool } = await loadExtension({ defaultModel: "other/gpt-image-2.5", models: SAME_NAME_MODELS });
    // Only cliproxyapi entries are registered, under cliproxyapi-images; "other" is never (re)registered.
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider.mock.calls[0][0]).toBe("cliproxyapi-images");
    const config = registerProvider.mock.calls[0][1] as ProviderConfig;
    expect(config.models!.map((model) => [model.id, model.name])).toEqual([["gpt-image-2.5", "Gateway"]]);
    expect(JSON.stringify(tool.parameters)).toContain("Default: other/gpt-image-2.5.");

    // No CLIProxyAPI credentials: they must not block the external default.
    vi.stubEnv("CLIPROXYAPI_API_KEY", "");
    vi.stubEnv("CLIPROXYAPI_BASE_URL", "http://gateway.test:8317");
    const fetch = gatewayFetch();
    vi.stubGlobal("fetch", fetch);
    const otherImages = vi.fn(async (model: ImageModel<string>, _context: ImagesContext, _options?: ImagesOptions): Promise<AssistantImages> => ({ api: model.api, provider: model.provider,
      model: model.id, output: [{ type: "image", mimeType: "image/png", data: PNG }], stopReason: "stop", timestamp: 0 }));
    const runtime = await createRuntime();
    runtime.registerProvider("cliproxyapi-images", config);
    runtime.registerProvider("other", otherProvider(otherImages));
    try {
      const ctx = toolContext(runtime);
      const result = await tool.execute("d1", { prompt: "coin", path: "default.png" }, undefined, undefined, ctx);
      expect(result.details).toMatchObject({ model: "other/gpt-image-2.5" });
      expect(otherImages).toHaveBeenCalledTimes(1);
      // Registry metadata and the provider's own auth, not the settings entry's name/input/cost.
      expect(otherImages.mock.calls[0][0]).toMatchObject({ provider: "other", id: "gpt-image-2.5", name: "Other",
        input: ["text"], cost: OTHER_COST });
      expect(otherImages.mock.calls[0][2]).toMatchObject({ apiKey: "other-key" });
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, "default.png")).toString("base64")).toBe(PNG);

      // Settings input ["text","image"] is not applied: the registry model is text-only.
      writeFileSync(join(dir, "ref.png"), Buffer.from(PNG, "base64"));
      await expect(tool.execute("d2", { prompt: "edit", references: ["ref.png"] }, undefined, undefined, ctx))
        .rejects.toThrow("other/gpt-image-2.5 does not accept image input.");

      // Same bare id under cliproxyapi: CLIProxyAPI connection (its credentials, its settings cost).
      await expect(tool.execute("d3", { prompt: "coin", model: "cliproxyapi/gpt-image-2.5" }, undefined, undefined, ctx))
        .rejects.toThrow(/Missing CLIProxyAPI images credentials/);
      vi.stubEnv("CLIPROXYAPI_API_KEY", "unit-test-key");
      const gateway = await tool.execute("d4", { prompt: "coin", model: "cliproxyapi/gpt-image-2.5", path: "gw.png" },
        undefined, undefined, ctx);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe("http://gateway.test:8317/v1/images/generations");
      expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).model).toBe("gpt-image-2.5");
      expect(gateway.usage?.cost.total).toBeCloseTo(0.00402);
      expect(otherImages).toHaveBeenCalledTimes(1);
      expect(runtime.getModelOfType("image", "other", "gpt-image-2.5")).toMatchObject({ name: "Other", cost: OTHER_COST });
    } finally {
      for (const provider of ["cliproxyapi-images", "other"]) runtime.unregisterProvider(provider);
    }
  });

  it("keeps a cliproxyapi default while other/<same id> is selected explicitly", async () => {
    const { tool, registerProvider } = await loadExtension({ defaultModel: "cliproxyapi/gpt-image-2.5", models: SAME_NAME_MODELS });
    vi.stubEnv("CLIPROXYAPI_BASE_URL", "http://gateway.test:8317");
    vi.stubEnv("CLIPROXYAPI_API_KEY", "unit-test-key");
    const fetch = gatewayFetch();
    vi.stubGlobal("fetch", fetch);
    const otherImages = vi.fn(async (model: ImageModel<string>): Promise<AssistantImages> => ({ api: model.api, provider: model.provider,
      model: model.id, output: [{ type: "image", mimeType: "image/png", data: PNG }], stopReason: "stop", timestamp: 0 }));
    const runtime = await createRuntime();
    runtime.registerProvider("cliproxyapi-images", registerProvider.mock.calls[0][1] as ProviderConfig);
    runtime.registerProvider("other", otherProvider(otherImages));
    try {
      const ctx = toolContext(runtime);
      await tool.execute("r1", { prompt: "coin", path: "a.png" }, undefined, undefined, ctx);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(otherImages).not.toHaveBeenCalled();
      const explicit = await tool.execute("r2", { prompt: "coin", model: "other/gpt-image-2.5", path: "b.png" }, undefined, undefined, ctx);
      expect(explicit.details).toMatchObject({ model: "other/gpt-image-2.5" });
      expect(otherImages).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      for (const provider of ["cliproxyapi-images", "other"]) runtime.unregisterProvider(provider);
    }
  });

  it("uses a built-in OpenRouter image model with no cliproxyapi entries or CLIProxyAPI connection", async () => {
    const { index, registerProvider, tool } = await loadExtension({ defaultModel: "openrouter/google/gemini-2.5-flash-image",
      models: [{ id: "openrouter/google/gemini-2.5-flash-image", name: "Ignored", input: ["text"], cost: { input: 1000, output: 1000 } }] });
    // Nothing to serve through CLIProxyAPI: no provider registration at all.
    expect(registerProvider).not.toHaveBeenCalled();
    expect(index.modelAliases()).toEqual({});
    vi.stubEnv("CLIPROXYAPI_API_KEY", "");
    vi.stubEnv("CLIPROXYAPI_BASE_URL", "");
    vi.stubEnv("OPENROUTER_API_KEY", "or-unit-test-key");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ id: "gen-1",
      object: "chat.completion", created: 0, model: "google/gemini-2.5-flash-image", choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100 } }));
    vi.stubGlobal("fetch", fetch);
    const runtime = await createRuntime();
    const registry = runtime.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image")!;
    expect(registry.input).toContain("image");
    const ctx = toolContext(runtime);

    // Settings input ["text"] is not applied either: the registry model accepts references.
    writeFileSync(join(dir, "ref.png"), Buffer.from(PNG, "base64"));
    const result = await tool.execute("o1", { prompt: "coin", references: ["ref.png"], path: "or.png" }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ model: "openrouter/google/gemini-2.5-flash-image" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer or-unit-test-key");
    expect(JSON.parse(init?.body as string).model).toBe("google/gemini-2.5-flash-image");
    // Cost comes from the registry model's rates, not the settings entry's.
    expect(result.usage?.cost.total).toBeCloseTo((100 * registry.cost.input + 1000 * registry.cost.output) / 1_000_000);
    expect(readFileSync(join(dir, "or.png")).toString("base64")).toBe(PNG);

    // Missing OpenRouter auth fails through Pi's auth path, without any request.
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(tool.execute("o2", { prompt: "coin" }, undefined, undefined, ctx)).rejects.toThrow("Provider is not configured: openrouter");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports unknown and non-image external defaults when the tool runs, without any request", async () => {
    const runtime = await createRuntime();
    const chat = runtime.getModelsOfType("chat").find((model) => model.provider === "openrouter")!;
    expect(runtime.getModelOfType("image", chat.provider, chat.id)).toBeUndefined();
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    for (const defaultModel of ["openrouter/no-such-image-model", `openrouter/${chat.id}`, "nowhere/gpt-image-2.5"]) {
      const { tool } = await loadExtension({ defaultModel, models: [{ id: "cliproxyapi/gpt-image-2.5" }, { id: defaultModel }] });
      await expect(tool.execute("u", { prompt: "coin" }, undefined, undefined, toolContext(runtime)))
        .rejects.toThrow(`Unknown image model ${defaultModel}. Available: cliproxyapi/gpt-image-2.5, `);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("settings reach real model use", () => {
  it("routes provider/model ids: settings, defaults, registry, request model, other providers and the cliproxyapi chat provider", async () => {
    const path = join(dir, "image.models.json");
    writeFileSync(path, JSON.stringify(ALTERNATE_RAW));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.resetModules();
    const index = await import("../src/index.ts");
    expect(index.MODEL_SETTINGS_PATH).toBe(path);
    expect(index.DEFAULT_MODEL).toBe("cliproxyapi/vendor/custom-painter");
    expect(index.MODEL_ID).toBe("vendor/custom-painter");

    vi.stubEnv("CLIPROXYAPI_BASE_URL", "http://gateway.test:8317");
    vi.stubEnv("CLIPROXYAPI_API_KEY", "unit-test-key");
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
      data: [{ b64_json: PNG }], output_format: "png", usage: { input_tokens: 10, output_tokens: 1000 } }));
    vi.stubGlobal("fetch", fetch);

    const registerProvider = vi.fn();
    const registerTool = vi.fn();
    index.default({ registerProvider, registerTool, on: vi.fn(), registerEntryRenderer: vi.fn(), registerCommand: vi.fn(), events: { on: vi.fn() } } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider.mock.calls[0][0]).toBe("cliproxyapi-images");
    const config = registerProvider.mock.calls[0][1] as ProviderConfig;
    expect(config.models!.map((model) => [model.id, model.name]))
      .toEqual([["gpt-image-2.5", "GPT Image 2.5"], ["vendor/custom-painter", "Custom Painter"]]);
    const tool = registerTool.mock.calls[0][0] as ToolDefinition;
    const parameters = JSON.stringify(tool.parameters);
    expect(parameters).toContain("Default: cliproxyapi/vendor/custom-painter.");
    expect(parameters).not.toContain("cliproxyapi-images/cliproxyapi");

    const otherImages = vi.fn(async (model: ImageModel<string>): Promise<AssistantImages> => ({ api: model.api, provider: model.provider,
      model: model.id, output: [{ type: "image", mimeType: "image/png", data: PNG }], stopReason: "stop", timestamp: 0 }));
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false });
    // The CLIProxyAPI chat extension owns the `cliproxyapi` registry id and re-registers it on refresh.
    runtime.registerProvider("cliproxyapi", chatProvider(["chat-a"]));
    runtime.registerProvider(index.PROVIDER_ID, config);
    runtime.registerProvider("other", { baseUrl: "http://other.test", apiKey: "other-key", models: [{ type: "image", id: "gpt-image-2.5",
      name: "Other", api: "other-images", input: ["text"], output: ["image"], cost: ZERO }],
      images: { "other-images": { generateImages: otherImages } } } as unknown as ProviderConfig);
    runtime.unregisterProvider("cliproxyapi");
    runtime.registerProvider("cliproxyapi", chatProvider(["chat-b"]));
    try {
      expect(runtime.getModelOfType("chat", "cliproxyapi", "chat-b")).toBeDefined();
      expect(runtime.getModelOfType("image", "cliproxyapi-images", "vendor/custom-painter")).toBeDefined();
      expect(runtime.getModelOfType("image", "cliproxyapi", "vendor/custom-painter")).toBeUndefined();

      const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, modelRegistry: runtime } as unknown as ExtensionToolContext;
      writeFileSync(join(dir, "ref.png"), Buffer.from(PNG, "base64"));
      const generated = await tool.execute("call-1", { prompt: "coin", path: "out.png" }, undefined, undefined, ctx);
      expect(generated.details).toMatchObject({ model: "cliproxyapi/vendor/custom-painter" });
      expect(fetch.mock.calls[0][0]).toBe("http://gateway.test:8317/v1/images/generations");
      expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).model).toBe("vendor/custom-painter");
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer unit-test-key");
      // usage cost follows the configured per-million rates (10*2 + 1000*4) / 1e6
      expect(generated.usage?.cost.total).toBeCloseTo(0.00402);
      expect(readFileSync(join(dir, "out.png")).toString("base64")).toBe(PNG);

      await tool.execute("call-2", { prompt: "edit", references: ["ref.png"], path: "edit.png" }, undefined, undefined, ctx);
      expect(fetch.mock.calls[1][0]).toBe("http://gateway.test:8317/v1/images/edits");
      expect((fetch.mock.calls[1][1]?.body as FormData).get("model")).toBe("vendor/custom-painter");

      const explicit = await tool.execute("call-3", { prompt: "coin", model: "cliproxyapi/gpt-image-2.5", path: "a.png" }, undefined, undefined, ctx);
      expect(explicit.details).toMatchObject({ model: "cliproxyapi/gpt-image-2.5" });
      expect(JSON.parse(fetch.mock.calls[2][1]?.body as string).model).toBe("gpt-image-2.5");
      // The registry id keeps working for callers that address the registry directly.
      await tool.execute("call-4", { prompt: "coin", model: "cliproxyapi-images/gpt-image-2.5", path: "b.png" }, undefined, undefined, ctx);
      expect(JSON.parse(fetch.mock.calls[3][1]?.body as string).model).toBe("gpt-image-2.5");

      // Same model name, other provider: dispatched to that provider, never to CLIProxyAPI.
      await tool.execute("call-5", { prompt: "coin", model: "other/gpt-image-2.5", path: "c.png" }, undefined, undefined, ctx);
      expect(otherImages).toHaveBeenCalledTimes(1);
      expect(otherImages.mock.calls[0][0]).toMatchObject({ provider: "other", id: "gpt-image-2.5" });
      expect(fetch).toHaveBeenCalledTimes(4);

      await expect(tool.execute("call-6", { prompt: "coin", model: "unknown/gpt-image-2.5" }, undefined, undefined, ctx))
        .rejects.toThrow(/Unknown image model unknown\/gpt-image-2\.5\. Available: cliproxyapi\/gpt-image-2\.5, cliproxyapi\/vendor\/custom-painter, /);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      for (const provider of [index.PROVIDER_ID, "other", "cliproxyapi"]) runtime.unregisterProvider(provider);
    }
  });

  it("accepts explicit model settings in createProviderConfig", async () => {
    const { createProviderConfig, modelAliases } = await import("../src/index.ts");
    const config = createProviderConfig({ agentDir: dir, env: {}, modelSettings: ALTERNATE });
    expect(config.models?.map((model) => model.id)).toEqual(["gpt-image-2.5", "vendor/custom-painter"]);
    expect(config.baseUrl).toBe("http://127.0.0.1:8317/v1");
    expect(modelAliases(ALTERNATE)).toEqual({ "cliproxyapi/gpt-image-2.5": "cliproxyapi-images/gpt-image-2.5",
      "cliproxyapi/vendor/custom-painter": "cliproxyapi-images/vendor/custom-painter" });
  });
});

describe("generate_image tool description", () => {
  it("names each tool's own default model without sharing parameters", () => {
    const a = createGenerateImageTool({ defaultModel: "p/a", timeoutMs: 1 });
    const b = createGenerateImageTool({ defaultModel: "p/b", timeoutMs: 1 });
    expect(JSON.stringify(a.parameters)).toContain("Default: p/a.");
    expect(JSON.stringify(b.parameters)).toContain("Default: p/b.");
    expect(a.parameters).not.toBe(b.parameters);
  });
});
