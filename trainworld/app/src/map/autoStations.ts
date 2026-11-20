// Add real stations along the blueprint track: the station bar's "Add real stations" button. For each real
// station (map/realStations.ts) within MAX_OFF_M of a blueprint track, a station goes on the track at the
// nearest spot, named as a click there would name it (the real name). Each goes in as an ordinary `addStation`
// edit, so the track model has the last word on room for the platform; a refused spot is tried a little further
// along the track the way the station tool's click does (`firstAccepted`, `roomNear`). A blueprint costs nothing
// until it is built, so what this adds can be looked over and deleted first.
//
// One station at a time: placing one splits the track it is on, so the next is looked up again in the track as
// the page then has it (the drawn network follows an edit a moment later: `settled`).

import { signal } from "@preact/signals";
import { lngLatToPack } from "../game/coords";
import { buildPlatform } from "../game/ui";
import { edit, say, world } from "../game/world";
import { t } from "../i18n";
import { toLngLat, toLocal } from "./geo";
import { live } from "./live";
import { realStationsIn, type RealStation } from "./realStations";
import { newStationName, trackDirection } from "./stationNames";
import { firstAccepted, fractionAlong, layoutOf, nearestOn, pointAlong, roomNear } from "./stationSnap";

/** a real station further from the track than this is not on it, m (platform points lie beside the track) */
export const MAX_OFF_M = 50;
/** a station this close to another (placed, or a real one already taken) is the same one, m */
export const MIN_GAP_M = 120;

/** the button is working */
export const autoStationsBusy = signal(false);

type World = NonNullable<ReturnType<typeof world.peek>>;
type Net = NonNullable<NonNullable<typeof live.overlay>["renderer"]["net"]>;
type Spot = { kind: "edge"; edge: number; lx: number; ly: number } | { kind: "node"; node: number };

export interface AutoStationsResult {
  /** real stations in the area */
  real: number;
  /** within MAX_OFF_M of the track */
  onTrack: number;
  /** on the track and not too close to a station already there */
  wanted: number;
  placed: number;
  refused: number;
  none?: "noBlueprint" | "noData" | "noneNear" | "noWorld";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** metres between two points, flat earth (the distances here are tens of metres) */
const metres = (aLng: number, aLat: number, bLng: number, bLat: number) =>
  Math.hypot((aLng - bLng) * 111320 * Math.cos((aLat * Math.PI) / 180), (aLat - bLat) * 110574);

const lengthOf = (pts: ArrayLike<number>) => {
  let l = 0;
  for (let k = 0; k + 5 < pts.length; k += 3) l += Math.hypot(pts[k + 3] - pts[k], pts[k + 4] - pts[k + 1]);
  return l;
};

/** the rail track that is still a blueprint: switched on, not a crossover, not tram track */
const blueprintEdges = (w: World) => w.edges.filter((e) => !e.built && !e.off && !e.crossover && (e.kind ?? 0) < 2);

/** the blueprint track nearest the point, if within MAX_OFF_M */
function nearestTrack(w: World, net: Net, lng: number, lat: number): { edge: number; lx: number; ly: number } | null {
  const [x, y] = toLocal(lng, lat);
  let best: { edge: number; frac: number; offM: number; pts: Float32Array } | null = null;
  for (const e of blueprintEdges(w)) {
    const pts = net.edgePts.get(e.id);
    if (!pts || pts.length < 6) continue;
    const [frac, off] = nearestOn(pts, x, y);
    const offM = off / Math.max(1e-9, lengthOf(pts) / Math.max(1, e.lengthM));
    if (!best || offM < best.offM) best = { edge: e.id, frac, offM, pts };
  }
  if (!best || best.offM > MAX_OFF_M) return null;
  const [lx, ly] = pointAlong(best.pts, best.frac);
  return { edge: best.edge, lx, ly };
}

const tooClose = (w: World, r: { lng: number; lat: number }) => w.save.stations.some((s) => metres(s.lng, s.lat, r.lng, r.lat) < MIN_GAP_M);

/** waits for the drawn network to follow an edit (it is a new object then), up to a few seconds */
async function settled(before: unknown, ms = 3000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (live.overlay?.renderer.net !== before) return void (await sleep(40));
    await sleep(30);
  }
}

