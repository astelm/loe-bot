// Fetches and parses the outage schedule shown on https://poweron.loe.lviv.ua/
// The site is a SPA that reads this JSON feed.
export const API_URL = "https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic";

export const GROUPS = [
  "1.1", "1.2", "2.1", "2.2", "3.1", "3.2",
  "4.1", "4.2", "5.1", "5.2", "6.1", "6.2",
] as const;

export interface Interval {
  from: string; // "HH:MM"
  to: string;   // "HH:MM" ("24:00" allowed)
}

export interface DaySchedule {
  date: string;              // "DD.MM.YYYY"
  updatedAt: string | null;  // "HH:MM DD.MM.YYYY" from "Інформація станом на ..."
  groups: Record<string, Interval[]>; // group -> outage intervals ([] = power on all day)
}

interface MenuItem {
  name?: string;
  rawHtml?: string | null;
  rawMobileHtml?: string | null;
}

interface ApiResponse {
  "hydra:member"?: { menuItems?: MenuItem[] }[];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Parses one schedule block (the HTML of a single day). Returns null if it isn't a schedule. */
export function parseSchedule(html: string): DaySchedule | null {
  const text = htmlToText(html);
  const dateMatch = text.match(/Графік погодинних відключень на\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (!dateMatch) return null;

  const updated = text.match(/станом на\s*(\d{1,2}:\d{2}\s*\d{2}\.\d{2}\.\d{4})/i);
  const groups: Record<string, Interval[]> = {};

  // Each group line: "Група 1.1. Електроенергії немає з 20:00 до 22:00, з 23:00 до 24:00."
  //               or "Група 2.1. Електроенергія є."
  const groupRe = /Група\s*(\d\.\d)\.?\s*([\s\S]*?)(?=Група\s*\d\.\d|$)/g;
  for (const m of text.matchAll(groupRe)) {
    const [, group, body] = m;
    const intervals: Interval[] = [];
    for (const r of body.matchAll(/з\s*(\d{1,2}:\d{2})\s*до\s*(\d{1,2}:\d{2})/g)) {
      intervals.push({ from: pad(r[1]), to: pad(r[2]) });
    }
    groups[group] = intervals;
  }

  if (Object.keys(groups).length === 0) return null;
  return { date: dateMatch[1], updatedAt: updated ? updated[1].replace(/\s+/, " ") : null, groups };
}

function pad(t: string): string {
  const [h, m] = t.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

/** Returns all day schedules currently published (usually today, sometimes tomorrow too). */
export async function fetchSchedules(): Promise<DaySchedule[]> {
  const res = await fetch(API_URL, {
    headers: { Accept: "application/ld+json, application/json", "User-Agent": "loe-outage-telegram-bot/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`LOE API responded ${res.status}`);
  const data = (await res.json()) as ApiResponse;

  const byDate = new Map<string, DaySchedule>();
  for (const menu of data["hydra:member"] ?? []) {
    for (const item of menu.menuItems ?? []) {
      const html = item.rawHtml || item.rawMobileHtml;
      if (!html) continue;
      const s = parseSchedule(html);
      if (s) byDate.set(s.date, s);
    }
  }
  return [...byDate.values()].sort((a, b) => toSortable(a.date).localeCompare(toSortable(b.date)));
}

export function toSortable(date: string): string {
  const [d, m, y] = date.split(".");
  return `${y}${m}${d}`;
}
