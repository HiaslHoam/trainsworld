// Co-op between two tabs of one browser (a first step towards multiplayer): one tab hosts its game, the others join
// it as guests. The tabs talk over a BroadcastChannel, so no server is needed yet.
//
// - The host's worker is the one that decides. A guest's edits are sent to the host (`ask`), the host applies them
//   like its own, and every edit the host's worker accepts goes to all guests in order (`op`, numbered by `seq`).
//   Each guest applies them to its own worker, so every tab runs the same network.
// - A save renumbers ids densely (sim/src/track/save.rs), so the tabs must start from the same bytes: on a join the
//   host exports its game (`sync`), reloads it from those bytes itself, then tells the guests to load them (`go`).
//   One epoch per sync; the host keeps the epoch's edits (`log`) so a guest that loads late catches up (`ready`).
// - An edit that changes departures takes effect at the game time its worker applies it (docs/track-and-service.md,
//   trains on a running line), so each edit goes out with the host's time and lead and a guest applies it at those,
//   or its trains would change over at another moment than the host's.
// - The host's clock is the game's clock (`clock`, every second and on each change); a guest's speed buttons ask
//   the host (`speed`).
// - Every game load reloads the page, so each tab keeps its role and epoch in sessionStorage.
//
// Not shared yet: anything sent to the worker outside `edit` (line shapes, list order, home, the guide), and
// figures each tab works out for itself (demand, so fares and money can drift a little between tabs).

import { signal } from "@preact/signals";
import { t } from "../i18n";
import { coopLoad, exportForShare, gamesLoaded, setCoopGameHooks, type EditAnswer } from "../workers/clockClient";
import type { EditOp } from "../workers/protocol";
import { clock, SPEEDS } from "./clock";
import { openTransport, resetTransport, type CoopTransport } from "./coopTransport";
import { relayClosed, restoreRelay } from "./relayTransport";
import { applyRemoteEdit, edit, say, setCoopHooks } from "./world";

type Role = "host" | "guest";
type Stored = { role: Role; id: string; epoch: number; /** host: reloaded for a sync, the guests not yet told */ awaitGo?: boolean;
  /** guest: the page is reloading into the host's game (a reload without it holds some other game) */ loading?: boolean };

/** An edit as the host's worker applied it: the op, and the game time and lead it took effect at. */
type Logged = { op: EditOp; at?: number; lead?: number };

type Msg =
  | { k: "hello"; from: string }
  | { k: "host"; from: string; e: number; build?: string }
  | { k: "sync"; from: string; e: number; bytes: Uint8Array; build?: string }
  | { k: "go"; from: string; e: number }
  | { k: "ready"; from: string; e: number; next: number }
  | { k: "ops"; from: string; to: string; e: number; first: number; ops: Logged[] }
  | { k: "op"; from: string; e: number; seq: number; edit: Logged }
  | { k: "ask"; from: string; e: number; req: number; op: EditOp }
  | { k: "answer"; from: string; to: string; req: number; a: EditAnswer; seq: number }
  | { k: "clock"; from: string; e: number; t: number; at: number; running: boolean; ticking: boolean; x: number }
  | { k: "speed"; from: string; running: boolean; x: number }
  | { k: "bye"; from: string };

declare const __TW_BUILD__: string | undefined;
/** This page's build: a guest of another build than its host's would run a game that drifts from the host's. */
const BUILD = typeof __TW_BUILD__ === "string" ? __TW_BUILD__ : "dev";
const CHANNEL = "trainsworld-coop";
const KEY = "trainsworld-coop";
const REFUSED: EditAnswer = { ok: false, issues: [], charge: 0 };

/** This tab's part, for the panel (ui/CoopPanel.tsx). */
export const coopRole = signal<Role | null>(null);
/** What the tab is doing, a message key's last part. */
export const coopStatus = signal<"idle" | "syncing" | "waitingHost" | "hostReloading" | "loading" | "connected">("idle");
/** The host's guests that have loaded the game. */
export const coopGuests = signal(0);

let me: Stored | null = null;
let channel: CoopTransport | null = null;

