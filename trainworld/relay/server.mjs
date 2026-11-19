// A private co-op relay and lobby for trainsworld.
//
// - Nothing is visible without a session cookie: every unknown or unauthorised request answers a bare 404.
// - Friends log in with an invite code (TW_INVITES="alice:code1,bob:code2"); the code names them.
// - A game is a room. Its host (a browser tab) creates it over HTTP, then every member joins the room's WebSocket;
//   the relay forwards each frame to every other member and stores nothing.
// - The proxy in front (nginx/Caddy) sends /api and /ws here, and asks /api/auth before serving any game file.
//
// Settings (environment): PORT (8787), BIND (127.0.0.1), TW_INVITES, TW_SECRET (signs the cookie; random per start
// if unset), TW_LOGIN_PATH (/login: make it a secret), TW_SECURE=1 (cookie only over https), TW_TRUST_PROXY=1 (take
// the client address from X-Forwarded-For), TW_ORIGINS (extra browser origins allowed to call the API, for a dev
// page on another port), TW_GRACE_S (how long a room outlives its host's connection, 90).

import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const env = process.env;
const PORT = Number(env.PORT ?? 8787), BIND = env.BIND ?? "127.0.0.1";
const LOGIN_PATH = env.TW_LOGIN_PATH ?? "/login";
const SECRET = env.TW_SECRET || crypto.randomBytes(32).toString("hex");
const SECURE = env.TW_SECURE === "1", TRUST_PROXY = env.TW_TRUST_PROXY === "1";
const ORIGINS = (env.TW_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const GRACE_MS = Number(env.TW_GRACE_S ?? 90) * 1000;
const COOKIE = "tw_session", COOKIE_S = 30 * 24 * 3600;
const MAX_FRAME = 64 * 1024 * 1024;

/** "alice:code1,bob:code2" -> [{name, code}] */
const invites = (env.TW_INVITES ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
  const i = s.indexOf(":");
  return i > 0 ? { name: s.slice(0, i), code: s.slice(i + 1) } : null;
}).filter(Boolean);
if (!invites.length) console.warn("TW_INVITES is empty: nobody can log in");

// ---- sessions: a signed cookie, name + expiry ----

const b64 = (s) => Buffer.from(s).toString("base64url");
const mac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function makeToken(name) {
  const p = b64(JSON.stringify({ n: name, x: Date.now() + COOKIE_S * 1000 }));
  return p + "." + mac(p);
}
function readToken(tok) {
  if (!tok) return null;
  const [p, m] = tok.split(".");
  if (!p || !m || !same(m, mac(p))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, "base64url").toString());
    return o.x > Date.now() && invites.some((i) => i.name === o.n) ? o.n : null;
  } catch {
    return null;
  }
}
function who(req) {
  const c = req.headers.cookie ?? "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return readToken(v.join("="));
  }
  return null;
}
const ipOf = (req) => (TRUST_PROXY && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

// ---- failed logins: five misses block an address for ten minutes ----

const misses = new Map();
function blocked(ip) {
  const m = misses.get(ip);
  return !!m && m.until > Date.now();
}
function miss(ip) {
  const m = misses.get(ip) ?? { n: 0, until: 0 };
  m.n++;
  if (m.n >= 5) { m.until = Date.now() + 10 * 60 * 1000; m.n = 0; }
  misses.set(ip, m);
}

// ---- rooms ----

/** id -> {id, title, city, host, hostWs, guests, created, timer} */
const rooms = new Map();
function closeRoom(r, why) {
  clearTimeout(r.timer);
  rooms.delete(r.id);
  for (const ws of [r.hostWs, ...r.guests]) {
    try { ws?.close(4000, why); } catch { /* gone */ }
  }
}
const listing = () => [...rooms.values()].map((r) => ({
  id: r.id, title: r.title, city: r.city, host: r.host, players: 1 + r.guests.size, online: !!r.hostWs, created: r.created,
}));

// ---- http ----

function readBody(req, max = 4096) {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > max) { req.destroy(); ok(null); } });
    req.on("end", () => {
      try { ok(JSON.parse(s || "{}")); } catch { ok(null); }
    });
  });
}
const notFound = (res) => { res.writeHead(404, { "content-length": 0 }); res.end(); };
function json(res, code, o, extra = {}) {
  const b = JSON.stringify(o);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store", ...extra });
  res.end(b);
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("vary", "origin");
  }
}

