// Kyiv outage schedules and address lookup from Yasno (https://yasno.ua), the
// same public API its site and app use. Unlike DTEK's site, it answers Cloudflare.
import type { DaySchedule, Interval } from "./loe.js";
import { kyivMinutes } from "./schedule.js";

const BASE = "https://app.yasno.ua/api/blackout-service/public/shutdowns";
const REGION = 25; // Київ
const DSO = 902;   // ДТЕК Київські електромережі

export interface Slot { start: number; end: number; type: string }
export interface YasnoDay { slots?: Slot[]; date?: string; status?: string }
/** `{"1.1": {today, tomorrow, updatedOn}, ...}` */
export type PlannedOutages = Record<string, { today?: YasnoDay; tomorrow?: YasnoDay; updatedOn?: string }>;

export interface Option { id: number; name: string }

/** Everything the bot asks Yasno, so tests can swap it out. */
export interface Yasno {
  schedules(): Promise<DaySchedule[]>;
  streets(query: string): Promise<Option[]>;
  houses(streetId: number, query: string): Promise<Option[]>;
  /** "15.1", or null if Yasno doesn't know the house. */
  group(streetId: number, houseId: number): Promise<string | null>;
}

async function get<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Yasno ${resp.status} for ${path}`);
  return resp.json() as Promise<T>;
}

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "2026-10-17T08:16:49+00:00" -> "11:16 17.10.2026" in Kyiv time. */
function kyivStamp(iso: string | undefined): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) return null;
  const minutes = kyivMinutes(new Date(ms));
  const d = new Date(minutes * 60_000);
  const date = `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
  return `${clock(minutes % 1440)} ${date}`;
}

/** Definite outage slots (minutes 0..1440), with back-to-back ones joined. */
function intervals(slots: Slot[]): Interval[] {
  const out: [number, number][] = [];
  for (const s of [...slots].filter((s) => s.type === "Definite").sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last[1]) last[1] = Math.max(last[1], s.end);
    else out.push([s.start, s.end]);
  }
  return out.map(([from, to]) => ({ from: clock(from), to: clock(to) }));
}

/** Days with a published schedule, oldest first. Days still waiting for one are left out. */
export function parsePlanned(data: PlannedOutages): DaySchedule[] {
  const byDate = new Map<string, DaySchedule>();
  for (const [group, g] of Object.entries(data)) {
    if (!/^\d+\.\d+$/.test(group)) continue;
    for (const day of [g.today, g.tomorrow]) {
      if (!day?.date || day.status !== "ScheduleApplies") continue;
      const [y, m, d] = day.date.slice(0, 10).split("-");
      const date = `${d}.${m}.${y}`;
      const entry = byDate.get(date) ?? { date, updatedAt: null, groups: {} };
      entry.groups[group] = intervals(day.slots ?? []);
      const stamp = kyivStamp(g.updatedOn);
      if (stamp && (!entry.updatedAt || stamp > entry.updatedAt)) entry.updatedAt = stamp;
      byDate.set(date, entry);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.split(".").reverse().join().localeCompare(b.date.split(".").reverse().join()));
}

/** "вул. Хрещатик" -> "Хрещатик": Yasno searches by the name itself. */
export function streetQuery(text: string): string {
  return text
    .replace(/^\s*(вулиця|вул\.?|проспект|просп\.?|провулок|пров\.?|бульвар|бульв\.?|б-р|площа|пл\.?|узвіз|набережна|наб\.?|шосе|тупик|проїзд)\s+/i, "")
    .trim();
}

/** "27 б", "27/Б" and "27б" are the same house. */
export const sameHouse = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[\s/]/g, "");
  return norm(a) === norm(b);
};

const q = (s: string) => encodeURIComponent(s);
const list = (items: { id: number; value: string }[]) => items.map((i) => ({ id: i.id, name: i.value }));

export const liveYasno: Yasno = {
  schedules: async () => parsePlanned(await get(`/regions/${REGION}/dsos/${DSO}/planned-outages`)),
  streets: async (query) => list(await get(`/addresses/v2/streets?regionId=${REGION}&query=${q(streetQuery(query))}&dsoId=${DSO}`)),
  houses: async (streetId, query) =>
    list(await get(`/addresses/v2/houses?regionId=${REGION}&streetId=${streetId}&query=${q(query.trim())}&dsoId=${DSO}`)),
  group: async (streetId, houseId) => {
    const r = await get<{ group?: number; subgroup?: number }>(
      `/addresses/v2/group?regionId=${REGION}&streetId=${streetId}&houseId=${houseId}&dsoId=${DSO}`,
    );
    return r.group ? `${r.group}.${r.subgroup ?? 1}` : null;
  },
};
