import type { Interval } from "./loe.js";

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function intervalMinutes(i: Interval): number {
  const from = toMinutes(i.from);
  let to = toMinutes(i.to);
  if (to <= from) to += 24 * 60; // e.g. 22:00 → 00:00
  return to - from;
}

export function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + intervalMinutes(i), 0);
}

export function formatDuration(minutes: number): string {
  if (minutes === 0) return "0 год";
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  const sign = minutes < 0 ? "−" : "";
  if (h && m) return `${sign}${h} год ${m} хв`;
  if (h) return `${sign}${h} год`;
  return `${sign}${m} хв`;
}

export function fmtInterval(i: Interval): string {
  return `${i.from}–${i.to}`;
}

export function sameIntervals(a: Interval[] | undefined, b: Interval[] | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function formatList(intervals: Interval[]): string {
  if (intervals.length === 0) return "✅ Електроенергія є весь день";
  return intervals.map((i) => `🔴 ${fmtInterval(i)} (${formatDuration(intervalMinutes(i))})`).join("\n");
}

export interface Diff {
  added: Interval[];
  removed: Interval[];
  beforeMinutes: number;
  afterMinutes: number;
}

export function diff(before: Interval[], after: Interval[]): Diff {
  const key = (i: Interval) => fmtInterval(i);
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  return {
    added: after.filter((i) => !b.has(key(i))),
    removed: before.filter((i) => !a.has(key(i))),
    beforeMinutes: totalMinutes(before),
    afterMinutes: totalMinutes(after),
  };
}

export const TIMEZONE = "Europe/Kyiv";

/** Kyiv wall-clock time as minutes since the epoch, so it compares with schedule times directly. */
export function kyivMinutes(date: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 60_000;
}

// Messages the bot sends on its own arrive without sound between these hours (Kyiv time): [from, to).
export const QUIET_HOURS = [0, 6];

export function isQuietTime(date: Date): boolean {
  const hour = Math.floor((kyivMinutes(date) % 1440) / 60);
  return hour >= QUIET_HOURS[0] && hour < QUIET_HOURS[1];
}
