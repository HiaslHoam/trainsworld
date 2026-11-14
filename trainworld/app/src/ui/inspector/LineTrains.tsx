// The line's running trains on the line panel's stop strip: each train a small marker on the bar between the
// stops it is running between, on the left of the bar going down the list and on the right going up. A click
// selects the train and the camera follows it (map/cameraFollow.ts). Shown on the plain strip and the
// related-lines view (along the line's own bar, `--spine`), not for a line turned around a loop or while stops
// are edited.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { clock } from "../../game/clock";
import type { LineInput, LineStats } from "../../game/types";
import { selection } from "../../game/ui";
import { stationNames, world } from "../../game/world";
import { vehicleOf, nameBeforeNoun } from "../../game/vehicle";
import { t } from "../../i18n";
import { startFollow } from "../../map/cameraFollow";
import { toLngLat } from "../../map/geo";
import { live } from "../../map/live";
import { tripAt } from "../../map/network";
import { TRAINS_ZOOM } from "../../map/stationGeometry";

/** how often the markers move, ms */
const TICK_MS = 150;
/** the middle of the plain strip's bar, px (`.stops li::before` in style.css) */
const BAR_X = 10;

type Marker = { profile: number; dep: number; y: number; down: boolean; to: string };

/** The running trips of line `num`: profile, departure (absolute) and where along their run they are. */
function runningTrips(num: number) {
  const r = live.overlay?.renderer, n = r?.net;
  if (!r || !n) return [];
  const now = clock.now(), out: { profile: number; dep: number; s: number; run: number }[] = [];
  for (let i = 0; i < r.tripCount; i++) {
    const profile = r.trips[i * 2];
    if (Math.floor(profile / 6) !== num) continue;
    const dep = r.trips[i * 2 + 1] + r.tripsEpoch;
    const at = tripAt(n, profile, dep + r.tripLag(i), now, r.tripEnds ? r.tripEnds[i] + r.tripsEpoch : -Infinity);
    if (at) out.push({ profile, dep, s: at.s, run: Math.floor(profile / 3) % 2 });
  }
  return out;
}

/** The stretch of a run (between its stops `k` and `k + 1`, in run order) that `s` is on, and how far along it. */
function between(stopS: number[], s: number): { k: number; f: number } | null {
  if (stopS.length < 2) return null;
  let k = 0;
  while (k + 2 < stopS.length && stopS[k + 1] <= s) k++;
  const a = stopS[k], b = stopS[k + 1];
  return { k, f: b > a ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0 };
}

/** Selects the train, brings the camera to it close enough for trains to be drawn, then follows it. */
function followFromPanel(line: number, profile: number, dep: number) {
  selection.value = { kind: "train", line: String(line), profile, dep };
  const map = live.map, r = live.overlay?.renderer, n = r?.net;
  if (!map || !r || !n) return;
  const i = r.tripIndex(profile, dep - r.tripsEpoch);
  const at = tripAt(n, profile, dep + r.tripLag(i), clock.now(), i >= 0 && r.tripEnds ? r.tripEnds[i] + r.tripsEpoch : -Infinity);
  if (!at) return;
  const zoom = Math.max(map.getZoom(), TRAINS_ZOOM + 3);
  map.easeTo({ center: toLngLat(at.x, at.y), zoom, duration: 600 });
  // the renderer decides at its next draw whether trains are shown at the new zoom
  map.once("moveend", () => requestAnimationFrame(() => startFollow()));
}

export function LineTrains({ l, st, children }: { l: LineInput; st: LineStats; children: ComponentChildren }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [barX, setBarX] = useState(BAR_X);

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      timer = window.setTimeout(tick, TICK_MS);
      const el = wrap.current, w = world.peek();
      if (!el || !w) return;
      // each stop row's middle, relative to the strip
      const box = el.getBoundingClientRect(), top = box.top, rows = new Map<number, number>();
      // the related-lines view draws the line's own bar at `--spine` from its list's left
      const rel = el.querySelector<HTMLElement>("ul.related-rows");
      const spine = rel ? parseFloat(getComputedStyle(rel).getPropertyValue("--spine")) : NaN;
      setBarX(rel && Number.isFinite(spine) ? rel.getBoundingClientRect().left - box.left + spine : BAR_X);
      for (const li of el.querySelectorAll<HTMLElement>("li[data-stop]")) {
        const i = Number(li.dataset.stop), b = li.getBoundingClientRect();
        if (!rows.has(i)) rows.set(i, b.top - top + b.height / 2);
      }
      const nStops = l.stops.length, names = stationNames(w), out: Marker[] = [];
      const yOf = (i: number) => rows.get(i) ?? (st.loop && i === nStops - 1 ? box.height : undefined);
      for (const trip of runningTrips(l.num)) {
        const at = between(st.stopS[trip.run] ?? [], trip.s);
        if (!at) continue;
        // run 0 goes through the stops in order, run 1 the other way
        const a = trip.run === 0 ? at.k : nStops - 1 - at.k, b = trip.run === 0 ? a + 1 : a - 1;
        const ya = yOf(a), yb = yOf(b);
        if (ya === undefined || yb === undefined) continue;
        const terminus = trip.run === 0 ? l.stops[nStops - 1] : l.stops[0];
        out.push({ profile: trip.profile, dep: trip.dep, y: ya + (yb - ya) * at.f, down: yb >= ya, to: names.get(terminus) ?? "" });
      }
      setMarkers(out);
    };
    tick();
    return () => clearTimeout(timer);
  }, [l, st]);

  const vehicle = vehicleOf(st), name = nameBeforeNoun(l.name, vehicle);
  return (
    <div class="line-trains" ref={wrap}>
      {children}
      {markers.map((m) => {
        const tip = t("trainInspector.title", { name, vehicle }) + "\n" + t("trainInspector.towards", { name: m.to });
        return (
          <button key={m.profile + ":" + m.dep} class={"line-train" + (m.down ? " down" : " up")} style={{ top: m.y + "px", left: barX + (m.down ? -11 : 1) + "px" }}
            data-tip={tip} aria-label={tip} onClick={() => followFromPanel(l.num, m.profile, m.dep)} />
        );
      })}
    </div>
  );
}
