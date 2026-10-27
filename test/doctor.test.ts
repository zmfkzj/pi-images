// `/images doctor|install-deps` and the umbrella dependency provider, against a local fake CLIProxyAPI (no image
// request, no real credential, temporary agent directories only).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkImages, createImagesDependencyProvider, installImages, registerImagesCommand, type ImagesDoctorOptions } from "../src/doctor.ts";
import { DEPENDENCY_CHANNEL, type DependencyProvider } from "../src/dependencies.ts";

const KEY = "sk-doctor-test-key-0123456789";
let agentDir: string;
const servers: Server[] = [];
let requests: { method?: string; url?: string; auth?: string }[];

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A fake CLIProxyAPI: 200 on /v1/models with the right key, 401 otherwise. */
const gateway = (request: IncomingMessage, response: ServerResponse) => {
  if (request.url === "/v1/models" && request.headers.authorization === `Bearer ${KEY}`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-image-2.5" }] }));
    return;
  }
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: `bad key ${request.headers.authorization}` } }));
};

function options(env: Record<string, string | undefined>, extra: ImagesDoctorOptions = {}): ImagesDoctorOptions {
  return { agentDir, env, timeoutMs: 2_000, ...extra };
}

const byName = (report: { items: { name: string }[] }, name: string) => report.items.find((item) => item.name === name) as
  { name: string; status: string; detail?: string; action?: string } | undefined;

function ctx(registered: string[] = []) {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: { getModelOfType: (_type: string, provider: string, id: string) =>
      registered.includes(`${provider}/${id}`) ? { provider, id } : undefined },
  };
}

beforeEach(() => { agentDir = mkdtempSync(join(tmpdir(), "pi-images-doctor-")); requests = []; });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  rmSync(agentDir, { recursive: true, force: true });
});

