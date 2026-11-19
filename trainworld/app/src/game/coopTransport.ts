// How the co-op tabs talk (game/coop.ts). A transport carries one message to every other member of the game and
// hands over what the others send; it knows nothing about what the messages mean. The two-tab co-op uses a
// BroadcastChannel; a relay over a WebSocket fits behind the same two calls (messages may carry a `Uint8Array`,
// so a network transport frames those itself).

export interface CoopTransport {
  /** Send to every other member. */
  send(m: unknown): void;
  /** Called with each message another member sent. */
  onMessage(handler: (m: unknown) => void): void;
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

/** Replace how co-op connects (a lobby that has found a relay does this before `hostGame` / `joinGame`). */
export function setCoopTransport(factory: (name: string) => CoopTransport) {
  make = factory;
}

export const openTransport = (name: string): CoopTransport => make(name);
