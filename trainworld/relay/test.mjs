// Starts the relay on a spare port and checks login, hiding, rooms and relaying. Run: npm test
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const PORT = 18787, BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: { ...process.env, PORT: String(PORT), TW_INVITES: "alice:aaa,bob:bbb", TW_SECRET: "test", TW_LOGIN_PATH: "/secret-door", TW_GRACE_S: "1" },
  stdio: "inherit",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("ok   ", name); } catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
}
const api = (path, { cookie, method = "GET", body } = {}) =>
  fetch(BASE + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
async function login(code) {
  const r = await api("/api/login", { method: "POST", body: { code } });
  return { r, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
}
const open = (path, cookie, headers = {}) => new Promise((ok, no) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: { cookie, ...headers } });
  ws.on("open", () => ok(ws));
  ws.on("error", no);
  ws.on("unexpected-response", (_q, res) => no(new Error("http " + res.statusCode)));
});
const next = (ws) => new Promise((ok) => ws.once("message", (d, bin) => ok({ d, bin })));

for (let i = 0; i < 50; i++) { try { await api("/nothing"); break; } catch { await sleep(100); } }

try {
  let alice, bob;
  await check("everything is a bare 404 without a session", async () => {
    for (const p of ["/", "/api/games", "/index.html", "/ws", "/api/logout-nope"]) assert.equal((await api(p)).status, 404, p);
    assert.equal((await api("/api/auth")).status, 401);
  });
  await check("the login page is only at the secret path", async () => {
    assert.equal((await api("/login")).status, 404);
    assert.equal((await api("/secret-door")).status, 200);
  });
  await check("a wrong code is refused, a right one names the friend", async () => {
    assert.equal((await login("nope")).r.status, 401);
    alice = await login("aaa"); bob = await login("bbb");
    assert.equal(alice.r.status, 200);
    assert.equal((await (await api("/api/me", { cookie: alice.cookie })).json()).name, "alice");
    assert.equal((await api("/api/auth", { cookie: bob.cookie })).status, 204);
  });
  await check("a forged cookie is refused", async () => {
    assert.equal((await api("/api/auth", { cookie: alice.cookie.slice(0, -2) + "xx" })).status, 401);
  });
  let room;
  await check("a game is listed once created", async () => {
    const r = await api("/api/games", { cookie: alice.cookie, method: "POST", body: { title: "Test run", city: "Sendai" } });
    room = (await r.json()).id;
    const list = (await (await api("/api/games", { cookie: bob.cookie })).json()).games;
    assert.equal(list.length, 1); assert.equal(list[0].host, "alice"); assert.equal(list[0].players, 1);
  });
  await check("a guest cannot connect as host, an outsider cannot connect at all", async () => {
    await assert.rejects(open(`/ws?room=${room}&role=host`, bob.cookie));
    await assert.rejects(open(`/ws?room=${room}&role=guest`, ""));
    await assert.rejects(open(`/ws?room=${room}&role=guest`, bob.cookie, { origin: "http://evil.example" }));
  });
  await check("frames reach the others only, text and binary", async () => {
    const host = await open(`/ws?room=${room}&role=host`, alice.cookie);
    const g1 = await open(`/ws?room=${room}&role=guest`, bob.cookie);
    const g2 = await open(`/ws?room=${room}&role=guest`, bob.cookie);
    const a = next(g1), b = next(g2);
    host.send(JSON.stringify({ k: "hello" }));
    assert.equal((await a).d.toString(), '{"k":"hello"}');
    assert.equal((await b).bin, false);
    const bytes = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => i % 251));
    const got = next(host);
    g1.send(bytes);
    const r = await got;
    assert.equal(r.bin, true); assert.ok(Buffer.compare(Buffer.from(r.d), bytes) === 0);
    assert.equal((await (await api("/api/games", { cookie: bob.cookie })).json()).games[0].players, 3);
    host.close(); g1.close(); g2.close();
  });
  await check("a room goes when its host stays away", async () => {
    await sleep(1600);
    assert.equal((await (await api("/api/games", { cookie: bob.cookie })).json()).games.length, 0);
  });
  await check("five wrong codes block an address", async () => {
    for (let i = 0; i < 5; i++) await login("wrong" + i);
    assert.equal((await login("aaa")).r.status, 429);
  });
} finally {
  proc.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
