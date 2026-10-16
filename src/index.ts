import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ORIGIN, firstString, object, resolveConnection, type ConnectionOptions } from "./connection.ts";
import { registerImagesCommand } from "./doctor.ts";
import { CLIPROXYAPI_IMAGES_PROVIDER, CLIPROXYAPI_PROVIDER, isCliproxyapiModel, resolveModelSettings, splitModelId,
  type ModelSettings } from "./models.ts";
import { registerPastedImages } from "./paste.ts";
import { registerTerminalImageRefs } from "./terminal-refs.ts";
import { createGenerateImageTool } from "./tool.ts";

export { createGenerateImageTool, TOOL_NAME } from "./tool.ts";
export { registerPastedImages } from "./paste.ts";
export { MARKER_CELL, MARKER_SCHEME, MARKER_VERSION, markersEnabled, markerUri, registerTerminalImageRefs } from "./terminal-refs.ts";
export { CLIPROXYAPI_IMAGES_PROVIDER, CLIPROXYAPI_PROVIDER, isCliproxyapiModel, loadModelSettings, MODELS_CONFIG_FILE,
  MODELS_CONFIG_PATH, parseModelSettings, resolveModelSettings, splitModelId, userModelsConfigPath } from "./models.ts";
export type { ImageModelSettings, ModelSettings, ResolvedModelSettings } from "./models.ts";
export { connectionSources, normalizeOrigin, resolveConnection } from "./connection.ts";
export type { ConnectionOptions, ConnectionSources } from "./connection.ts";
export { createImagesDependencyProvider, registerImagesCommand } from "./doctor.ts";

const RESOLVED_MODEL_SETTINGS = resolveModelSettings();
/** File the model settings were loaded from: `~/.pi/agent/image.models.json` if present, else `src/image.models.json`. */
export const MODEL_SETTINGS_PATH = RESOLVED_MODEL_SETTINGS.path;
/** Image models and the default model, loaded from MODEL_SETTINGS_PATH when the extension loads. */
export const MODEL_SETTINGS: ModelSettings = RESOLVED_MODEL_SETTINGS.settings;
/**
 * Settings provider served by this package (`cliproxyapi/<model>` in `image.models.json`).
 * Entries of any other provider are looked up in Pi's image model registry as written.
 */
export const SETTINGS_PROVIDER = CLIPROXYAPI_PROVIDER;
/**
 * Pi registry provider id of this package's image models. It differs from SETTINGS_PROVIDER
 * because `cliproxyapi` is owned by the CLIProxyAPI chat provider extension; registering
 * image models under the same id would replace its models and credentials.
 */
export const PROVIDER_ID = CLIPROXYAPI_IMAGES_PROVIDER;
/** Default image model as a full `provider/model` id (`defaultModel` in `image.models.json`). */
export const DEFAULT_MODEL = MODEL_SETTINGS.defaultModel;
/** Model part of DEFAULT_MODEL (for `cliproxyapi` defaults: the registered id and the request body's `model`). */
export const MODEL_ID = splitModelId(DEFAULT_MODEL)!.modelId;
export const IMAGE_API = "openai-images";
export const DEFAULT_TIMEOUT_MS = 180_000;
// Pi requires configured authentication before dispatching an image API. This is
// NOT a credential: the adapter resolves the real key at request time and never
// sends this marker to the gateway. It also lets missing-key errors reach callers.
const ADAPTER_AUTH = "cliproxyapi-images-runtime-auth";

export interface ProviderConfigOptions extends ConnectionOptions {
  /** Image models to register. Default: MODEL_SETTINGS (the loaded `image.models.json`). */
  modelSettings?: ModelSettings;
}

function redact(message: string, ...keys: (string | undefined)[]): string {
  for (const key of keys) {
    if (!key) continue;
    for (const value of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      message = message.split(value).join("[redacted]");
    }
  }
  return message.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsage(raw: Record<string, unknown>, model: ImageModel<string>): Usage {
  const input = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  const rates = [...(model.cost.tiers ?? [])]
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)
    .find((tier) => input > tier.inputTokensAbove) ?? model.cost;
  const cost = { input: input * rates.input / 1_000_000, output: output * rates.output / 1_000_000,
    cacheRead: 0, cacheWrite: 0, total: 0 };
  cost.total = cost.input + cost.output;
  return { input, output, cacheRead: 0, cacheWrite: 0,
    totalTokens: raw.total_tokens === undefined ? input + output : tokenCount(raw.total_tokens), cost };
}

