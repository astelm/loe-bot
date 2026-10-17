// DTEK Kyiv (dtek-kem.com.ua). Its site blocks Cloudflare, so a GitHub Actions job
// (scripts/dtek.py) reads it and posts the data to the worker; this file turns that data
// into the same shape as the Lviv schedule and looks up addresses.
import type { DaySchedule, Interval } from "./loe.js";

/** `DisconSchedule.fact` from the DTEK site: day (unix time of Kyiv midnight) -> "GPV15.1" -> hour "1".."24" -> state. */
export interface DtekFact {
  data: Record<string, Record<string, Record<string, string>>>;
  update?: string;
}

// Hour states that mean no power, as [first half-hour, second half-hour].
// "maybe", "mfirst" and "msecond" are possible outages and don't count.
const OFF: Record<string, [boolean, boolean]> = { no: [true, true], first: [true, false], second: [false, true] };

const halfHour = (n: number) => `${String(Math.floor(n / 2)).padStart(2, "0")}:${n % 2 ? "30" : "00"}`;

/** "GPV15.1" -> "15.1" */
export const dtekGroup = (key: string) => key.replace(/^GPV/, "");

function kyivDate(unixSeconds: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(unixSeconds * 1000)).map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month}.${p.year}`;
}

/** `updatedAt` is DTEK's "HH:MM DD.MM.YYYY" update time, when known. */
export function parseFact(fact: DtekFact, updatedAt: string | null = fact.update ?? null): DaySchedule[] {
  const days: DaySchedule[] = [];
  for (const [ts, groups] of Object.entries(fact.data ?? {})) {
    const day: DaySchedule = { date: kyivDate(Number(ts)), updatedAt, groups: {} };
    for (const [key, hours] of Object.entries(groups)) {
      const off: boolean[] = [];
      for (let h = 1; h <= 24; h++) off.push(...(OFF[hours[String(h)]] ?? [false, false]));
      const intervals: Interval[] = [];
      for (let i = 0; i < 48; i++) {
        if (!off[i] || off[i - 1]) continue;
        let j = i;
        while (off[j]) j++;
        intervals.push({ from: halfHour(i), to: halfHour(j) });
      }
      day.groups[dtekGroup(key)] = intervals;
    }
    days.push(day);
  }
  return days.sort((a, b) => a.date.split(".").reverse().join().localeCompare(b.date.split(".").reverse().join()));
}

const STREET_PREFIX = /^(вул(иця)?|просп(ект)?|пров(улок)?|бульв(ар)?|пл(оща)?|наб(ережна)?|шосе|узвіз|туп(ик)?|пр-т|майдан|алея|проїзд|дорога)\.?\s+/i;

export function normalizeStreet(s: string): string {
  return s.toLowerCase().replace(/[’'`ʼ]/g, "'").replace(STREET_PREFIX, "").replace(/[.,()]/g, " ").replace(/\s+/g, " ").trim();
}

/** Streets whose name contains every word typed, shortest names first. */
export function searchStreets(names: string[], query: string): string[] {
  const words = normalizeStreet(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  return names
    .filter((n) => {
      const norm = normalizeStreet(n);
      return words.every((w) => norm.includes(w));
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

const normalizeHouse = (h: string) => h.toUpperCase().replace(/\s+/g, "").replace(/\//g, "").replace(/[‐–—]/g, "-");
const leadingNumber = (h: string) => /^\d+/.exec(h.trim())?.[0];

/**
 * Finds the house as typed ("27б", "27/Б", "27 б"). Returns the exact match,
 * or the houses with the same number to choose from.
 */
export function findHouse(houses: Record<string, string>, input: string): { exact: string } | { options: string[] } {
  const want = normalizeHouse(input);
  const exact = Object.keys(houses).find((h) => normalizeHouse(h) === want);
  if (exact) return { exact };
  const num = leadingNumber(input);
  const options = num ? Object.keys(houses).filter((h) => leadingNumber(h) === num) : [];
  return { options: options.sort((a, b) => a.length - b.length || a.localeCompare(b)) };
}
