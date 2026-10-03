import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions, Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "cliproxyapi-images";
export const MODEL_ID = "gpt-image-2.5";
export const IMAGE_API = "openai-images";
export const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ORIGIN = "http://127.0.0.1:8317";
// Pi requires configured authentication before dispatching an image API. This is
// NOT a credential: the adapter resolves the real key at request time and never
// sends this marker to the gateway. It also lets missing-key errors reach callers.
const ADAPTER_AUTH = "cliproxyapi-images-runtime-auth";

export interface ConnectionOptions {
  agentDir?: string;
  env?: Record<string, string | undefined>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function readObject(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return {}; } // Never include parser errors: they can quote credentials.
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function normalizeOrigin(baseUrl: string): string {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch {
    throw new Error("Invalid CLIProxyAPI base URL; set CLIPROXYAPI_BASE_URL or cliproxyapi.json baseUrl.");
  }
}

/** Same source precedence as the chat extension; values remain in memory only. */
export function resolveConnection(options: ConnectionOptions = {}): { origin: string; apiKey?: string } {
  const agentDir = options.agentDir ?? getAgentDir();
  const env = options.env ?? process.env;
  const config = readObject(join(agentDir, "cliproxyapi.json"));
  const entry = object(readObject(join(agentDir, "auth.json")).cliproxyapi);
  const authKey = entry.type === "oauth" ? firstString(entry.access)
    : entry.type === "api_key" ? firstString(entry.key) : undefined;
  let meta: Record<string, unknown> = {};
  if (authKey && entry.type === "oauth" && typeof entry.refresh === "string") {
    try { meta = object(JSON.parse(entry.refresh)); } catch { /* Older refresh tokens have no URL. */ }
  }
  return {
    origin: normalizeOrigin(firstString(env.CLIPROXYAPI_BASE_URL, config.baseUrl, meta.baseUrl, DEFAULT_ORIGIN)!),
    apiKey: firstString(env.CLIPROXYAPI_API_KEY, config.apiKey, authKey),
  };
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

/** Register directly with runtime.registerProvider(PROVIDER_ID, createProviderConfig()). */
export function createProviderConfig(options: ConnectionOptions = {}): ProviderConfig {
  let origin = DEFAULT_ORIGIN;
  try { origin = resolveConnection(options).origin; } catch { /* Register even with missing/invalid connection settings. */ }
  return {
    name: "CLIProxyAPI Images",
    baseUrl: `${origin}/v1`,
    apiKey: ADAPTER_AUTH,
    models: [{ type: "image", id: MODEL_ID, name: "GPT Image 2.5", api: IMAGE_API,
      baseUrl: `${origin}/v1`, input: ["text", "image"], output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    images: { [IMAGE_API]: { generateImages: (model, context, requestOptions) =>
      generateWithConnection(model, context, requestOptions, options) } },
  };
}

export default function gatewayImages(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, createProviderConfig());
}
