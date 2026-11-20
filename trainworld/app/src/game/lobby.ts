// The online lobby (relay/server.mjs): who is signed in, which games are open, host one or join one. The relay's
// address comes from game/relayTransport.ts; with none, there is no online co-op and the panel shows none.

import { signal } from "@preact/signals";
import { t } from "../i18n";
import { gameOpen, hostGame, joinGame } from "./coop";
import { relayBase, useRelayRoom } from "./relayTransport";
import { say } from "./world";

export type LobbyGame = { id: string; title: string; city: string; host: string; players: number; online: boolean; created: number };

/** A relay is set and answered (a plain local game has none). */
export const lobbyReady = signal(false);
/** The signed-in friend's name, null before the sign-in. */
export const lobbyUser = signal<string | null>(null);
export const lobbyGames = signal<LobbyGame[]>([]);

const call = (path: string, init?: RequestInit) => fetch((relayBase() ?? "") + path, { credentials: "include", ...init });
const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Asks the relay who we are: it says whether there is a relay at all and whether the sign-in is still good. */
export async function lobbyProbe() {
  if (relayBase() === null) { lobbyReady.value = false; return; }
  try {
    const r = await call("/api/me");
    lobbyReady.value = r.status === 200 || r.status === 401;
    lobbyUser.value = r.ok ? ((await r.json()) as { name: string }).name : null;
    if (r.ok) void lobbyRefresh();
  } catch {
    lobbyReady.value = false;
  }
}

/** Signs in with an invite code; false when it was not accepted. */
export async function lobbyLogin(code: string): Promise<boolean> {
  try {
    const r = await post("/api/login", { code });
    if (!r.ok) return false;
    lobbyUser.value = ((await r.json()) as { name: string }).name;
    void lobbyRefresh();
    return true;
  } catch {
    say(t("coop.relayFailed"), true);
    return false;
  }
}

export async function lobbyRefresh() {
  try {
    const r = await call("/api/games");
    if (r.status === 401) { lobbyUser.value = null; return; }
    if (r.ok) lobbyGames.value = ((await r.json()) as { games: LobbyGame[] }).games;
  } catch { /* the next poll tries again */ }
}

/** Opens the game in hand to the friends: a room on the relay, this tab its host. */
export async function hostOnline(title: string) {
  const base = relayBase();
  if (base === null) return;
  if (!gameOpen()) { say(t("coop.needGame"), true); return; }
  try {
    const r = await post("/api/games", { title: title.trim(), city: "" });
    if (!r.ok) { say(t("coop.relayFailed"), true); return; }
    const { id } = (await r.json()) as { id: string };
    useRelayRoom(base, id, "host");
    hostGame();
  } catch {
    say(t("coop.relayFailed"), true);
  }
}

/** Joins an open game: this tab loads the host's game and follows it. */
export function joinOnline(id: string) {
  const base = relayBase();
  if (base === null) return;
  useRelayRoom(base, id, "guest");
  joinGame();
}