function read(): Stored | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Stored) : null;
  } catch {
    return null;
  }
}
function write() {
  try {
    if (me) sessionStorage.setItem(KEY, JSON.stringify(me));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage unavailable: the role lasts until the next reload */ }
}
function post(m: Msg) {
  channel?.send(m);
}
const loaded = () => gamesLoaded.peek() > 0;

// ---- the host ----

/** The edits of this epoch, in the order the host's worker accepted them. */
const log: Logged[] = [];
/** each logged edit's number, by the op object the host's worker was sent */
const seqOf = new WeakMap<EditOp, number>();
const guests = new Set<string>();
let syncing = false;

function hostApplied(op: EditOp, a: EditAnswer) {
  if (!me || me.role !== "host" || me.awaitGo || me.epoch === 0) return;
  const edit: Logged = { op, at: a.at, lead: a.lead };
  log.push(edit);
  seqOf.set(op, log.length - 1);
  post({ k: "op", from: me.id, e: me.epoch, seq: log.length - 1, edit });
}

/** Send the game to the guests: the host reloads from the exported bytes, and the guests load them once it has. */
async function sync() {
  if (!me || syncing || !loaded()) return;
  syncing = true;
  coopStatus.value = "syncing";
  const bytes = await exportForShare();
  if (!bytes) { syncing = false; coopStatus.value = "idle"; return; }
  me = { ...me, epoch: me.epoch + 1, awaitGo: true };
  write();
  post({ k: "sync", from: me.id, e: me.epoch, bytes, build: BUILD });
  if (!await coopLoad(bytes, t("coop.slotName"), false)) {
    say(t("coop.loadFailed"), true);
    syncing = false;
  }
}

function sendClock() {
  if (!me || me.role !== "host" || me.epoch === 0 || !clock) return;
  post({ k: "clock", from: me.id, e: me.epoch, t: clock.now(), at: Date.now(), running: clock.running.peek(), ticking: clock.ticking, x: clock.chosenRate.peek() / SPEEDS[0] });
}

async function onHost(m: Msg) {
  const host = me!;
  switch (m.k) {
    case "hello":
      guests.delete(m.from);
      coopGuests.value = guests.size;
      if (!host.awaitGo) void sync();
      break;
    case "ready":
      if (m.e !== host.epoch || host.awaitGo) break;
      guests.add(m.from);
      coopGuests.value = guests.size;
      post({ k: "ops", from: host.id, to: m.from, e: host.epoch, first: m.next, ops: log.slice(m.next) });
      sendClock();
      break;
    case "ask": {
      if (m.e !== host.epoch || host.awaitGo) { post({ k: "answer", from: host.id, to: m.from, req: m.req, a: REFUSED, seq: -1 }); break; }
      const a = await edit(m.op, true, true);
      post({ k: "answer", from: host.id, to: m.from, req: m.req, a, seq: a.ok ? seqOf.get(m.op) ?? -1 : -1 });
      break;
    }
    case "speed":
      if (m.running !== clock.running.peek()) clock.setRunning(m.running);
      if (m.running && m.x * SPEEDS[0] !== clock.chosenRate.peek()) clock.setMultiple(m.x);
      break;
    case "bye":
      guests.delete(m.from);
      coopGuests.value = guests.size;
      break;
  }
}

// ---- a guest ----

/** The next edit this tab applies, and the ones that came early. */
let nextSeq = 0;
const early = new Map<number, Logged>();
let pumping = false;
const seqWaiters: { seq: number; done: () => void }[] = [];
/** The bytes of a sync, kept until the host says go. */
let incoming: { e: number; bytes: Uint8Array } | null = null;
let reqs = 0;
const asked = new Map<number, (a: EditAnswer, seq: number) => void>();
/** The host's clock last applied, so this tab's own changes can be told apart from it. */
let hostSpeed: { running: boolean; x: number } | null = null;
let applyingClock = false;

