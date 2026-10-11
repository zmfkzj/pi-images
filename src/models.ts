import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** File name of both the bundled and the user image model settings. */
export const MODELS_CONFIG_FILE = "image.models.json";
/** The bundled default image model settings (`src/image.models.json`), used when the user has none. */
export const MODELS_CONFIG_PATH = fileURLToPath(new URL(`./${MODELS_CONFIG_FILE}`, import.meta.url));

/** User settings `<agentDir>/image.models.json`; agentDir is Pi's `getAgentDir()` (default `~/.pi/agent`). */
export function userModelsConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, MODELS_CONFIG_FILE);
}

export type ModelInput = "text" | "image";

export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface ImageModelSettings {
  /** Full id `provider/model`, as written in the settings file (e.g. `cliproxyapi/gpt-image-2.5`). */
  id: string;
  /**
   * Provider part (before the first `/`). `cliproxyapi` models are served by this package's
   * CLIProxyAPI connection; any other provider is looked up in Pi's image model registry.
   */
  provider: string;
  /** Model part (after the first `/`); the model id within the provider. */
  modelId: string;
  /** Applied only to `cliproxyapi` models; other providers keep their registry metadata. */
  name: string;
  /** Applied only to `cliproxyapi` models; other providers keep their registry metadata. */
  input: ModelInput[];
  /** Per-million-token rates for usage cost. Applied only to `cliproxyapi` models. */
  cost: ModelCost;
}

export interface ModelSettings {
  /** Full id (one of `models`) used when the caller names no model. */
  defaultModel: string;
  models: ImageModelSettings[];
}

/** Settings provider whose models this package registers and serves through CLIProxyAPI. */
export const CLIPROXYAPI_PROVIDER = "cliproxyapi";
/**
 * Pi registry provider id under which `cliproxyapi/<model>` entries are registered. It is
 * internal: settings name those models `cliproxyapi/<model>`, never `cliproxyapi-images/<model>`.
 */
export const CLIPROXYAPI_IMAGES_PROVIDER = "cliproxyapi-images";

/** True for settings entries this package registers and serves (provider `cliproxyapi`). */
export function isCliproxyapiModel(model: Pick<ImageModelSettings, "provider">): boolean {
  return model.provider === CLIPROXYAPI_PROVIDER;
}

const INPUTS: readonly ModelInput[] = ["text", "image"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Split `provider/model` at the first `/`; the model part may contain further slashes. */
export function splitModelId(fullId: string): { provider: string; modelId: string } | undefined {
  const match = /^([^\s/]+)\/([^\s/](?:.*[^\s/])?)$/.exec(fullId);
  return match ? { provider: match[1]!, modelId: match[2]! } : undefined;
}

function fullIdProblem(label: string, value: string): string {
  const example = `${CLIPROXYAPI_PROVIDER}/${value.includes("/") ? "<model>" : value}`;
  return `${label} "${value}" must be a full provider/model id such as "${example}"`
    + (value.includes("/") ? "." : ". Bare model ids are no longer supported: prefix the provider in both models[].id and \"defaultModel\".");
}

/**
 * Validate raw settings. Model ids are full `provider/model` ids. `cliproxyapi/<model>`
 * entries are registered and served by this package; entries of any other provider refer to
 * an image model already registered in Pi under that id (their name/input/cost are validated
 * but not applied). Omitted `name` defaults to the model part, `input` to text and image,
 * and `cost` fields to 0. Throws a descriptive error naming `source`.
 */
export function parseModelSettings(raw: unknown, source = MODELS_CONFIG_PATH): ModelSettings {
  const fail = (reason: string): never => { throw new Error(`Invalid image model settings in ${source}: ${reason}`); };
  if (!isObject(raw)) fail("expected a JSON object.");
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.models) || root.models.length === 0) fail("\"models\" must be a non-empty array.");
  const ids = new Set<string>();
  const models = (root.models as unknown[]).map((entry, i): ImageModelSettings => {
    const where = `models[${i}]`;
    if (!isObject(entry)) fail(`${where} must be an object.`);
    const model = entry as Record<string, unknown>;
    if (!nonEmpty(model.id)) fail(`${where}.id must be a non-empty string.`);
    const id = (model.id as string).trim();
    const parts = splitModelId(id);
    if (!parts) fail(fullIdProblem(`${where}.id`, id));
    const { provider, modelId } = parts!;
    if (provider === CLIPROXYAPI_IMAGES_PROVIDER) {
      fail(`${where}.id "${id}" uses this package's internal registry provider "${CLIPROXYAPI_IMAGES_PROVIDER}"; `
        + `write "${CLIPROXYAPI_PROVIDER}/${modelId}" instead.`);
    }
    if (ids.has(id)) fail(`duplicate model id "${id}".`);
    ids.add(id);
    if (model.name !== undefined && !nonEmpty(model.name)) fail(`${where}.name must be a non-empty string.`);
    const input = model.input ?? INPUTS;
    if (!Array.isArray(input) || input.length === 0 || !input.every((value) => INPUTS.includes(value))) {
      fail(`${where}.input must be a non-empty array of "text" and/or "image".`);
    }
    const rawCost = model.cost ?? {};
    if (!isObject(rawCost)) fail(`${where}.cost must be an object.`);
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const field of COST_FIELDS) {
      const value = (rawCost as Record<string, unknown>)[field] ?? 0;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(`${where}.cost.${field} must be a non-negative number.`);
      }
      cost[field] = value as number;
    }
    return { id, provider, modelId, name: nonEmpty(model.name) ? model.name.trim() : modelId,
      input: [...new Set(input as ModelInput[])], cost };
  });
  if (!nonEmpty(root.defaultModel)) fail("\"defaultModel\" must be a non-empty string.");
  const defaultModel = (root.defaultModel as string).trim();
  if (!splitModelId(defaultModel)) fail(fullIdProblem("\"defaultModel\"", defaultModel));
  if (!ids.has(defaultModel)) fail(`"defaultModel" "${defaultModel}" is not one of the configured model ids (${[...ids].join(", ")}).`);
  return { defaultModel, models };
}

function readError(path: string, error: unknown): Error {
  return new Error(`Cannot read image model settings ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

function parseFile(text: string, path: string): ModelSettings {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw readError(path, error); }
  return parseModelSettings(raw, path);
}

/** Read and validate one model settings file (default: the bundled `src/image.models.json`). */
export function loadModelSettings(path = MODELS_CONFIG_PATH): ModelSettings {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw readError(path, error); }
  return parseFile(text, path);
}

export interface ResolvedModelSettings {
  /** File the settings came from. */
  path: string;
  settings: ModelSettings;
}

/**
 * Load the user's `<agentDir>/image.models.json` as a complete replacement of
 * the bundled settings. Only a missing user file falls back to the bundled
 * file; unreadable or invalid user files throw an error naming the file.
 */
export function resolveModelSettings(agentDir = getAgentDir()): ResolvedModelSettings {
  const userPath = userModelsConfigPath(agentDir);
  let text: string;
  try { text = readFileSync(userPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw readError(userPath, error);
    return { path: MODELS_CONFIG_PATH, settings: loadModelSettings(MODELS_CONFIG_PATH) };
  }
  return { path: userPath, settings: parseFile(text, userPath) };
}
