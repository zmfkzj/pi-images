import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_ORIGIN = "http://127.0.0.1:8317";

export interface ConnectionOptions {
  agentDir?: string;
  env?: Record<string, string | undefined>;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function readObject(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return {}; } // Never include parser errors: they can quote credentials.
}

export function firstString(...values: unknown[]): string | undefined {
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

/** Raw connection values and where each came from (names of sources only, never values). */
export interface ConnectionSources {
  agentDir: string;
  baseUrl: string;
  baseUrlSource: string;
  apiKey?: string;
  apiKeySource?: string;
}

/** Same source precedence as the chat extension; values remain in memory only. */
export function connectionSources(options: ConnectionOptions = {}): ConnectionSources {
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
  const pick = (candidates: [unknown, string][]): [string, string] | undefined => {
    for (const [value, source] of candidates) { const text = firstString(value); if (text) return [text, source]; }
    return undefined;
  };
  const [baseUrl, baseUrlSource] = pick([[env.CLIPROXYAPI_BASE_URL, "CLIPROXYAPI_BASE_URL"],
    [config.baseUrl, "cliproxyapi.json baseUrl"], [meta.baseUrl, "auth.json cliproxyapi login"], [DEFAULT_ORIGIN, "default"]])!;
  const key = pick([[env.CLIPROXYAPI_API_KEY, "CLIPROXYAPI_API_KEY"], [config.apiKey, "cliproxyapi.json apiKey"],
    [authKey, entry.type === "oauth" ? "auth.json cliproxyapi login" : "auth.json cliproxyapi API key"]]);
  return { agentDir, baseUrl, baseUrlSource, apiKey: key?.[0], apiKeySource: key?.[1] };
}

/** Same source precedence as the chat extension; values remain in memory only. */
export function resolveConnection(options: ConnectionOptions = {}): { origin: string; apiKey?: string } {
  const sources = connectionSources(options);
  return { origin: normalizeOrigin(sources.baseUrl), apiKey: sources.apiKey };
}