async function generateWithConnection(
  model: ImageModel<string>, context: ImagesContext, options: ImagesOptions = {}, connectionOptions: ConnectionOptions = {},
): Promise<AssistantImages> {
  const result: AssistantImages = { api: model.api, provider: model.provider, model: model.id,
    output: [], stopReason: "stop", timestamp: Date.now() };
  let apiKey: string | undefined;
  let storedKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    const connection = resolveConnection({ ...connectionOptions,
      env: options.env ? { ...(connectionOptions.env ?? process.env), ...options.env } : connectionOptions.env });
    storedKey = connection.apiKey;
    apiKey = options.apiKey && options.apiKey !== ADAPTER_AUTH ? options.apiKey : storedKey;
    if (!apiKey) {
      throw new Error("Missing CLIProxyAPI images credentials. Set CLIPROXYAPI_API_KEY and CLIPROXYAPI_BASE_URL, " +
        "or configure cliproxyapi.json (apiKey/baseUrl) or auth.json's cliproxyapi entry in the Pi agent directory.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Images timeoutMs must be a positive finite number.");
    timer = setTimeout(() => timeout.abort(), timeoutMs);
    const prompt = context.input.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = context.input.filter((block) => block.type === "image");
    const fields: Record<string, string | number> = { model: model.id, prompt, n: 1, output_format: "png" };
    for (const name of ["background", "size", "quality"] as const) {
      if (typeof options.metadata?.[name] === "string") fields[name] = options.metadata[name];
    }
    let body: FormData | string;
    const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
    if (images.length > 0) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
      images.forEach((image, i) => {
        const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1] ?? "png";
        // Singular `image` (repeated for multiple inputs), verified by live smoke.
        form.append("image", new Blob([new Uint8Array(Buffer.from(image.data, "base64"))], { type: image.mimeType }),
          `reference-${i}.${extension}`);
      });
      body = form;
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(fields);
    }
    for (const [name, value] of Object.entries({ ...model.headers, ...options.headers })) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    const nextPayload = await options.onPayload?.(images.length > 0 ? body : fields, model);
    if (nextPayload !== undefined) {
      if (images.length > 0) {
        if (!(nextPayload instanceof FormData)) throw new Error("Image edits onPayload must return FormData.");
        body = nextPayload;
      } else { body = JSON.stringify(nextPayload); }
    }
    signal.throwIfAborted();
    // Never retry a POST automatically: retries may generate/bill duplicate images.
    const response = await (options.fetch ?? globalThis.fetch)(
      `${connection.origin}/v1/images/${images.length > 0 ? "edits" : "generations"}`,
      { method: "POST", headers, body, signal },
    );
    await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    let payload: Record<string, unknown>;
    try { payload = object(await response.json()); }
    catch { throw new Error(`CLIProxyAPI images HTTP ${response.status}: invalid JSON response.`); }
    signal.throwIfAborted();
    if (!response.ok) {
      const message = firstString(object(payload.error).message) ?? "Image request failed.";
      throw new Error(`CLIProxyAPI images HTTP ${response.status}: ${message}`);
    }
    const data = Array.isArray(payload.data) ? payload.data.map(object) : [];
    const format = firstString(payload.output_format) ?? "png";
    for (const item of data) {
      if (typeof item.b64_json === "string" && item.b64_json) {
        result.output.push({ type: "image", mimeType: `image/${format === "jpg" ? "jpeg" : format}`, data: item.b64_json });
      }
    }
    if (!result.output.length) throw new Error("CLIProxyAPI images response contained no base64 images.");
    const responseId = firstString(data[0]?.generation_id);
    if (responseId) result.responseId = redact(responseId, apiKey, storedKey, options.apiKey);
    if (payload.usage) result.usage = parseUsage(object(payload.usage), model);
  } catch (error) {
    result.output = [];
    result.stopReason = options.signal?.aborted ? "aborted" : "error";
    const message = options.signal?.aborted ? "CLIProxyAPI image request aborted."
      : timeout.signal.aborted ? "CLIProxyAPI image request timed out."
      : error instanceof Error ? error.message : String(error);
    result.errorMessage = redact(message, apiKey, storedKey, options.apiKey);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return result;
}

export function generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages> {
  return generateWithConnection(model, context, options);
}

/**
 * Register directly with runtime.registerProvider(PROVIDER_ID, createProviderConfig()).
 * Registers the `cliproxyapi/<model>` entries of the settings as PROVIDER_ID/<model>;
 * entries of other providers are registry references and are not registered here.
 */
export function createProviderConfig(options: ProviderConfigOptions = {}): ProviderConfig {
  const { modelSettings = MODEL_SETTINGS, ...connectionOptions } = options;
  let origin = DEFAULT_ORIGIN;
  try { origin = resolveConnection(connectionOptions).origin; } catch { /* Register even with missing/invalid connection settings. */ }
  return {
    name: "CLIProxyAPI Images",
    baseUrl: `${origin}/v1`,
    apiKey: ADAPTER_AUTH,
    models: modelSettings.models.filter(isCliproxyapiModel).map((model) => ({
      type: "image" as const, id: model.modelId, name: model.name, api: IMAGE_API,
      baseUrl: `${origin}/v1`, input: [...model.input], output: ["image" as const], cost: { ...model.cost } })),
    images: { [IMAGE_API]: { generateImages: (model, context, requestOptions) =>
      generateWithConnection(model, context, requestOptions, connectionOptions) } },
  };
}

/**
 * Settings full id (`cliproxyapi/<model>`) → Pi registry full id (`cliproxyapi-images/<model>`).
 * Other providers need no alias: their settings id is their registry id.
 */
export function modelAliases(modelSettings: ModelSettings = MODEL_SETTINGS): Record<string, string> {
  return Object.fromEntries(modelSettings.models.filter(isCliproxyapiModel)
    .map((model) => [model.id, `${PROVIDER_ID}/${model.modelId}`]));
}

export default function gatewayImages(pi: ExtensionAPI): void {
  // `/images doctor|install-deps` and the umbrella's dependency provider come first, before any optional path.
  registerImagesCommand(pi);
  // Settings that only reference other providers' registry models need no CLIProxyAPI
  // connection; registering an empty provider would only add an unused, "configured" entry.
  if (MODEL_SETTINGS.models.some(isCliproxyapiModel)) pi.registerProvider(PROVIDER_ID, createProviderConfig());
  pi.registerTool(createGenerateImageTool({ defaultModel: DEFAULT_MODEL, modelAliases: modelAliases(),
    timeoutMs: DEFAULT_TIMEOUT_MS }));
  registerPastedImages(pi);
  registerTerminalImageRefs(pi);
}
