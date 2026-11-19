// The game's own files for the relay (server.mjs), so a proxy that only routes (Traefik) needs one service and no
// auth middleware: the relay serves them after its own login check, and answers a stranger with a bare 404.
//
//   TW_STATIC_DIR    the built game (app/dist); index.html gets <meta name="tw-relay" content=""> added, so the
//                    page finds the relay on its own site. Unset: no game files are served.
//   TW_DATA_VERSION  the data folder on the original server (the line in trainworld/data-version.txt; read from
//                    ../data-version.txt when that exists)
//   TW_DATA_ORIGIN   where the game's data is published (https://data.anita.garden)
//   TW_DATA_CACHE    where fetched data is kept (./data-cache): each file, and each range of it, is fetched once
//
// /packs/... and /noritetsu/... are what the dev server's `dataFallback` (app/vite.config.ts) answers the same way.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const env = process.env;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const STATIC = env.TW_STATIC_DIR ? path.resolve(env.TW_STATIC_DIR) : null;
const ORIGIN = (env.TW_DATA_ORIGIN ?? "https://data.anita.garden").replace(/\/+$/, "");
const CACHE = path.resolve(env.TW_DATA_CACHE ?? path.join(here, "data-cache"));
function dataVersion() {
  if (env.TW_DATA_VERSION) return env.TW_DATA_VERSION;
  try { return fs.readFileSync(path.join(here, "..", "data-version.txt"), "utf8").trim(); } catch { return ""; }
}
const VERSION = dataVersion();
const KEEP = ["content-type", "content-range", "accept-ranges", "etag", "last-modified"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".geojson": "application/geo+json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

const bare = (res, code) => { res.writeHead(code, { "content-length": 0 }); res.end(); };

async function serveStatic(req, res, p) {
  let rel;
  try { rel = path.normalize(decodeURIComponent(p)); } catch { return bare(res, 404); }
  if (rel.includes("\0")) return bare(res, 404);
  rel = rel.replace(/^([/\\])+/, "");
  let file = path.join(STATIC, rel);
  if (file !== STATIC && !file.startsWith(STATIC + path.sep)) return bare(res, 404);
  let st = await fsp.stat(file).catch(() => null);
  if (st?.isDirectory()) { file = path.join(file, "index.html"); st = await fsp.stat(file).catch(() => null); }
  // a page address (no file extension) is the game's single page
  if (!st && !path.extname(rel) && !p.startsWith("/api/") && p !== "/ws") { file = path.join(STATIC, "index.html"); st = await fsp.stat(file).catch(() => null); }
  if (!st?.isFile()) return bare(res, 404);
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  if (path.basename(file) === "index.html") {
    const html = (await fsp.readFile(file, "utf8")).replace(/<head>/i, '<head><meta name="tw-relay" content="">');
    res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(html), "cache-control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : html);
  }
  res.writeHead(200, {
    "content-type": type, "content-length": st.size,
    "cache-control": file.includes(path.sep + "assets" + path.sep) ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

async function serveData(req, res, target) {
  const range = String(req.headers.range ?? "");
  const id = crypto.createHash("sha1").update(target + "|" + range).digest("hex");
  const dir = path.join(CACHE, id.slice(0, 2)), body = path.join(dir, id), meta = body + ".json";
  let m = await fsp.readFile(meta, "utf8").then(JSON.parse).catch(() => null);
  if (!m) {
    const r = await fetch(target, { headers: range ? { range } : {} });
    if (r.status !== 200 && r.status !== 206) return bare(res, r.status === 404 ? 404 : 502);
    const buf = Buffer.from(await r.arrayBuffer());
    m = { status: r.status, headers: {} };
    for (const k of KEEP) { const v = r.headers.get(k); if (v) m.headers[k] = v; }
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(body + ".tmp", buf);
    await fsp.rename(body + ".tmp", body);
    await fsp.writeFile(meta, JSON.stringify(m));
  }
  const st = await fsp.stat(body);
  res.writeHead(m.status, { ...m.headers, "content-length": st.size, "cache-control": "public, max-age=86400" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(body).pipe(res);
}

/** Answers a signed-in friend's request for a game or data file; false when it is neither (the caller's 404). */
export async function serveGame(req, res, p) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  try {
    if (p.startsWith("/packs/terrain-world/")) { await serveData(req, res, `${ORIGIN}/trainworld/terrain-world/v2/${p.slice("/packs/terrain-world/".length)}`); return true; }
    if (p.startsWith("/packs/") && VERSION) { await serveData(req, res, `${ORIGIN}/trainworld/${VERSION}/${p.slice("/packs/".length)}`); return true; }
    if (p.startsWith("/noritetsu/")) { await serveData(req, res, `${ORIGIN}${p}`); return true; }
    if (STATIC) { await serveStatic(req, res, p); return true; }
  } catch (e) {
    console.error("file error", p, e?.message);
    if (!res.headersSent) bare(res, 502); else res.destroy();
    return true;
  }
  return false;
}

console.log(`files: ${STATIC ? "serving " + STATIC : "no static dir"}, data ${VERSION ? ORIGIN + "/trainworld/" + VERSION : "off"}, cache ${CACHE}`);
