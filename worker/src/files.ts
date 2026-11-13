// Images and digital files arrive as an https URL, as base64, or as a path in
// one private GitHub repo, because a hosted server can't read paths on Matt's
// computer. Files too big to send as base64 and too private for a public link
// go in that repo.

import { defaultFetch } from "./fetch";

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
  /** Path inside the configured GitHub repo, e.g. "etsy-products/x.pdf". */
  githubPath?: string;
  /** Branch, tag or commit for githubPath. Defaults to the repo's default branch. */
  githubRef?: string;
  name?: string;
}

/** Where github_path reads from. Both come from the Worker's env. */
export interface GitHubFiles {
  repo?: string;
  token?: string;
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function typeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return TYPES[ext] || "application/octet-stream";
}

const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

async function loadFromGitHub(src: FileSource, gh: GitHubFiles, fetchImpl: typeof fetch, max: number): Promise<LoadedFile> {
  const path = String(src.githubPath || "").trim();
  const ref = src.githubRef ? String(src.githubRef).trim() : "";
  if (!gh.repo || !gh.token) {
    throw new Error("github_path isn't set up on this server: it needs the GITHUB_FILES_REPO var and the GITHUB_TOKEN secret.");
  }
  if (!SAFE_REPO.test(gh.repo)) throw new Error("GITHUB_FILES_REPO must look like owner/repo.");
  if (!SAFE_PATH.test(path) || path.split("/").some((p) => p === "." || p === "..")) {
    throw new Error("github_path must be a plain relative path like folder/file.pdf.");
  }
  if (ref && (!SAFE_PATH.test(ref) || ref.split("/").some((p) => p === "." || p === ".."))) {
    throw new Error("github_ref must be a branch, tag or commit name.");
  }
  const url = new URL(`https://api.github.com/repos/${gh.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (ref) url.searchParams.set("ref", ref);
  const res = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${gh.token}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "etsy-mcp-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (res.status === 404) throw new Error(`Not found in the files repo: ${path}${ref ? ` at ${ref}` : ""}.`);
  if (!res.ok) throw new Error(`Couldn't read ${path} from the files repo: HTTP ${res.status}.`);
  const bytes = await readCapped(res, max);
  const name = src.name || path.split("/").pop() || "file";
  return { bytes, name, contentType: typeFromName(path) };
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

export async function loadFile(
  src: FileSource,
  fetchImpl: typeof fetch = defaultFetch,
  max = MAX_FILE_BYTES,
  gh: GitHubFiles = {}
): Promise<LoadedFile> {
  if ([src.url, src.base64, src.githubPath].filter(Boolean).length > 1) {
    throw new Error("Pass only one of a URL, base64 content or github_path.");
  }
  if (src.githubPath) return loadFromGitHub(src, gh, fetchImpl, max);
  if (src.base64) {
    const bytes = decodeBase64(src.base64);
    if (bytes.byteLength > max) throw new Error(`File is over the ${max}-byte limit.`);
    return { bytes, name: src.name || "file", contentType: "application/octet-stream" };
  }
  if (!src.url) throw new Error("A file URL, base64 content or github_path is required.");

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
