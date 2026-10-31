# pi-gateway-images

A Pi 1.0.0 image provider for the CLIProxyAPI gateway's OpenAI Images API.
Node 22+ supplies fetch, FormData and Blob; there are no runtime dependencies.

Models are configured and selected as **`cliproxyapi/gpt-image-2.5`**
(`provider/model`, see [Model settings](#model-settings)). In Pi's model
registry they are registered as `cliproxyapi-images/gpt-image-2.5`, separate
from the chat extension's `cliproxyapi` provider so its refresh cannot
unregister them (and they cannot replace its chat models or credentials).
Image models of other providers already registered in Pi (for example
`openrouter/google/gemini-2.5-flash-image`) can be selected the same way,
including as the default; they use their own provider's connection and auth.

## `generate_image` tool

The extension also registers a `generate_image` tool in the main session, so you
can just ask: "draw a gold coin icon" or paste an image (`ctrl+v`, `cmd+v`, or drag it in)
and ask "make this pixel art".

- **Display:** the result is returned as an image block, so Pi shows it inline
  in terminals with an image protocol (kitty, iTerm2, WezTerm, Ghostty...; see
  `terminal.showImages` / `PI_IMAGE_PROTOCOL`). The model sees it too.
- **Input:** `references` takes image file paths (absolute, `~/`, `@path` or
  relative to the working directory; pasted clipboard images arrive as such
  paths), `"attached"` for every image attached to the latest user message with
  images (e.g. `pi @photo.png "..."`), or `"attached:N"` for its N-th image.
  PNG, JPEG, WebP and GIF, up to 20 MiB each.
- **Output:** saved to `path` (relative to the working directory; the extension
  follows the produced format) or to `<tmpdir>/pi-images/` by default.
- Options: `background`, `size`, `quality`, and `model` (`provider/model`;
  default `defaultModel` from `image.models.json`, `cliproxyapi/gpt-image-2.5`).
  `cliproxyapi/<model>` selects a model configured for CLIProxyAPI. Any other
  name is looked up in Pi's registry as given, so `cliproxyapi-images/<model>`
  and image models of other providers (e.g. `openrouter/<model>`) also work.
  An unknown or non-image model fails with `Unknown image model ...` and the
  list of available image models.

## Pasted images

- **Preview:** a pasted image shows above the editor at once. This covers Pi's
  clipboard paste, a dropped file, and herdr's `--remote` clipboard bridge,
  which pastes a staged path. A paste counts as an image paste only when it
  consists entirely of paths to existing image files.
- **Attach:** on submit, those images are attached to the message, so the model
  sees them without a `read` call. The path stays in the text for
  `generate_image`. The images also stay visible in the transcript, below the
  message. That transcript entry stores paths only, so a staged file that has
  since been deleted shows as unavailable. This also applies when the message
  starts with the image path, as after `ctrl+v` into an empty editor. Shell
  commands (`!`), prompt templates and skills (`/name` of a registered command)
  are left as they are; other text that starts with `/` is an ordinary message.
- **Held-back prompts:** an extension that holds a prompt back before Pi's
  input chain reaches this one (pi-session-bus's work queue) asks for the
  prompt's images on the event-bus channel `pi-images:attachments`
  (`ATTACHMENTS_CHANNEL`): `{ text, cwd?, existing?, provide(images) }`.
  `provide` is called synchronously with the new images only, and the paste
  ends as on submit. Messages that extensions send are never given images, so
  the replayed prompt is not attached twice.
- **Cmd+V:** `super+v` (Cmd+V reported through the kitty keyboard protocol)
  and the empty bracketed paste that terminals send for an image-only clipboard
  both run Pi's clipboard paste, the same as `ctrl+v`. Under `herdr --remote`,
  herdr consumes the empty paste itself and bridges the image.
- **In herdr (and its web terminal):** inside a herdr pane (`TERM_PROGRAM=herdr`)
  the draft preview and the transcript entry are drawn as text cells: upper half
  blocks (`▀`) with the pixel colors as foreground/background, two pixel rows per
  cell row, up to 60×10 cells for the draft and 60×15 in the transcript. herdr's
  attach stream, and so herdr-web-ui's terminal, drops Kitty graphics, so a
  native image without a terminal image reference (below) would leave the label
  above blank rows there. The cells are a
  coarse thumbnail (about 2 pixels per cell), also in herdr's own client. Pi
  scales and converts the file first (PNG, JPEG, WebP, GIF); the cells appear
  once that finishes (a few hundred ms for a large screenshot, decoded once per
  file), and a file Pi cannot decode falls back to Pi's own image.
  `PI_IMAGES_CELL_PREVIEWS=0` keeps Pi's image inside herdr, `=1` uses cells
  elsewhere. It is read at session start, so `/reload` applies it; an exported
  variable needs a Pi restart. Elsewhere the previews are unchanged. Checks:
  `test/cell-preview.test.ts`, `test/paste.test.ts`.
  Where Pi writes terminal image markers (below), the previews are native
  images named by their file instead, which herdr-web-ui draws at full
  resolution and opens on click; the cells are the fallback when a picture gets
  no marker.
- **Opening the image:** where the terminal takes OSC 8 hyperlinks (herdr,
  Kitty, Ghostty, WezTerm, iTerm2...; `PI_HYPERLINKS=0|1` overrides Pi's
  detection), the `image <name>` label and every cell row of a cell preview are
  a `file://` link to the image file (herdr-web-ui opens it in its file viewer).
  A file that is gone is not linked.

## Images in the herdr web terminal

herdr's attach stream, and so herdr-web-ui's terminal, carries text, cursor and
OSC 8 hyperlinks but drops Kitty graphics (herdr 0.9.5). So that tool-result
images Pi shows natively can also appear inline in that web terminal (local or
remote PC), the extension writes a **terminal image reference** next to each
native Kitty image. The web terminal draws the image at that place; native
rendering is unchanged.

- **When:** in the interactive TUI, when Pi's image protocol is Kitty and Pi
  runs in a herdr pane (`TERM_PROGRAM=herdr`, also inside `herdr --remote`).
  `PI_IMAGES_TERMINAL_REFS=0` turns it off, `=1` turns it on outside herdr
  (still Kitty only). Elsewhere the rendered output is byte-identical.
- **Needs herdr's pi integration** (`herdr integration install pi`, which writes
  `<agent dir>/extensions/herdr-agent-state.ts`) on every PC where Pi runs,
  remote PCs included: it reports the pane's pi session to herdr, and the web
  side draws a marker only for that session. Without it herdr names no session
  for the pane, so every terminal image (tool results and pasted pictures)
  stays blank rows there, and herdr-web-ui's chat has no transcript either.
  Inside a herdr pane, Pi warns once at session start when the file is missing
  and `/images doctor` lists it as a manual action; install it, then `/reload`
  or restart Pi.
- **Which images:** only images of tool results on the current branch of the
  current session (`read`, `generate_image`, MCP and other tools; not nested
  `ctx.executeTool()` results). Paste previews, the `pasted-images` transcript
  entry and other images get no reference, because the web side serves only
  stored tool-result images.
- **Marker (contract v1, agreed with herdr-web-ui):** on each image row
  `y = 1 … r-1` (only `y = 0` for a one-row image), the cell right after the
  image, column `left + c`, holds `U+2800` (a blank glyph) wrapped in an OSC 8
  link:

  ```
  ESC ] 8 ; ; x-pi-image:v1?s=<session id>&ref=<pi:toolCallId:n>&h=<32 hex>&c=<cols>&r=<rows>&y=<row> ESC \  U+2800  ESC ] 8 ; ; ESC \
  ```

  `s` is the session id (the JSONL header id), `ref` is the web endpoint's
  existing image ref, with `n` counting the result's image blocks
  that have base64 data and a PNG/JPEG/GIF/WebP MIME type. The tool call id
  in it is opaque and provider-specific (Responses-style providers store
  `call_…|fc_…`), so `s` and `ref` are percent-encoded strictly (RFC 3986:
  everything but `A-Z a-z 0-9 - . _ ~`) and the query never holds other
  characters than `A-Z a-z 0-9 - . _ ~ % : = &`. `h` is the first 32
  hex characters of SHA-256 over the decoded bytes stored in the session (not
  the Kitty PNG conversion), `c`×`r` the native placement in cells. URIs are
  at most 512 characters; there are no paths, URLs or image bytes. Row 0 of a
  taller image carries no marker because fullscreen Pi moves the cropped image
  line to the first visible row when the image is scrolled partly out of view.
- **Web side (herdr-web-ui, not this package):** records each marker at the
  OSC 8 cursor position, keeps it only while that cell still reads `U+2800`
  (erased or overwritten cells drop it), computes the image at
  `(x - c, row - y)`, fetches `ref` through its authenticated, pane-scoped
  `/api/pane/conversation/image` (per machine for remote PCs) with the session
  `s`, and draws nothing unless the pane's current session is `s`, the ref is
  on its active branch and the bytes match `h`.
- **Limits:** when the same image bytes are the result of several tool calls,
  every copy names the newest call (same digest, same picture). After Pi quits,
  the transcript it leaves on the screen keeps its markers, but the web side no
  longer resolves them because the pane no longer runs that session. Image
  rows that have left herdr's screen (no scrollback in the attach) are not
  drawn; partly visible images are drawn from their remaining rows.
- **Pasted pictures (`file:` refs):** the draft preview and the transcript
  entry draw each picture as a native image named by its file
  (`markFileImage`): its markers carry `ref=file:<absolute path>` instead of a
  tool result's ref, whatever tool result holds the same bytes, and `h` is the
  digest of the bytes drawn. herdr-web-ui serves such a ref only for a marker's
  session- and digest-bound read, so a file changed or removed since shows
  nothing. A path the web would not take (relative, `.`/`..` segments, control
  characters, over 1024 characters, a marker URI over 512) or a type it does
  not serve gets no marker, and the preview falls back to the text cells.
- **Only for a session on disk:** Pi writes a new session's JSONL only with
  its first message (and never with `--no-session`), and the web side resolves
  a marker's `s` from that file. Until the file exists no image gets a marker:
  a paste preview drawn before the first message is the text cells (not blank
  rows), and the same preview switches to the native, marked picture once the
  file is written. Native Kitty output is unchanged either way.
- **Opening a picture (web side):** herdr-web-ui opens a click on any drawn
  picture (tool result or pasted) in its image viewer: enlarge, download and
  pi's image comments.

The only hook that sees every native image is pi-tui's `Image` component, which
Pi and its extensions share; the extension wraps `Image.prototype.render` once
per process; while no session provides markers, the wrapper returns Pi's own
render result unchanged. Checks: `test/terminal-refs.test.ts` (and
`test/doctor.test.ts` for the herdr pi integration check).

## Codemode

Image models do not appear in `/model`; codemode scripts can call them directly.
Codemode reads Pi's registry, so this package's models need the registry
provider `cliproxyapi-images`, not the `cliproxyapi/...` name from
`image.models.json` (other providers' models keep their own registry ids):

```js
const model = await models.getModelOfType("image", "cliproxyapi-images", "gpt-image-2.5");
const result = await models.generateImages(model, {
  input: [{ type: "text", text: "A gold coin icon on transparent background" }],
});
if (result.stopReason !== "stop") return result.errorMessage;
for (const block of result.output) if (block.type === "image") image(block);
```

For SDK/extension use, export `createProviderConfig()` and register it with
`runtime.registerProvider(PROVIDER_ID, createProviderConfig())`. The exported
`generateImages(model, context, options)` also works directly.

## Model settings

The image models and the default model live in `image.models.json` files, not
in code. One file is used, chosen when the extension loads:

1. **`~/.pi/agent/image.models.json`** (your settings). The directory is
   Pi's agent directory, so `PI_CODING_AGENT_DIR` moves it, the same as
   `cliproxyapi.json`. When present it **replaces** the bundled file
   completely. Nothing is merged, so list every model you want, including the
   default.
2. **`src/image.models.json`** in this package (the bundled defaults). It is
   used only when the user file does not exist.

To customize, copy the bundled file to `~/.pi/agent/image.models.json` and edit
the copy. This keeps package updates from overwriting your changes. Format:

```json
{
  "defaultModel": "cliproxyapi/gpt-image-2.5",
  "models": [
    { "id": "cliproxyapi/gpt-image-2.5", "name": "GPT Image 2.5", "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
  ]
}
```

- `models[].id`: full `provider/model` id, split at the first `/`.
  - **`cliproxyapi/<model>`**: served by this package through the CLIProxyAPI
    gateway with the credentials described in
    [Connection and requests](#connection-and-requests). These models are
    registered in Pi as `cliproxyapi-images/<model>`, and the **model** part
    is sent as the request's `model`, unchanged and without the provider
    prefix. It may contain further slashes: `cliproxyapi/vendor/model` sends
    `vendor/model`.
  - **Any other provider** (e.g. `openrouter/google/gemini-2.5-flash-image`):
    a reference to an image model that is already registered in Pi under
    exactly that `provider/model` id. This package does not register,
    replace or connect to it; the request goes to that provider with its own
    connection, auth (e.g. `OPENROUTER_API_KEY` or `/login`) and registry
    metadata. The provider must therefore be installed (built-in or another
    extension), have the model registered as an **image** model, and be
    authenticated. No CLIProxyAPI connection is needed for these models.
  - `cliproxyapi-images/<model>` is rejected here: it is this package's
    internal registry id; write `cliproxyapi/<model>` instead. (The `model`
    tool argument still accepts it.)
  - The same model name may appear under several providers
    (`cliproxyapi/gpt-image-2.5` and `other/gpt-image-2.5`); each id routes to
    its own provider.
- `name` (default: the model part), `input` (`text`/`image`, default both) and
  `cost` (per-million-token rates for usage cost, default 0) are optional.
  They are **validated for every entry but applied only to `cliproxyapi`
  models**. Other providers' models always keep their registry name, input
  types (whether references are accepted) and cost; you may omit these fields.
- `defaultModel`: one of the full ids above, of any provider. It is the
  `generate_image` default and the exported `DEFAULT_MODEL`. The exported
  `MODEL_ID` is its model part.

Example with another provider's model as the default (CLIProxyAPI kept for
explicit use; drop its entry if you do not use the gateway at all, and nothing
is registered under `cliproxyapi-images`):

```json
{
  "defaultModel": "openrouter/google/gemini-2.5-flash-image",
  "models": [
    { "id": "openrouter/google/gemini-2.5-flash-image" },
    { "id": "cliproxyapi/gpt-image-2.5", "name": "GPT Image 2.5" }
  ]
}
```

Whether a referenced model exists is checked when `generate_image` runs, not
when the file loads (other extensions may register providers later): an
unknown or non-image model fails with `Unknown image model <id>. Available: ...`,
and a provider without auth fails with Pi's own error (e.g. `Provider is not
configured: openrouter`).

To switch the default, add the model to `models` and set `defaultModel` to its
full id. The file is read when the extension loads, so restart Pi or run
`/reload` after editing it. An unreadable, malformed or invalid file (including
the user file) stops the extension from loading with an error that names the
file and the problem. It never falls back to the bundled file silently.
Explicit model names elsewhere (the codemode example above, `images.model` in
`orche.config.json`, a `model` tool argument) do not follow `defaultModel`;
update them yourself. Codemode and orche look models up in Pi's registry, so
for CLIProxyAPI models they keep using `cliproxyapi-images/<model>`; other
providers' models use the same id as in `image.models.json`.

**Migrating from bare ids.** Earlier versions used bare ids such as
`"gpt-image-2.5"`. These are now rejected with an error that names the file.
Prefix the provider in **both** `models[].id` and `defaultModel`:

```diff
-  "defaultModel": "gpt-image-2.5",
-  "models": [{ "id": "gpt-image-2.5", ... }]
+  "defaultModel": "cliproxyapi/gpt-image-2.5",
+  "models": [{ "id": "cliproxyapi/gpt-image-2.5", ... }]
```

## Install

```sh
pi install git:github.com/zmfkzj/pi-images
```

To let [pi-orche](https://github.com/zmfkzj/pi-orche) `game-asset`/`video`
workers use it through `generate_image`, list the same source in
`~/.pi/agent/orche.config.json`. orche loads only packages installed at user
scope, so run `pi install` first:

```json
{
  "providerExtensions": ["npm:@router-for-me/pi-cliproxyapi-provider", "git:github.com/zmfkzj/pi-images"],
  "images": { "model": "cliproxyapi-images/gpt-image-2.5" }
}
```

orche resolves `images.model` in Pi's registry itself, so it takes the registry
id `cliproxyapi-images/<model>`, not `cliproxyapi/<model>` (other providers'
image models: their own `provider/model` id).

## Connection and requests

This connection applies only to `cliproxyapi/<model>` entries; other providers'
models use their own provider configuration in Pi.

Resolution order (the Pi agent directory comes from `getAgentDir()`):

- URL: `CLIPROXYAPI_BASE_URL` → `cliproxyapi.json.baseUrl` → the `cliproxyapi`
  OAuth entry's refresh JSON `baseUrl` in `auth.json` → `http://127.0.0.1:8317`.
- Key: `CLIPROXYAPI_API_KEY` → `cliproxyapi.json.apiKey` → the `cliproxyapi`
  entry's OAuth `access` or API-key `key` in `auth.json`.

Only the URL's scheme/host/port is used. Credentials are resolved at request
time, never logged or stored by this package. An explicit request `apiKey`
overrides the above; provider-scoped `env` overrides process environment.
The registered config contains a **non-secret internal authentication marker**
to satisfy Pi's authentication-before-dispatch requirement. It is never sent
to the gateway. The adapter returns an actionable error if the real key is
missing (the catalog entry alone does not guarantee working credentials).

Text input uses `POST /v1/images/generations`; image input uses
`POST /v1/images/edits` with named Blob file parts under singular `image`
(repeated for multiple references). The live smoke confirms one reference;
multiple references are unit-tested, not live-tested. Output is base64 PNG.
Metadata `background`, `size`, and `quality` are forwarded; the gateway honors
transparent backgrounds but may ignore size/quality. Resize locally for exact
asset dimensions. The adapter forwards abort, timeout (default 180 seconds),
fetch, headers and payload/response callbacks. POSTs are not automatically
retried to avoid duplicate billing/generation.

## `/images doctor` and `/images install-deps`

`/images doctor` checks what image generation needs and tells you what to do
when something is wrong (the oh-my-pi-extensions umbrella runs the same check
from `/oh-my-pi doctor`). It is read-only:

- **image model settings**: the user `image.models.json` (or the bundled
  defaults) re-read and validated; invalid files are an error naming the file.
- **image model `<provider>/<model>`** (other providers only): registered in
  Pi's image model registry, else an error (install/enable that provider's
  extension or change the setting). These models need no CLIProxyAPI.
- Only when a `cliproxyapi/<model>` entry is configured:
  - **cliproxyapi.json**: an error if the file exists but is not a JSON object
    (its `baseUrl`/`apiKey` are then ignored);
  - **CLIProxyAPI base URL**: resolved as above; shows the origin and its
    source, an invalid URL is an error (its value is not shown);
  - **CLIProxyAPI credentials**: "set" with its source or "not set" (manual:
    `/login CLIProxyAPI`, `CLIPROXYAPI_API_KEY` or `cliproxyapi.json` `apiKey`).
    The internal authentication marker never counts as a credential. Keys are
    never shown;
  - **CLIProxyAPI image gateway**: one `GET <origin>/v1/models` with a 3 s
    timeout (never an image request). 200 is ok; 401/403 with a key is manual
    (log in again or fix the key); connection refused or unknown host is an
    error (start CLIProxyAPI or fix the base URL); a timeout or other network
    failure is unverified, with a `curl` command to check by hand.
- **herdr pi integration** (only inside a herdr pane: `HERDR_ENV=1`,
  `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`): ok when
  `<agent dir>/extensions/herdr-agent-state.ts` exists, else manual
  (`herdr integration install pi`, then `/reload`); see
  [Images in the herdr web terminal](#images-in-the-herdr-web-terminal).

`/images install-deps` installs nothing: this package has no automatically
installable dependency (it needs only Pi and Node.js; the CLIProxyAPI service
and its credentials are set up by you). It says so, re-runs the check and
reports every problem as a manual action. Both subcommands work on every
platform Pi supports.

## Checks

```sh
npm install
npm run typecheck
npm test
# Opt-in: exactly one generation and one edit, images stay in memory:
LIVE_IMAGES=1 npm test -- test/images.live.test.ts
```

Live tests skip by default. PNG verification uses Node's zlib plus PNG
header/chunk/raster checks, without ImageMagick or extra dependencies.