const inGame = () => !!me && me.role === "guest" && me.epoch > 0 && loaded();

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (early.has(nextSeq)) {
      const e = early.get(nextSeq)!;
      early.delete(nextSeq);
      await applyRemoteEdit(e.op, e.at !== undefined ? { at: e.at, lead: e.lead ?? 0 } : undefined);
      nextSeq++;
      for (let i = seqWaiters.length - 1; i >= 0; i--) if (seqWaiters[i].seq < nextSeq) seqWaiters.splice(i, 1)[0].done();
    }
  } finally {
    pumping = false;
  }
}

/** A guest's edit: asked of the host, answered once this tab has applied it too. */
function guestRoute(op: EditOp): Promise<EditAnswer> {
  if (!inGame()) return Promise.resolve(REFUSED);
  const req = ++reqs;
  post({ k: "ask", from: me!.id, e: me!.epoch, req, op });
  return new Promise((done) => {
    asked.set(req, (a, seq) => {
      if (!a.ok || seq < nextSeq) return done(a);
      seqWaiters.push({ seq, done: () => done(a) });
    });
  });
}

function hello() {
  if (!me) return;
  if (inGame()) post({ k: "ready", from: me.id, e: me.epoch, next: nextSeq });
  else { post({ k: "hello", from: me.id }); coopStatus.value = "waitingHost"; }
}

async function onGuest(m: Msg) {
  const guest = me!;
  // a host of another build (or one too old to say): the page must be reloaded to the same build before joining
  if ((m.k === "host" || m.k === "sync") && m.build !== BUILD) {
    say(t("coop.buildMismatch"), true);
    leaveCoop();
    return;
  }
  switch (m.k) {
    case "host":
      if (inGame() && m.e === guest.epoch) post({ k: "ready", from: guest.id, e: guest.epoch, next: nextSeq });
      else if (!incoming) post({ k: "hello", from: guest.id });
      break;
    case "sync":
      incoming = { e: m.e, bytes: m.bytes };
      coopStatus.value = "hostReloading";
      break;
    case "go":
      if (incoming?.e !== m.e) { post({ k: "hello", from: guest.id }); break; }
      me = { ...guest, epoch: m.e, loading: true };
      write();
      coopStatus.value = "loading";
      if (!await coopLoad(incoming.bytes, t("coop.guestName"), true)) say(t("coop.loadFailed"), true);
      break;
    case "ops":
      if (m.to !== guest.id || m.e !== guest.epoch || !inGame()) break;
      m.ops.forEach((edit, i) => { if (m.first + i >= nextSeq) early.set(m.first + i, edit); });
      coopStatus.value = "connected";
      void pump();
      break;
    case "op":
      if (m.e !== guest.epoch || !inGame()) break;
      if (m.seq >= nextSeq) early.set(m.seq, m.edit);
      void pump();
      break;
    case "answer":
      if (m.to !== guest.id) break;
      asked.get(m.req)?.(m.a, m.seq);
      asked.delete(m.req);
      break;
    case "clock": {
      if (m.e !== guest.epoch || !inGame() || !clock) break;
      applyingClock = true;
      try {
        hostSpeed = { running: m.running, x: m.x };
        if (m.running !== clock.running.peek()) clock.setRunning(m.running);
        if (m.running && m.x * SPEEDS[0] !== clock.chosenRate.peek()) clock.setMultiple(m.x);
        // where the host's clock is now, from when it was sent
        const now = m.t + (m.ticking ? ((Date.now() - m.at) / 1000) * m.x * SPEEDS[0] : 0);
        // trains are drawn from the clock, so any gap in time is a gap on the map: follow within a game second or 50 ms
        if (Math.abs(clock.now() - now) > Math.max(1, m.x * SPEEDS[0] * 0.05)) clock.set(now);
        // the shown minute moves with drawn frames, which a tab out of sight has none of
        clock.tick();
      } finally {
        applyingClock = false;
      }
      break;
    }
  }
}

// ---- both ----

function listen() {
  if (channel) return;
  channel = openTransport(CHANNEL);
  channel.onMessage((data) => {
    const m = data as Msg;
    if (!me || m.from === me.id) return;
    void (me.role === "host" ? onHost(m) : onGuest(m));
  });
  // a lost connection came back: what was sent in between is gone, so say who we are again
  channel.onReconnect?.(() => {
    if (me?.role === "guest") hello();
    else if (me?.role === "host") post({ k: "host", from: me.id, e: me.epoch, build: BUILD });
  });
}