describe("check", () => {
  it("is healthy with a reachable gateway that accepts the key, and never shows the key", async () => {
    const url = await serve(gateway);
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: `${url}/v1`, CLIPROXYAPI_API_KEY: KEY }));
    expect(report.items.map((item) => [item.name, item.status])).toEqual([
      ["image model settings", "ok"], ["CLIProxyAPI base URL", "ok"], ["CLIProxyAPI credentials", "ok"], ["CLIProxyAPI image gateway", "ok"]]);
    expect(byName(report, "CLIProxyAPI base URL")!.detail).toBe(`${url} (from CLIPROXYAPI_BASE_URL)`);
    expect(byName(report, "CLIProxyAPI credentials")!.detail).toBe("API key set (from CLIPROXYAPI_API_KEY)");
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(requests).toEqual([{ method: "GET", url: "/v1/models", auth: `Bearer ${KEY}` }]);
  });

  it("resolves the key from the auth.json login like the adapter, and reports its source only", async () => {
    const url = await serve(gateway);
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cliproxyapi: { type: "oauth", access: KEY, refresh: JSON.stringify({ baseUrl: url }) } }));
    const report = await checkImages(ctx(), options({}));
    expect(byName(report, "CLIProxyAPI base URL")!.detail).toBe(`${url} (from auth.json cliproxyapi login)`);
    expect(byName(report, "CLIProxyAPI credentials")!.detail).toBe("API key set (from auth.json cliproxyapi login)");
    expect(byName(report, "CLIProxyAPI image gateway")!.status).toBe("ok");
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("reports a missing key as manual (the internal auth marker is not a credential)", async () => {
    const url = await serve(gateway);
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url }));
    expect(byName(report, "CLIProxyAPI credentials")).toMatchObject({ status: "manual", detail: "API key not set" });
    expect(byName(report, "CLIProxyAPI credentials")!.action).toContain("/login CLIProxyAPI");
    expect(byName(report, "CLIProxyAPI credentials")!.action).toContain("CLIPROXYAPI_API_KEY");
    expect(byName(report, "CLIProxyAPI image gateway")).toMatchObject({ status: "ok" });
    expect(requests[0]!.auth).toBeUndefined();
  });

  it("reports a rejected key as manual with the login action", async () => {
    const url = await serve(gateway);
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: "sk-wrong-key-0123456789" }));
    const item = byName(report, "CLIProxyAPI image gateway")!;
    expect(item.status).toBe("manual");
    expect(item.detail).toContain("rejected the API key (HTTP 401)");
    expect(item.action).toContain("/login CLIProxyAPI");
    expect(JSON.stringify(report)).not.toContain("sk-wrong-key");
  });

  it("reports an unreachable gateway as an error with the start/fix action", async () => {
    const url = await serve(gateway);
    await new Promise((done) => servers.pop()!.close(done));
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }));
    const item = byName(report, "CLIProxyAPI image gateway")!;
    expect(item).toMatchObject({ status: "error", detail: `not reachable at ${url} (ECONNREFUSED)` });
    expect(item.action).toContain("Start CLIProxyAPI");
    expect(item.action).toContain("CLIPROXYAPI_BASE_URL");
  });

  it("reports a gateway that does not answer in time as unverified with a manual check", async () => {
    const url = await serve(() => { /* never answers */ });
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }, { timeoutMs: 200 }));
    const item = byName(report, "CLIProxyAPI image gateway")!;
    expect(item.status).toBe("unverified");
    expect(item.action).toContain(`curl`);
    expect(item.action).toContain(`${url}/v1/models`);
    expect(item.action).not.toContain(KEY);
  });

  it("reports other HTTP failures as errors", async () => {
    const url = await serve((_request, response) => { response.writeHead(502); response.end(); });
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }));
    expect(byName(report, "CLIProxyAPI image gateway")).toMatchObject({ status: "error", detail: `HTTP 502 from ${url}/v1/models` });
  });

  it("reports an invalid base URL and an invalid cliproxyapi.json without showing their contents or probing", async () => {
    writeFileSync(join(agentDir, "cliproxyapi.json"), `{ "apiKey": "${KEY}", broken`);
    const report = await checkImages(ctx(), options({ CLIPROXYAPI_BASE_URL: "ftp://user:secret@gateway.test" }));
    expect(byName(report, "cliproxyapi.json")).toMatchObject({ status: "error" });
    expect(byName(report, "CLIProxyAPI base URL")).toMatchObject({ status: "error", detail: "invalid http(s) URL (from CLIPROXYAPI_BASE_URL)" });
    expect(byName(report, "CLIProxyAPI base URL")!.action).toContain("CLIPROXYAPI_BASE_URL");
    expect(byName(report, "CLIProxyAPI image gateway")).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("needs no CLIProxyAPI connection for other providers' models and looks them up in Pi's registry", async () => {
    writeFileSync(join(agentDir, "image.models.json"), JSON.stringify({ defaultModel: "vendor/painter",
      models: [{ id: "vendor/painter" }, { id: "other/missing" }] }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const report = await checkImages(ctx(["vendor/painter"]), options({}, { fetch }));
    expect(report.note).toContain("no CLIProxyAPI connection is needed");
    expect(report.items.map((item) => [item.name, item.status])).toEqual([
      ["image model settings", "ok"], ["image model vendor/painter", "ok"], ["image model other/missing", "error"]]);
    expect(byName(report, "image model other/missing")!.action).toContain("other image models");
    expect(fetch).not.toHaveBeenCalled();
    expect(byName(await checkImages(undefined, options({}, { fetch })), "image model vendor/painter")!.status).toBe("unverified");
  });

  it("reports invalid image model settings with the file to fix", async () => {
    writeFileSync(join(agentDir, "image.models.json"), JSON.stringify({ defaultModel: "x", models: [] }));
    const report = await checkImages(ctx(), options({}));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ name: "image model settings", status: "error" });
    expect(report.items[0]!.action).toContain(join(agentDir, "image.models.json"));
  });

  it("inside a herdr pane, checks that herdr's pi integration is installed for terminal images", async () => {
    writeFileSync(join(agentDir, "image.models.json"), JSON.stringify({ defaultModel: "vendor/painter", models: [{ id: "vendor/painter" }] }));
    const pane = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p4", HERDR_SOCKET_PATH: "/run/herdr.sock" };
    const integration = join(agentDir, "extensions", "herdr-agent-state.ts");
    const missing = byName(await checkImages(ctx(["vendor/painter"]), options(pane)), "herdr pi integration")!;
    expect(missing).toMatchObject({ status: "manual", action: "Run `herdr integration install pi` on this PC, then /reload or restart pi" });
    expect(missing.detail).toContain(integration);
    expect(byName(await installImages(ctx(["vendor/painter"]), options(pane)), "herdr pi integration")!.status).toBe("manual");
    mkdirSync(join(agentDir, "extensions"));
    writeFileSync(integration, "// installed by herdr\n");
    expect(byName(await checkImages(ctx(["vendor/painter"]), options(pane)), "herdr pi integration")!.status).toBe("ok");
    // outside herdr (or without its pane variables) there is nothing to check
    expect(byName(await checkImages(ctx(["vendor/painter"]), options({ ...pane, HERDR_PANE_ID: undefined })), "herdr pi integration")).toBeUndefined();
  });
});

