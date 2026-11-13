// Images and digital files arrive as an https URL or as base64, because a
// hosted server can't read paths on Matt's computer.

/** Our own cap per file. Big enough for listing photos and most digital downloads. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface LoadedFile {
  bytes: Uint8Array;
  name: string;
  contentType: string;
}

export interface FileSource {
  url?: string;
  base64?: string;
  name?: string;
}

function nameFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() || "");
  return last || "file";
}

function decodeBase64(data: string): Uint8Array {
  // Accept a bare string or a data: URL.
  const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
  const b64 = (comma >= 0 ? data.slice(comma + 1) : data).replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") || "0");
  if (declared > max) throw new Error(`File is ${declared} bytes, over the ${max}-byte limit.`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`File is over the ${max}-byte limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function loadFile(src: FileSource, fetchImpl: typeof fetch = fetch, max = MAX_FILE_BYTES): Promise<LoadedFile> {
  if (src.url && src.base64) throw new Error("Pass either a URL or base64 content, not both.");
  if (src.base64) {
    const bytes = decodeBase64(src.base64);
    if (bytes.byteLength > max) throw new Error(`File is over the ${max}-byte limit.`);
    return { bytes, name: src.name || "file", contentType: "application/octet-stream" };
  }
  if (!src.url) throw new Error("A file URL or base64 content is required.");

  let url: URL;
  try {
    url = new URL(src.url);
  } catch {
    throw new Error(`Not a valid URL: ${src.url}`);
  }
  if (url.protocol !== "https:") throw new Error("Only https:// file URLs are accepted.");
  if (url.username || url.password) throw new Error("File URLs can't carry a username or password.");

  const res = await fetchImpl(url.toString(), { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't download the file: HTTP ${res.status} from ${url.host}.`);
  const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  if (contentType === "text/html") {
    throw new Error(
      `${url.host} returned a web page, not a file. Use a direct download link (for Google Drive or Dropbox, the direct-download form of the share link).`
    );
  }
  const bytes = await readCapped(res, max);
  return { bytes, name: src.name || nameFromUrl(url), contentType };
}