function begin(stored: Stored) {
  me = stored;
  write();
  coopRole.value = stored.role;
  listen();
  if (stored.role === "host") {
    setCoopHooks(null, hostApplied);
    coopStatus.value = stored.awaitGo ? "syncing" : "idle";
    post({ k: "host", from: stored.id, e: stored.epoch, build: BUILD });
  } else {
    setCoopHooks(guestRoute, null);
    coopStatus.value = stored.epoch > 0 ? "loading" : "waitingHost";
    if (stored.epoch === 0) hello();
  }
}

/** Host the game in hand. */
export function hostGame() {
  if (!loaded()) { say(t("coop.needGame"), true); return; }
  begin({ role: "host", id: crypto.randomUUID(), epoch: 0 });
}

/** Join the host in another tab. */
export function joinGame() {
  begin({ role: "guest", id: crypto.randomUUID(), epoch: 0 });
}

/** Host only: send the game to the guests again (after they drifted apart). */
export function resync() {
  if (me?.role === "host") void sync();
}

export function leaveCoop() {
  if (me) post({ k: "bye", from: me.id });
  channel?.close();
  channel = null;
  resetTransport();
  me = null;
  write();
  setCoopHooks(null, null);
  coopRole.value = null;
  coopStatus.value = "idle";
  coopGuests.value = 0;
  guests.clear();
}

/** A host page reloaded by hand: its edits since the last sync are gone and its ids renumbered, so it syncs again. */
let resyncWhenLoaded = false;

/** At page start: carry on as host or guest after a reload; `?coop=join` joins at once. */
export function startCoop() {
  // the game's mode and running side: a guest may not change them; the host's change goes to the guests with a sync
  setCoopGameHooks({ guest: () => me?.role === "guest", changed: () => { if (me?.role === "host" && me.epoch > 0) void sync(); } });
  restoreRelay();
  // the relay closed the room (its host left): this tab is out of the game
  relayClosed.subscribe((why) => {
    if (!why || !me) return;
    say(t("coop.relayClosed"), true);
    leaveCoop();
  });
  let stored = read();
  // only the reloads co-op makes itself carry on where they were; any other reload starts the sync again
  if (stored?.role === "guest") stored = stored.loading ? { ...stored, loading: false } : { ...stored, epoch: 0 };
  if (stored?.role === "host" && stored.epoch > 0 && !stored.awaitGo) resyncWhenLoaded = true;
  if (stored) begin(stored);
  else if (new URLSearchParams(location.search).get("coop") === "join") joinGame();
  // the game loaded: a host that reloaded for a sync tells its guests to load it too; a guest asks for the edits since
  gamesLoaded.subscribe((n) => {
    if (!n || !me) return;
    if (me.role === "host" && resyncWhenLoaded) {
      resyncWhenLoaded = false;
      void sync();
    } else if (me.role === "host" && me.awaitGo) {
      me = { ...me, awaitGo: false };
      write();
      log.length = 0;
      syncing = false;
      coopStatus.value = "idle";
      post({ k: "go", from: me.id, e: me.epoch });
    } else if (me.role === "guest" && me.epoch > 0) {
      nextSeq = 0;
      early.clear();
      post({ k: "ready", from: me.id, e: me.epoch, next: 0 });
    }
  });
  setInterval(sendClock, 1000);
  window.addEventListener("pagehide", () => { if (me?.role === "guest") post({ k: "bye", from: me.id }); });
}

/** Called once the clock exists: the host passes its speed changes on at once, a guest asks the host for its own. */
export function watchCoopClock() {
  clock.onChange(() => {
    if (!me) return;
    if (me.role === "host") return sendClock();
    if (applyingClock || !hostSpeed || !inGame()) return;
    const running = clock.running.peek(), x = clock.chosenRate.peek() / SPEEDS[0];
    if (running !== hostSpeed.running || (running && x !== hostSpeed.x)) post({ k: "speed", from: me.id, running, x });
  });
}
