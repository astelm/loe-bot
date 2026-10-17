import { TelegramError, send, SEND_LIMIT, type Env } from "./bot.js";
import type { DaySchedule } from "./loe.js";
import { formatDuration, toMinutes } from "./schedule.js";
import { allSubscribers, getLatest, removeSubscriber } from "./store.js";

// How long before an outage subscribers get a heads-up.
export const LEAD_MINUTES = 15;
const TIMEZONE = "Europe/Kyiv";

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

function dayStart(date: string): number {
  const [d, m, y] = date.split(".").map(Number);
  return Date.UTC(y, m - 1, d) / 60_000;
}

const clock = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export interface Outage { group: string; start: number; end: number }

/**
 * Outages per group in Kyiv minutes, with back-to-back intervals joined
 * (22:00–24:00 today and 00:00–02:00 tomorrow is one outage).
 */
export function outages(days: DaySchedule[]): Outage[] {
  const byGroup = new Map<string, [number, number][]>();
  for (const day of days) {
    const base = dayStart(day.date);
    for (const [group, intervals] of Object.entries(day.groups)) {
      for (const i of intervals) {
        const start = base + toMinutes(i.from);
        let end = base + toMinutes(i.to);
        if (end <= start) end += 1440; // e.g. 23:00 → 00:00
        byGroup.set(group, [...(byGroup.get(group) ?? []), [start, end]]);
      }
    }
  }
  const result: Outage[] = [];
  for (const [group, spans] of byGroup) {
    spans.sort((a, b) => a[0] - b[0]);
    let current: Outage | null = null;
    for (const [start, end] of spans) {
      if (current && start <= current.end) {
        current.end = Math.max(current.end, end);
      } else {
        if (current) result.push(current);
        current = { group, start, end };
      }
    }
    if (current) result.push(current);
  }
  return result;
}

export function renderReminder(o: Outage, now: number): string {
  return [
    `⏰ Через ${o.start - now} хв вимкнуть світло — група <b>${o.group}</b>`,
    `🔴 ${clock(o.start)}–${clock(o.end)} (${formatDuration(o.end - o.start)})`,
  ].join("\n");
}

/**
 * Called every minute: messages subscribers whose outage starts in LEAD_MINUTES.
 * Remembers how far ahead it has already looked, so a skipped minute isn't missed
 * and nobody is reminded twice.
 */
export async function runReminders(env: Env, { now = new Date() } = {}): Promise<string> {
  const nowMin = kyivMinutes(now);
  const until = nowMin + LEAD_MINUTES;
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = 'reminded_until'").first<{ value: string }>();
  // Outages already under way get no reminder.
  const from = Math.max(row ? Number(row.value) : until - 1, nowMin);
  const writes = [
    env.DB.prepare("INSERT INTO state (key, value) VALUES ('reminded_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(until)),
  ];

  const latest = await getLatest(env.DB);
  const due = outages(latest?.days ?? []).filter((o) => o.start > from && o.start <= until);
  let sent = 0;
  let skipped = 0;
  if (due.length) {
    const subs = await allSubscribers(env.DB);
    for (const o of due) {
      for (const sub of subs.filter((s) => s.group === o.group)) {
        if (sent >= SEND_LIMIT) {
          skipped++;
          continue;
        }
        sent++;
        try {
          await send(env, sub.chatId, renderReminder(o, nowMin));
        } catch (err) {
          console.log(`reminder ${sub.chatId}: ${(err as Error).message}`);
          if (err instanceof TelegramError && (err.status === 403 || err.status === 400)) {
            writes.push(removeSubscriber(env.DB, sub.chatId));
          }
        }
      }
    }
  }
  await env.DB.batch(writes);
  return `sent ${sent}` + (skipped ? `, ${skipped} over the limit` : "");
}
