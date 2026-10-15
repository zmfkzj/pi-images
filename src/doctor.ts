// `/images doctor|install-deps` and the umbrella's dependency provider (see dependencies.ts for the contract).
// check() is read-only: it re-reads the image model settings and the CLIProxyAPI connection settings, looks up
// non-CLIProxyAPI image models in Pi's registry and sends at most one short GET to the configured gateway's model
// list (never an image request). Keys are reported as set / not set and never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectionSources, normalizeOrigin } from "./connection.ts";
import {
  formatDependencyReport, registerDependencyProvider, type DependencyItem, type DependencyMode, type DependencyProvider,
  type DependencyReport,
} from "./dependencies.ts";
import { isCliproxyapiModel, resolveModelSettings, userModelsConfigPath } from "./models.ts";

export const IMAGES_DEPENDENCY_ID = "images";
export const IMAGES_LABEL = "pi-gateway-images";
export const IMAGES_COMMAND = "images";
export const PROBE_TIMEOUT_MS = 3_000;
export const IMAGES_USAGE = "Usage: /images doctor (check image models and the CLIProxyAPI image gateway) | /images install-deps";
const SUBCOMMANDS = [
  { value: "doctor", label: "doctor", description: "Check the image model settings and the CLIProxyAPI image gateway" },
  { value: "install-deps", label: "install-deps", description: "Install dependencies (nothing automatic: the gateway and its credentials are manual)" },
];

export interface ImagesDoctorOptions {
  /** Pi agent directory. Default: getAgentDir() at check time. */
  agentDir?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  /** Gateway probe timeout. Default: PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The part of the command context check() uses. */
export interface ImagesDoctorContext {
  modelRegistry?: { getModelOfType?(type: "image", provider: string, modelId: string): unknown };
}

export type ProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "auth"; status: number }
  | { kind: "http"; status: number }
  | { kind: "unreachable"; reason: string }
  | { kind: "unverified"; reason: string };

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTDOWN"]);

/** One GET with a short timeout. Never throws; the response body is discarded (never shown). */
export async function probeEndpoint(url: string, apiKey: string | undefined,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { kind: "ok", status: response.status };
    if (response.status === 401 || response.status === 403) return { kind: "auth", status: response.status };
    return { kind: "http", status: response.status };
  } catch (error) {
    const err = error as { name?: string; code?: string; cause?: { code?: string } };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { kind: "unverified", reason: `no answer within ${timeoutMs} ms` };
    const code = err?.cause?.code ?? err?.code;
    if (code && UNREACHABLE.has(code)) return { kind: "unreachable", reason: code };
    return { kind: "unverified", reason: code ?? "network error" };
  }
}

function invalidJsonObject(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return !(value !== null && typeof value === "object" && !Array.isArray(value));
  } catch { return true; } // Never show the parser message: it can quote credentials.
}

export async function checkImages(ctx: ImagesDoctorContext | undefined, options: ImagesDoctorOptions = {}): Promise<DependencyReport> {
  const agentDir = options.agentDir ?? getAgentDir();
  const env = options.env ?? process.env;
  const items: DependencyItem[] = [];
  let resolved: ReturnType<typeof resolveModelSettings>;
  try {
    resolved = resolveModelSettings(agentDir);
  } catch (error) {
    items.push({ name: "image model settings", status: "error", detail: error instanceof Error ? error.message : String(error),
      action: `Fix ${userModelsConfigPath(agentDir)} (or remove it to use the bundled defaults), then /reload` });
    return { items };
  }
  const { path, settings } = resolved;
  items.push({ name: "image model settings", status: "ok",
    detail: `${path}: ${settings.models.length} model(s), default ${settings.defaultModel}` });

  for (const model of settings.models.filter((entry) => !isCliproxyapiModel(entry))) {
    const name = `image model ${model.id}`;
    const lookup = ctx?.modelRegistry?.getModelOfType;
    if (typeof lookup !== "function") {
      items.push({ name, status: "unverified", detail: "Pi's model registry is not available here",
        action: "Run /images doctor inside a Pi session to look the model up" });
    } else if (lookup.call(ctx!.modelRegistry, "image", model.provider, model.modelId)) {
      items.push({ name, status: "ok", detail: `registered in Pi by provider ${model.provider} (uses that provider's own credentials)` });
    } else {
      items.push({ name, status: "error", detail: "not registered in Pi's image model registry",
        action: `Install and enable the Pi extension that provides ${model.provider} image models (and log in to it), `
          + `or replace ${model.id} in ${path}, then /reload` });
    }
  }

  if (!settings.models.some(isCliproxyapiModel)) {
    return { items, note: "No cliproxyapi/<model> image models configured: no CLIProxyAPI connection is needed." };
  }

  const configPath = join(agentDir, "cliproxyapi.json");
  const keyAction = `Run /login CLIProxyAPI (pi-cliproxyapi-bundle), or set CLIPROXYAPI_API_KEY, or apiKey in ${configPath}`;
  const urlAction = `Set CLIPROXYAPI_BASE_URL or baseUrl in ${configPath} to the CLIProxyAPI address (e.g. http://127.0.0.1:8317)`;
  if (invalidJsonObject(configPath)) {
    items.push({ name: "cliproxyapi.json", status: "error", detail: `${configPath} is not a valid JSON object; its baseUrl and apiKey are ignored`,
      action: `Fix the JSON in ${configPath} (or remove the file)` });
  }
  const sources = connectionSources({ agentDir, env });
  let origin: string | undefined;
  try {
    origin = normalizeOrigin(sources.baseUrl);
    items.push({ name: "CLIProxyAPI base URL", status: "ok", detail: `${origin} (from ${sources.baseUrlSource})` });
  } catch {
    // The raw value is not shown: a malformed URL can carry credentials.
    items.push({ name: "CLIProxyAPI base URL", status: "error", detail: `invalid http(s) URL (from ${sources.baseUrlSource})`, action: urlAction });
  }
  items.push(sources.apiKey
    ? { name: "CLIProxyAPI credentials", status: "ok", detail: `API key set (from ${sources.apiKeySource})` }
    : { name: "CLIProxyAPI credentials", status: "manual", detail: "API key not set", action: keyAction });
  if (!origin) return { items };

  const modelsUrl = `${origin}/v1/models`;
  const result = await probeEndpoint(modelsUrl, sources.apiKey, options);
  const gateway = "CLIProxyAPI image gateway";
  switch (result.kind) {
    case "ok":
      items.push({ name: gateway, status: "ok", detail: `reachable at ${origin}${sources.apiKey ? ", API key accepted" : ""}` });
      break;
    case "auth":
      items.push(sources.apiKey
        ? { name: gateway, status: "manual", detail: `reachable at ${origin}, but it rejected the API key (HTTP ${result.status})`, action: keyAction }
        : { name: gateway, status: "ok", detail: `reachable at ${origin}; requests need the API key (HTTP ${result.status} without it)` });
      break;
    case "http":
      items.push({ name: gateway, status: "error", detail: `HTTP ${result.status} from ${modelsUrl}`,
        action: `Check that CLIProxyAPI is healthy and that the base URL points to it. ${urlAction}` });
      break;
    case "unreachable":
      items.push({ name: gateway, status: "error", detail: `not reachable at ${origin} (${result.reason})`,
        action: `Start CLIProxyAPI, or fix the base URL: ${urlAction}` });
      break;
    case "unverified":
      items.push({ name: gateway, status: "unverified", detail: `could not check ${origin} (${result.reason})`,
        action: `Check by hand: curl -sS -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $CLIPROXYAPI_API_KEY" ${modelsUrl} (200 = OK, 401 = bad key)` });
      break;
  }
  return { items };
}

