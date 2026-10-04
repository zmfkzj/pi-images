# pi-gateway-images

A Pi 1.0.0 image provider for the CLIProxyAPI gateway's OpenAI Images API.
Node 22+ supplies fetch, FormData and Blob; there are no runtime dependencies.

The model is **`cliproxyapi-images/gpt-image-2.5`**, separate from the chat
extension's `cliproxyapi` provider so its refresh cannot unregister this model.

## `generate_image` tool

The extension also registers a `generate_image` tool in the main session, so you
can just ask: "draw a gold coin icon" or paste an image (`ctrl+v`, or drag it in)
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
- Options: `background`, `size`, `quality`, and `model` (`provider/id` of any
  registered image model; default `cliproxyapi-images/gpt-image-2.5`).

## Codemode

Image models do not appear in `/model`; codemode scripts can call them directly:

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

## Connection and requests

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
