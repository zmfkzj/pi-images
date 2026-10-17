import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { hyperlink } from "@earendil-works/pi-tui";

/**
 * Image file links: an OSC 8 `file://` link on a pasted image's label and cell preview, so a terminal that takes
 * OSC 8 links can open the image file itself. herdr 0.9.5 keeps these links in its attach stream, and
 * herdr-web-ui's terminal opens a `file://` link in its file viewer (the same viewer a `read` path opens).
 */

/** File URIs longer than this are not linked (herdr keeps OSC 8 URIs up to about 2 KiB). */
export const MAX_FILE_LINK = 1024;

/** The `file://` URI of an absolute path: percent-encoded, printable ASCII only, or undefined. */
export function fileLinkUri(path: string): string | undefined {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  let uri: string;
  try { uri = pathToFileURL(path).href; } catch { return undefined; }
  return uri.length <= MAX_FILE_LINK && /^file:\/\/\/[\x21-\x7e]+$/.test(uri) ? uri : undefined;
}

/** `text` linked to the file at `path`, or `text` unchanged when the path cannot be linked. */
export function linkToFile(text: string, path: string): string {
  const uri = fileLinkUri(path);
  return uri ? hyperlink(text, uri) : text;
}

