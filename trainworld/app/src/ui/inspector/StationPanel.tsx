// The station board: a centred panel (like the schedule panel's) for a station, or its complex, opened by the button
// beside the station's name in its inspector. Departures: the next trains over every line that stops there. Timetable:
// the day by hour for one line and direction at a time, as a station's poster. Riders: boardings in the past 24 hours
// by line, what the riders travel for, who waits now. Info: the lines, the station's own facts and its complex.
// Departures come from the same read the schedule panel's board uses (`stationDepartures`, the sim's own timetable).

import { useEffect, useMemo, useState } from "preact/hooks";
import { clock } from "../../game/clock";
import { complexOf } from "../../game/complexView";
import { complexTitle } from "../../game/complexLead";
import { clockTime, count, distance, levelLabel } from "../../game/format";
import { stationPanelShown } from "../../game/stationPanel";
import { selection } from "../../game/ui";
import { today, useToday } from "../../game/today";
import type { LineInput, LineStats, StationInput } from "../../game/types";
import { linesAt, stationNames, stationsById, world } from "../../game/world";
import { t } from "../../i18n";
import { Modal } from "../Modal";
import { useLatestAnswer } from "../useClockQuery";
import { Chip, Row, Segmented } from "../widgets";
import { BoardingsToday, Waiting } from "./StationInspector";
import { stationDepartures } from "./SchedulePanel";

const DAY = 86400, HOUR = 3600;
/** the timetable's day starts at this local hour, as in the schedule panel */
const DAY_START_H = 4;
/** departures the board lists */
const SHOWN = 14;

type Tab = "departures" | "timetable" | "riders" | "info";

/** One train leaving the station: its line, the member station it leaves, run, stop index in the run, game seconds. */
interface Dep { line: LineInput; st: LineStats; member: string; run: number; k: number; t: number; shift: number }

/** Every rail line's departures at the station (or its complex's stations) from `t0` to `t1`, in time order. */
async function boardOf(members: string[], t0: number, t1: number): Promise<Dep[] | null> {
  const w = world.peek();
  if (!w) return null;
  const jobs: Promise<Dep[] | null>[] = [];
  for (const m of members)
    for (const l of linesAt(m)) {
      const st = w.lineStats[l.id];
      // the sim keeps no timetable for a bus or ferry line
      if (!st || st.status !== "running" || st.bus || l.stops.length < 2) continue;
      jobs.push(stationDepartures(l, st, m, t0, t1).then((ds) => ds && ds.map((d) => ({ line: l, st, member: m, run: d.run, k: d.k, t: d.t, shift: st.shift ?? 0 }))));
    }
  const done = await Promise.all(jobs);
  if (done.some((d) => !d)) return null;
  return done.flatMap((d) => d!).sort((a, b) => a.t - b.t);
}

/** A run's heading: where its trains go, or on a loop the next stop. */
function heading(d: { line: LineInput; st: LineStats; run: number; k: number }, names: Map<string, string>): string {
  const stops = d.line.stops, n = stops.length;
  if (d.st.loop) return t("schedulePanel.via", { station: names.get((d.run === 0 ? stops[d.k + 1] : stops[n - 2 - d.k]) ?? "") ?? "" });
  return t("schedulePanel.to", { station: names.get(d.run === 0 ? stops[n - 1] : stops[0]) ?? "" });
}

/** local time of day of a departure, "HH:MM" */
const clockOf = (d: Dep) => clockTime(Math.floor((((d.t + d.shift) % DAY) + DAY) % DAY / 60));