export async function autoStations(): Promise<AutoStationsResult> {
  const map = live.map;
  let w = world.peek(), net = live.overlay?.renderer.net ?? null;
  const out: AutoStationsResult = { real: 0, onTrack: 0, wanted: 0, placed: 0, refused: 0 };
  if (!map || !w || !net) return { ...out, none: "noWorld" };
  const edges = blueprintEdges(w);
  if (!edges.length) return { ...out, none: "noBlueprint" };

  // the area the blueprint track covers
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const e of edges) {
    const pts = net.edgePts.get(e.id);
    if (!pts) continue;
    for (let k = 0; k + 2 < pts.length; k += 3) {
      const [lng, lat] = toLngLat(pts[k], pts[k + 1]);
      west = Math.min(west, lng), east = Math.max(east, lng), south = Math.min(south, lat), north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west)) return { ...out, none: "noWorld" };
  const pad = 0.001;
  const real = (await realStationsIn(west - pad, south - pad, east + pad, north + pad)).filter((r) => !r.light);
  out.real = real.length;
  if (!real.length) return { ...out, none: "noData" };

  // the real stations on the track, one per place
  const wanted: RealStation[] = [];
  for (const r of real) {
    if (!nearestTrack(w, net, r.lng, r.lat)) continue;
    out.onTrack++;
    if (tooClose(w, r) || wanted.some((o) => metres(o.lng, o.lat, r.lng, r.lat) < MIN_GAP_M)) continue;
    wanted.push(r);
  }
  out.wanted = wanted.length;
  if (!wanted.length) return { ...out, none: "noneNear" };

  const platform = buildPlatform.peek();
  for (const r of wanted) {
    w = world.peek();
    net = live.overlay?.renderer.net ?? null;
    if (!w || !net) break;
    const here = nearestTrack(w, net, r.lng, r.lat);
    if (!here || tooClose(w, r)) continue; // an earlier station's platform took the place, or the track moved
    const cur = w, curNet = net, lay = layoutOf(cur.edges, cur.nodes);
    const taken = new Set(cur.save.stations.map((s) => s.name));
    const name = await newStationName(map, r.lng, r.lat, trackDirection(curNet, ...toLocal(r.lng, r.lat, curNet.anchor)), () => taken);
    const addAt = (s: Spot) => ({
      op: "addStation" as const,
      at: s.kind === "node" ? { kind: "node" as const, node: s.node } : { kind: "edge" as const, edge: s.edge, ...lngLatToPack(...toLngLat(s.lx, s.ly)) },
      platform,
      name,
    });
    const roomOf = (s: Spot): Spot[] => {
      const pts = s.kind === "edge" ? curNet.edgePts.get(s.edge) : null;
      if (s.kind !== "edge" || !pts || pts.length < 6) return [];
      return roomNear({ edge: s.edge, frac: fractionAlong(pts, s.lx, s.ly) }, platform, lay).flatMap((c): Spot[] => {
        if (c.kind === "node") return cur.nodes.has(c.node) ? [{ kind: "node", node: c.node }] : [];
        const to = curNet.edgePts.get(c.edge);
        if (!to) return [];
        const [lx, ly] = pointAlong(to, c.frac);
        return [{ kind: "edge", edge: c.edge, lx, ly }];
      });
    };
    const start: Spot = { kind: "edge", ...here };
    const got = await firstAccepted([start], async (s) => { const a = await edit(addAt(s), true, true); return a.ok ? null : a.issues; }, roomOf, () => false);
    if (got.spot) {
      out.placed++;
      await settled(curNet);
    } else out.refused++;
  }
  return out;
}

/** The button's click: runs it and says what happened. */
export async function addRealStations() {
  if (autoStationsBusy.peek()) return;
  autoStationsBusy.value = true;
  try {
    const r = await autoStations();
    if (r.none === "noBlueprint" || r.none === "noWorld") say(t("autoStations.noBlueprint"), true);
    else if (r.none === "noData") say(t("autoStations.noData"), true);
    else if (r.none === "noneNear") say(r.onTrack > 0 ? t("autoStations.already") : t("autoStations.noneNear", { m: MAX_OFF_M }), r.onTrack === 0);
    else say(t("autoStations.done", { placed: r.placed, total: r.wanted }) + (r.refused ? " " + t("autoStations.refused", { count: r.refused }) : ""), r.placed === 0);
  } catch (e) {
    console.error("auto stations failed", e); // i18n-ignore
    say(t("autoStations.failed"), true);
  } finally {
    autoStationsBusy.value = false;
  }
}
