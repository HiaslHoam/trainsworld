// The online co-op's connection (relay/server.mjs): a WebSocket to a room of the relay. A reload of the page (co-op
// reloads both host and guests to load a synced game) loses the socket, so the room is kept in sessionStorage and
// `restoreRelay` reconnects at page start, before co-op carries on.
//
// A frame is JSON text, except a message with `bytes` (a sync): a binary frame, a 4-byte big-endian length of the
// JSON head (the message without `bytes`), the head, then the bytes.

import { signal } from "@preact/signals";
import { setCoopTransport, type CoopTransport } from "./coopTransport";

export type RelayRole = "host" | "guest";
type Saved = { base: string; room: string; role: RelayRole };

const KEY = "trainsworld-relay", BASE_KEY = "trainsworld-relay-base";

/** The connection's state, for the co-op panel. */
export const relayLink = signal<"off" | "connecting" | "online" | "lost">("off");
/** The relay closed the room (the host left or went away): the panel says so and co-op ends. */
export const relayClosed = signal<string | null>(null);

/** Where the relay is: "" the page's own site, a URL for a relay elsewhere (`?relay=` while developing, kept for the
 * tab), null when there is none (a plain local game shows no online co-op). A published page names it in
 * `<meta name="tw-relay" content="">`. */
export function relayBase(): string | null {
  try {
    const q = new URLSearchParams(location.search).get("relay");
    if (q) sessionStorage.setItem(BASE_KEY, q.replace(/\/+$/, ""));
    const s = sessionStorage.getItem(BASE_KEY);
    if (s !== null) return s;
  } catch { /* storage unavailable */ }
  const m = document.querySelector<HTMLMetaElement>('meta[name="tw-relay"]');
  return m ? m.content.replace(/\/+$/, "") : null;
}

function wsUrl(base: string, room: string, role: RelayRole) {
  const root = base || location.origin;
  return root.replace(/^http/, "ws") + `/ws?room=${encodeURIComponent(room)}&role=${role}`;
}

function encode(m: unknown): string | ArrayBuffer {
  const bytes = (m as { bytes?: unknown } | null)?.bytes;
  if (bytes instanceof Uint8Array) {
    const { bytes: _drop, ...head } = m as Record<string, unknown>;
    const h = new TextEncoder().encode(JSON.stringify(head));
    const out = new Uint8Array(4 + h.length + bytes.length);
    new DataView(out.buffer).setUint32(0, h.length);
    out.set(h, 4);
    out.set(bytes, 4 + h.length);
    return out.buffer;
  }
  return JSON.stringify(m);
}

function decode(d: string | ArrayBuffer): unknown {
  if (typeof d === "string") return JSON.parse(d);
  const n = new DataView(d).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(d, 4, n)));
  head.bytes = new Uint8Array(d, 4 + n);
  return head;
}

/** A socket to the room that comes back after a drop (not after the relay closed the room: code 4000). */
export function wsTransport(url: string): CoopTransport {
  let ws: WebSocket | null = null, handler: ((m: unknown) => void) | null = null, again: (() => void) | null = null;
  let ended = false, tries = 0, timer = 0, wasUp = false;
  const queue: (string | ArrayBuffer)[] = [];
  const connect = () => {
    relayLink.value = wasUp ? "lost" : "connecting";
    const s = (ws = new WebSocket(url));
    s.binaryType = "arraybuffer";
    s.onopen = () => {
      tries = 0;
      relayLink.value = "online";
      for (const f of queue.splice(0)) s.send(f);
      if (wasUp) again?.();
      wasUp = true;
    };
    s.onmessage = (e) => {
      try { handler?.(decode(e.data)); } catch (err) { console.error("co-op: a frame did not decode", err); } // i18n-ignore
    };
    s.onclose = (e) => {
      if (ended || ws !== s) return;
      if (e.code === 4000) { ended = true; relayLink.value = "off"; relayClosed.value = e.reason || "closed"; return; }
      relayLink.value = "lost";
      timer = window.setTimeout(connect, Math.min(10000, 500 * 2 ** tries++));
    };
  };
  connect();
  return {
    send(m) {
      const f = encode(m);
      if (ws && ws.readyState === 1) ws.send(f);
      else if (queue.length < 200) queue.push(f);
    },
    onMessage(h) { handler = h; },
    onReconnect(h) { again = h; },
    close() {
      ended = true;
      clearTimeout(timer);
      relayLink.value = "off";
      try { ws?.close(); } catch { /* gone */ }
    },
  };
}

function save(s: Saved | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage unavailable: a reload loses the room */ }
}

/** Co-op through room `room` of the relay at `base`, as `role`: set before `hostGame` / `joinGame`. */
export function useRelayRoom(base: string, room: string, role: RelayRole) {
  save({ base, room, role });
  relayClosed.value = null;
  setCoopTransport(() => wsTransport(wsUrl(base, room, role)), () => {
    save(null);
    relayLink.value = "off";
    // a host leaving closes the room, so the guests are told at once and the lobby drops it
    if (role === "host") void fetch(`${base}/api/games/${room}`, { method: "DELETE", credentials: "include", keepalive: true }).catch(() => {});
  });
}

/** At page start: a page that reloaded inside an online co-op goes back to its room. */
export function restoreRelay() {
  try {
    const s = sessionStorage.getItem(KEY);
    if (!s) return;
    const r = JSON.parse(s) as Saved;
    if (r.base !== null && r.room && (r.role === "host" || r.role === "guest")) useRelayRoom(r.base, r.room, r.role);
  } catch { /* unreadable: start without */ }
}
