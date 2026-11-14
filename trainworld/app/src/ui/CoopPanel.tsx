// The co-op panel at the lower left (game/coop.ts): host the game in hand, or join a host in another tab; while in
// co-op, who this tab is, how it is doing, and leave.

import { useState } from "preact/hooks";
import { coopGuests, coopRole, coopStatus, hostGame, joinGame, leaveCoop, resync } from "../game/coop";
import { gamesLoaded } from "../workers/clockClient";
import { t } from "../i18n";

export function CoopPanel() {
  const [open, setOpen] = useState(false);
  const role = coopRole.value, status = coopStatus.value;
  if (!role) {
    return (
      <div class="coop-panel">
        {open && (
          <div class="coop-menu">
            <button class="btn" disabled={gamesLoaded.value === 0} onClick={() => { setOpen(false); hostGame(); }}>{t("coop.host")}</button>
            <button class="btn" onClick={() => { setOpen(false); joinGame(); }}>{t("coop.join")}</button>
            <p class="muted small">{t("coop.hint")}</p>
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
        {role === "host" && status !== "syncing" && coopGuests.value > 0 && <button class="btn" onClick={resync}>{t("coop.resync")}</button>}
        <button class="btn" onClick={leaveCoop}>{t("coop.leave")}</button>
      </div>
    </div>
  );
}
