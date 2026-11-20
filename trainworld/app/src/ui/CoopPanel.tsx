// The co-op panel at the lower left (game/coop.ts): host the game in hand, or join a host in another tab; with a relay
// (game/lobby.ts) also sign in, host the game online and join the friends' open games. While in co-op, who this tab
// is, how it is doing, and leave.

import { useEffect, useState } from "preact/hooks";
import { coopGuests, coopRole, coopStatus, hostGame, joinGame, leaveCoop, resync } from "../game/coop";
import { hostOnline, joinOnline, lobbyGames, lobbyLogin, lobbyProbe, lobbyReady, lobbyRefresh, lobbyUser } from "../game/lobby";
import { relayLink } from "../game/relayTransport";
import { gameStamp } from "../workers/clockClient";
import { t } from "../i18n";

/** The online part of the menu: sign in, host the game in hand, the open games. */
function Online({ close }: { close: () => void }) {
  const [code, setCode] = useState(""), [bad, setBad] = useState(false), [title, setTitle] = useState("");
  const user = lobbyUser.value;
  useEffect(() => {
    void lobbyRefresh();
    const timer = window.setInterval(() => void lobbyRefresh(), 4000);
    return () => clearInterval(timer);
  }, []);
  if (!user) {
    return (
      <form class="coop-online" onSubmit={async (e) => { e.preventDefault(); setBad(!(await lobbyLogin(code))); setCode(""); }}>
        <strong>{t("coop.online")}</strong>
        <input type="password" value={code} placeholder={t("coop.code")} autocomplete="current-password" onInput={(e) => setCode((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit" disabled={!code}>{t("coop.login")}</button>
        {bad && <span class="muted small">{t("coop.loginFailed")}</span>}
      </form>
    );
  }
  const games = lobbyGames.value;
  return (
    <div class="coop-online">
      <strong>{t("coop.online")}</strong>
      <span class="muted small">{t("coop.signedIn", { name: user })}</span>
      <div class="coop-host-row">
        <input type="text" value={title} maxLength={60} placeholder={t("coop.gameTitle")} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        <button class="btn" disabled={gameStamp.value === 0} onClick={() => { close(); void hostOnline(title || user); }}>{t("coop.hostOnline")}</button>
      </div>
      {games.length === 0 && <span class="muted small">{t("coop.noGames")}</span>}
      {games.map((g) => (
        <div class="coop-game" key={g.id}>
          <span><strong>{g.title}</strong> <span class="muted small">{g.host} · {t("coop.gamePlayers", { count: g.players })}{g.online ? "" : " · " + t("coop.gameOffline")}</span></span>
          <button class="btn" disabled={!g.online} onClick={() => { close(); joinOnline(g.id); }}>{t("coop.joinOnline")}</button>
        </div>
      ))}
    </div>
  );
}

export function CoopPanel() {
  const [open, setOpen] = useState(false);
  const role = coopRole.value, status = coopStatus.value;
  useEffect(() => { void lobbyProbe(); }, []);
  if (!role) {
    return (
      <div class="coop-panel">
        {open && (
          <div class="coop-menu">
            <button class="btn" disabled={gameStamp.value === 0} onClick={() => { setOpen(false); hostGame(); }}>{t("coop.host")}</button>
            <button class="btn" onClick={() => { setOpen(false); joinGame(); }}>{t("coop.join")}</button>
            <p class="muted small">{t("coop.hint")}</p>
            {lobbyReady.value && <Online close={() => setOpen(false)} />}
          </div>
        )}
        <button class={"btn coop-toggle" + (open ? " on" : "")} aria-expanded={open} onClick={() => setOpen(!open)}>{t("coop.button")}</button>
      </div>
    );
  }
  const text = role === "host"
    ? (status === "syncing" ? t("coop.syncing") : t("coop.hosting", { count: coopGuests.value }))
    : t(status === "connected" ? "coop.connected" : status === "hostReloading" ? "coop.hostReloading" : status === "loading" ? "coop.loading" : "coop.waitingHost");
  return (
    <div class="coop-panel">
      <div class="coop-menu">
        <strong>{t(role === "host" ? "coop.hostTitle" : "coop.guestTitle")}</strong>
        <span class="muted small">{text}</span>
        {relayLink.value === "lost" && <span class="muted small">{t("coop.connectionLost")}</span>}
        {role === "host" && status !== "syncing" && coopGuests.value > 0 && <button class="btn" onClick={resync}>{t("coop.resync")}</button>}
        <button class="btn" onClick={leaveCoop}>{t("coop.leave")}</button>
      </div>
    </div>
  );
}
