// How the co-op tabs talk (game/coop.ts). A transport carries one message to every other member of the game and
// hands over what the others send; it knows nothing about what the messages mean. The two-tab co-op uses a
// BroadcastChannel; the online co-op uses a relay over a WebSocket (game/relayTransport.ts). Messages may carry a
// `bytes: Uint8Array` (a sync), so a network transport frames those itself.

export interface CoopTransport {
  /** Send to every other member. */
  send(m: unknown): void;
  /** Called with each message another member sent. */
  onMessage(handler: (m: unknown) => void): void;
  /** Called when a lost connection is back: messages in between were lost, so say who you are again. */
  onReconnect?(handler: () => void): void;
  close(): void;
}

/** Tabs of one browser, no server (what the first co-op used, and what a plain `?coop=join` still uses). */
export function broadcastTransport(name: string): CoopTransport {
  const ch = new BroadcastChannel(name);
  return {
    send: (m) => ch.postMessage(m),
    onMessage: (handler) => { ch.onmessage = (e: MessageEvent) => handler(e.data); },
    close: () => ch.close(),
  };
}

let make: (name: string) => CoopTransport = broadcastTransport;
let leave: (() => void) | null = null;

/** Replace how co-op connects (the lobby does this before `hostGame` / `joinGame`); `onLeave` runs when co-op ends. */
export function setCoopTransport(factory: (name: string) => CoopTransport, onLeave?: () => void) {
  make = factory;
  leave = onLeave ?? null;
}

export const openTransport = (name: string): CoopTransport => make(name);

/** Co-op ended: whatever was set for it is let go, the next co-op starts from the tab channel again. */
export function resetTransport() {
  const f = leave;
  leave = null;
  make = broadcastTransport;
  f?.();
}