export const IMAGES_INSTALL_NOTE = "Nothing to install automatically: pi-gateway-images has no installable dependency; "
  + "the CLIProxyAPI service and its credentials are manual.";

/** No installable dependency: re-checks and turns everything the user must fix into "manual". */
export async function installImages(ctx: ImagesDoctorContext | undefined, options: ImagesDoctorOptions = {}): Promise<DependencyReport> {
  const report = await checkImages(ctx, options);
  return {
    note: report.note ? `${IMAGES_INSTALL_NOTE} ${report.note}` : IMAGES_INSTALL_NOTE,
    items: report.items.map((item) => item.status === "error" ? { ...item, status: "manual" as const } : item),
  };
}

export function createImagesDependencyProvider(options: ImagesDoctorOptions = {}): DependencyProvider<ImagesDoctorContext> {
  let installing: Promise<DependencyReport> | undefined;
  return {
    id: IMAGES_DEPENDENCY_ID,
    label: IMAGES_LABEL,
    command: `/${IMAGES_COMMAND}`,
    check: (ctx) => checkImages(ctx, options),
    install: (ctx) => installing ??= installImages(ctx, options).finally(() => { installing = undefined; }),
  };
}

interface CommandUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

async function runMode(provider: DependencyProvider<ImagesDoctorContext>, mode: DependencyMode,
  ctx: ImagesDoctorContext & { ui: CommandUi }): Promise<void> {
  if (mode === "install") ctx.ui.setStatus?.(IMAGES_DEPENDENCY_ID, "pi-gateway-images: checking dependencies…");
  try {
    const report = await (mode === "check" ? provider.check(ctx) : provider.install(ctx));
    const { text, level } = formatDependencyReport(IMAGES_LABEL, report, mode);
    ctx.ui.notify(text, level);
  } catch (error) {
    ctx.ui.notify(`${IMAGES_LABEL} ${mode === "check" ? "doctor" : "install-deps"} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    if (mode === "install") ctx.ui.setStatus?.(IMAGES_DEPENDENCY_ID, undefined);
  }
}

/** Register `/images doctor|install-deps` and answer the umbrella's dependency requests. */
export function registerImagesCommand(pi: Pick<ExtensionAPI, "registerCommand" | "events">,
  options: ImagesDoctorOptions = {}): DependencyProvider<ImagesDoctorContext> {
  const provider = createImagesDependencyProvider(options);
  registerDependencyProvider(pi.events, provider);
  pi.registerCommand(IMAGES_COMMAND, {
    description: "pi-gateway-images maintenance: doctor | install-deps",
    getArgumentCompletions: (prefix) => {
      const word = prefix.trimStart().toLowerCase();
      if (/\s/.test(word)) return null;
      const items = SUBCOMMANDS.filter((item) => item.value.startsWith(word));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "doctor") return runMode(provider, "check", ctx);
      if (sub === "install-deps") return runMode(provider, "install", ctx);
      ctx.ui.notify(IMAGES_USAGE, sub === "" || sub === "help" ? "info" : "warning");
    },
  });
  return provider;
}