describe("install", () => {
  it("installs nothing, says so, and is repeatable", async () => {
    const url = await serve(gateway);
    const env = { CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY };
    const provider = createImagesDependencyProvider(options(env));
    for (let i = 0; i < 2; i++) {
      const report = await provider.install(ctx());
      expect(report.note).toContain("Nothing to install automatically");
      expect(report.items.every((item) => item.status === "ok")).toBe(true);
    }
    expect(requests.every((request) => request.method === "GET" && request.url === "/v1/models")).toBe(true);
  });

  it("turns what the user must fix into manual actions", async () => {
    const url = await serve(gateway);
    await new Promise((done) => servers.pop()!.close(done));
    const report = await installImages(ctx(), options({ CLIPROXYAPI_BASE_URL: url }));
    expect(byName(report, "CLIProxyAPI image gateway")).toMatchObject({ status: "manual" });
    expect(byName(report, "CLIProxyAPI image gateway")!.action).toContain("Start CLIProxyAPI");
    expect(byName(report, "CLIProxyAPI credentials")).toMatchObject({ status: "manual" });
  });

  it("reuses an install that is already running", async () => {
    const url = await serve(gateway);
    const provider = createImagesDependencyProvider(options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }));
    const first = provider.install(ctx());
    expect(provider.install(ctx())).toBe(first);
    await first;
  });
});

describe("command and provider registration", () => {
  function fakePi() {
    const handlers = new Map<string, ((data: unknown) => void)[]>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown; description?: string }>();
    const pi = {
      events: { on(channel: string, handler: (data: unknown) => void) { handlers.set(channel, [...handlers.get(channel) ?? [], handler]); return () => {}; },
        emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) handler(data); } },
      registerCommand: (name: string, command: never) => { commands.set(name, command); },
    };
    return { pi, commands };
  }

  it("answers the umbrella's request synchronously with the images provider", () => {
    const { pi } = fakePi();
    registerImagesCommand(pi as never, options({}));
    const provided: DependencyProvider[] = [];
    pi.events.emit(DEPENDENCY_CHANNEL, { version: 1, provide: (provider: DependencyProvider) => provided.push(provider) });
    expect(provided.map((provider) => [provider.id, provider.label, provider.command])).toEqual([["images", "pi-gateway-images", "/images"]]);
  });

  it("/images doctor and install-deps notify the formatted report; other input shows usage", async () => {
    const url = await serve(gateway);
    const { pi, commands } = fakePi();
    registerImagesCommand(pi as never, options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }));
    const command = commands.get("images")!;
    expect(command.description).toContain("doctor");
    const context = ctx();
    await command.handler(" doctor ", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^pi-gateway-images doctor: healthy\n.*\[ok\] CLIProxyAPI image gateway/s), "info");
    await command.handler("install-deps", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^pi-gateway-images install-deps: already available\n {2}Nothing to install automatically/), "info");
    expect(context.ui.setStatus).toHaveBeenLastCalledWith("images", undefined);
    await command.handler("", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage: /images doctor"), "info");
    await command.handler("bogus", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage: /images doctor"), "warning");
    expect(command.getArgumentCompletions!("")).toEqual([expect.objectContaining({ value: "doctor" }), expect.objectContaining({ value: "install-deps" })]);
    expect(command.getArgumentCompletions!("ins")).toEqual([expect.objectContaining({ value: "install-deps" })]);
    expect(command.getArgumentCompletions!("zzz")).toBeNull();
  });

  it("an abnormal doctor notifies at error level with the action", async () => {
    const url = await serve(gateway);
    await new Promise((done) => servers.pop()!.close(done));
    const { pi, commands } = fakePi();
    registerImagesCommand(pi as never, options({ CLIPROXYAPI_BASE_URL: url, CLIPROXYAPI_API_KEY: KEY }));
    const context = ctx();
    await commands.get("images")!.handler("doctor", context);
    expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^pi-gateway-images doctor: abnormal\n.*-> Start CLIProxyAPI/s), "error");
  });
});