const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f3ee;color:#222}
form{display:grid;gap:10px;width:min(320px,86vw)}input,button{font:inherit;padding:10px;border:1px solid #bbb;border-radius:6px}
button{background:#222;color:#fff;cursor:pointer}p{margin:0;min-height:1.2em;color:#a22}</style>
<form id=f><input id=c type=password placeholder="Invite code" autocomplete=current-password autofocus><button>Enter</button><p id=m></p></form>
<script>f.onsubmit=async e=>{e.preventDefault();m.textContent='';const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:c.value})});
if(r.ok)location.href='/';else m.textContent=r.status===429?'Try again later.':'Not valid.'}</script>`;

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? "/", "http://x"), path = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && path === LOGIN_PATH) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(LOGIN_PAGE);
  }
  if (req.method === "POST" && path === "/api/login") {
    const ip = ipOf(req);
    if (blocked(ip)) return json(res, 429, { error: "later" });
    const b = await readBody(req);
    const hit = b && typeof b.code === "string" ? invites.find((i) => same(i.code, b.code)) : null;
    if (!hit) { miss(ip); return json(res, 401, { error: "no" }); }
    const cookie = `${COOKIE}=${makeToken(hit.name)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_S}${SECURE ? "; Secure" : ""}`;
    return json(res, 200, { name: hit.name }, { "set-cookie": cookie });
  }
  if (path === "/api/logout" && req.method === "POST") {
    return json(res, 200, {}, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE ? "; Secure" : ""}` });
  }
  const me = who(req);
  // the proxy's auth_request: 204 for a friend, 401 for anyone else (the proxy turns that into its own 404)
  if (path === "/api/auth") { res.writeHead(me ? 204 : 401); return res.end(); }
  if (!me) return path === "/api/me" ? json(res, 401, { error: "login" }) : notFound(res);
  if (path === "/api/me" && req.method === "GET") return json(res, 200, { name: me });
  if (path === "/api/games" && req.method === "GET") return json(res, 200, { games: listing() });
  if (path === "/api/games" && req.method === "POST") {
    const b = await readBody(req);
    if (!b) return json(res, 400, { error: "bad" });
    for (const r of [...rooms.values()]) if (r.host === me) closeRoom(r, "host started another game");
    const id = crypto.randomBytes(6).toString("hex");
    const r = {
      id, title: String(b.title ?? "").slice(0, 60) || me + "'s game", city: String(b.city ?? "").slice(0, 60),
      host: me, hostWs: null, guests: new Set(), created: Date.now(), timer: null,
    };
    // nobody has connected yet: a room whose host never arrives goes away too
    r.timer = setTimeout(() => closeRoom(r, "host never connected"), GRACE_MS);
    rooms.set(id, r);
    return json(res, 200, { id });
  }
  const del = path.match(/^\/api\/games\/([0-9a-f]+)$/);
  if (del && req.method === "DELETE") {
    const r = rooms.get(del[1]);
    if (!r || r.host !== me) return notFound(res);
    closeRoom(r, "closed by host");
    return json(res, 200, {});
  }
  notFound(res);
});

// ---- websocket: /ws?room=ID&role=host|guest ----

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
server.on("upgrade", (req, socket, head) => {
  const deny = (code) => {
    socket.write(`HTTP/1.1 ${code}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") return deny("404 Not Found");
  // a page of some other site may not open this socket with a friend's cookie
  const o = req.headers.origin;
  if (o) {
    let h = "";
    try { h = new URL(o).host; } catch { /* bad */ }
    if (h !== req.headers.host && !ORIGINS.includes(o)) return deny("403 Forbidden");
  }
  const me = who(req);
  const r = rooms.get(url.searchParams.get("room") ?? "");
  const role = url.searchParams.get("role");
  if (!me || !r || (role !== "host" && role !== "guest") || (role === "host" && r.host !== me)) return deny("404 Not Found");
  wss.handleUpgrade(req, socket, head, (ws) => join(ws, r, role));
});

function join(ws, r, role) {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  if (role === "host") {
    try { r.hostWs?.close(4001, "host connected again"); } catch { /* gone */ }
    r.hostWs = ws;
    clearTimeout(r.timer);
  } else {
    r.guests.add(ws);
  }
  ws.on("message", (data, isBinary) => {
    for (const other of [r.hostWs, ...r.guests]) {
      if (other && other !== ws && other.readyState === 1) other.send(data, { binary: isBinary });
    }
  });
  ws.on("close", () => {
    if (role === "guest") { r.guests.delete(ws); return; }
    if (r.hostWs !== ws) return; // replaced by a newer connection of the same host
    r.hostWs = null;
    // a host's page reloads for a sync: keep the room a while
    r.timer = setTimeout(() => closeRoom(r, "host gone"), GRACE_MS);
  });
  ws.on("error", () => { /* the close handler runs next */ });
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, BIND, () => console.log(`trainsworld relay on http://${BIND}:${PORT} (login page ${LOGIN_PATH}, ${invites.length} invites)`));