function Departures({ deps, nowS, names, complex }: { deps: Dep[] | null; nowS: number; names: Map<string, string>; complex: boolean }) {
  if (!deps) return <p class="muted">{t("stationPanel.loading")}</p>;
  const next = deps.filter((d) => d.t >= nowS - 20).slice(0, SHOWN);
  if (!next.length) return <p class="muted">{t("stationPanel.noDepartures")}</p>;
  return (
    <ul class="rows sb-deps">
      {next.map((d) => {
        const min = Math.max(0, Math.round((d.t - nowS) / 60));
        return (
          <li key={d.line.id + ":" + d.member + ":" + d.t}>
            <span class="sb-time">{clockOf(d)}</span>
            <Chip line={d.line} size="sm" />
            <span class="grow what">
              <span>{heading(d, names)}</span>
              {complex && <span class="muted small">{t("stationPanel.at", { station: names.get(d.member) ?? "" })}</span>}
            </span>
            <span class="val num">{min === 0 ? t("stationPanel.now") : t("inspector.min", { n: min })}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A line's direction at one station: the timetable's choice. */
interface Group { key: string; label: string; deps: Dep[] }

function Timetable({ deps, nowS, names, complex }: { deps: Dep[] | null; nowS: number; names: Map<string, string>; complex: boolean }) {
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group & { line: number }>();
    for (const d of deps ?? []) {
      const key = `${d.line.id}:${d.member}:${d.run}`;
      let g = m.get(key);
      if (!g) m.set(key, (g = { key, line: d.line.num, deps: [], label: `${d.line.name} · ${heading(d, names)}${complex ? " · " + (names.get(d.member) ?? "") : ""}` }));
      g.deps.push(d);
    }
    return [...m.values()].sort((a, b) => a.line - b.line || a.key.localeCompare(b.key));
  }, [deps, complex]);
  const [pick, setPick] = useState("");
  if (!deps) return <p class="muted">{t("stationPanel.loading")}</p>;
  if (!groups.length) return <p class="muted">{t("stationPanel.noDepartures")}</p>;
  const g = groups.find((x) => x.key === pick) ?? groups[0];
  // the hours with a train, each with its minutes
  const rows = Array.from({ length: 24 }, (_, i) => ({ hour: (DAY_START_H + i) % 24, mins: [] as string[] }));
  for (const d of g.deps) {
    const local = (((d.t + d.shift) % DAY) + DAY) % DAY;
    rows[(Math.floor(local / HOUR) - DAY_START_H + 24) % 24].mins.push(String(Math.floor((local % HOUR) / 60)).padStart(2, "0"));
  }
  const used = rows.map((r) => r.mins.length > 0), a = used.indexOf(true), b = used.lastIndexOf(true);
  const shown = a < 0 ? [] : rows.slice(a, b + 1);
  const d0 = g.deps[0], hourNow = Math.floor((((nowS + d0.shift) % DAY) + DAY) % DAY / HOUR);
  return (
    <>
      <div class="sp-tools">
        <select aria-label={t("stationPanel.lineDirection")} value={g.key} onChange={(e) => setPick(e.currentTarget.value)}>
          {groups.map((x) => <option value={x.key}>{x.label}</option>)}
        </select>
      </div>
      <div class="sp-board" style={{ "--runs": 1 }}>
        <div class="sp-grid">
          {shown.map((r) => (
            <div class={"sp-row" + (r.hour === hourNow ? " now" : "")} key={r.hour}>
              <span class="sp-hour">{r.hour}</span>
              <span class="sp-mins">{r.mins.map((m) => <span>{m}</span>)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Riders({ members, w }: { members: string[]; w: NonNullable<ReturnType<typeof world.peek>> }) {
  const tdy = today.value;
  const byId = stationsById(w);
  // each line once, with its boardings at the station's members in the past 24 hours (a line may stop twice: both count)
  const lines = new Map<string, LineInput>();
  for (const m of members) for (const l of linesAt(m)) lines.set(l.id, l);
  const visits = (l: LineInput) => l.stops.flatMap((x, k) => (members.includes(x) ? [k] : []));
  const rows = [...lines.values()].map((l) => ({ l, n: visits(l).reduce((a, k) => a + (tdy.get(l.id)?.stops[k] ?? 0), 0), known: tdy.has(l.id) })).sort((a, b) => b.n - a.n);
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!rows.length) return <p class="muted">{t("stationPanel.noLines")}</p>;
  return (
    <>
      <div class="h">{t("stationPanel.boardingsByLine")}</div>
      <ul class="rows pick sb-share">
        {rows.map(({ l, n, known }) => (
          <li onClick={() => (selection.value = { kind: "line", line: l.id })}>
            <Chip line={l} />
            <span class="grow what">
              <span>{l.name}</span>
              <span class="sb-bar" style={{ width: total ? `${Math.round((100 * n) / total)}%` : "0%" }} />
            </span>
            <span class="val num">{known ? count(n) : ""}</span>
          </li>
        ))}
      </ul>
      <BoardingsToday lines={[...lines.values()]} at={visits} />
      {members.map((m) => {
        const s = byId.get(m);
        return s ? <Waiting key={m} node={s.num} lines={linesAt(m)} /> : null;
      })}
    </>
  );
}

function Info({ s, members, w }: { s: StationInput; members: string[]; w: NonNullable<ReturnType<typeof world.peek>> }) {
  const byId = stationsById(w), names = stationNames(w);
  const lines = new Map<string, LineInput>();
  for (const m of members) for (const l of linesAt(m)) lines.set(l.id, l);
  return (
    <ul class="rows">
      <Row label={t("stationPanel.lines")}>
        <span class="bullets">{[...lines.values()].map((l) => <Chip line={l} size="sm" />)}</span>
      </Row>
      <Row label={t("stationPanel.level")}>{levelLabel(s.level)}</Row>
      {!s.port && <Row label={t("stationPanel.length")}>{distance(s.length)}</Row>}
      {!s.built && <Row label={t("stationPanel.status")}>{t("stationPanel.planned")}</Row>}
      {members.length > 1 && (
        <>
          <li class="h">{t("stationInspector.complexOfN", { count: members.length })}</li>
          {members.map((m) => {
            const o = byId.get(m);
            return o ? (
              <li>
                <span class="grow">{names.get(m) ?? o.name}</span>
                <span class="bullets">{linesAt(m).map((l) => <Chip line={l} size="sm" />)}</span>
              </li>
            ) : null;
          })}
        </>
      )}
    </ul>
  );
}

function Board({ id }: { id: string }) {
  const w = world.value!, s = stationsById(w).get(id)!;
  const members = useMemo(() => complexOf(id), [id, w.version]);
  const [tab, setTab] = useState<Tab>("departures");
  useToday(); // boardings in the past 24 hours, kept fresh while the panel is open
  const nowS = clock.minute.value * 60; // re-renders each game minute
  const t0 = Math.floor(nowS / HOUR) * HOUR;
  const deps = useLatestAnswer(() => boardOf(members, t0, t0 + DAY), [members.join(","), w.version, t0]);
  const names = stationNames(w);
  const complex = members.length > 1;
  const title = complex ? complexTitle(s) : names.get(id) ?? s.name;
  const tabs: [Tab, string][] = [["departures", t("stationPanel.departures")], ["timetable", t("stationPanel.timetable")], ["riders", t("stationPanel.riders")], ["info", t("stationPanel.info")]];
  return (
    <Modal open onClose={() => (stationPanelShown.value = null)} title={title} cls="station-panel"
      head={<span class="sb-tabs"><Segmented options={tabs} value={tab} onChange={setTab} /></span>}>
      <div class="sb-body">
        {tab === "departures" && <Departures deps={deps} nowS={nowS} names={names} complex={complex} />}
        {tab === "timetable" && <Timetable deps={deps} nowS={nowS} names={names} complex={complex} />}
        {tab === "riders" && <Riders members={members} w={w} />}
        {tab === "info" && <Info s={s} members={members} w={w} />}
      </div>
    </Modal>
  );
}

/** The station board while `stationPanelShown`; it closes when its station goes. */
export function StationPanel() {
  const id = stationPanelShown.value, w = world.value;
  const s = id && w ? stationsById(w).get(id) : undefined;
  useEffect(() => { if (id && w && !s) stationPanelShown.value = null; }, [id, !!w, !s]);
  if (!id || !w || !s) return null;
  return <Board id={id} />;
}
