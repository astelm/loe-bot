import { TelegramError, send, SEND_LIMIT, type Env } from "./bot.js";
import type { DaySchedule } from "./loe.js";
import { formatDuration, kyivMinutes, toMinutes } from "./schedule.js";
import { allSubscribers, getLatest, removeSubscriber } from "./store.js";

// How long before an outage subscribers get a heads-up.
export const LEAD_MINUTES = 15;
// A "power is back" message is still sent this long after the end, e.g. when a
// shorter outage is published after its new end time.
const POWER_ON_CATCH_UP = 60;
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

export function renderPowerOn(o: Outage, next: Outage | undefined): string {
  return [
    `💡 За графіком світло вже є — група <b>${o.group}</b>`,
    `Відключення ${clock(o.start)}–${clock(o.end)} закінчилося.`,
    next
      ? `Наступне: 🔴 ${clock(next.start)}–${clock(next.end)} (${formatDuration(next.end - next.start)})`
      : "Більше відключень у графіку поки немає.",
  ].join("\n");
}

const setState = (env: Env, key: string, value: string) =>
  env.DB.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value);

async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Called every minute, using the newest schedule each time:
 * - ⏰ LEAD_MINUTES before an outage starts. Remembers how far ahead it has looked,
 *   so a skipped minute isn't missed and nobody is reminded twice. If the start
 *   moves later, there's a reminder for the new time too.
 * - 💡 when an outage ends. Remembered per group and end time, so if the end moves
 *   (extended, or cut short and published late) the message follows the new end.
 */
export async function runReminders(env: Env, { now = new Date() } = {}): Promise<string> {
  const nowMin = kyivMinutes(now);
  const until = nowMin + LEAD_MINUTES;
  const stored = await getState(env, "reminded_until");
  // Outages already under way get no reminder.
  const from = Math.max(stored ? Number(stored) : until - 1, nowMin);

  const all = outages((await getLatest(env.DB))?.days ?? []);
  const messages: { group: string; text: string }[] = [];
  for (const o of all.filter((o) => o.start > from && o.start <= until)) {
    messages.push({ group: o.group, text: renderReminder(o, nowMin) });
  }

  const sentState = await getState(env, "power_on_sent");
  const sentEnds: string[] = JSON.parse(sentState ?? "[]");
  const ended = all.filter((o) => o.end <= nowMin && o.end > nowMin - POWER_ON_CATCH_UP && !sentEnds.includes(`${o.group}@${o.end}`));
  // The very first run only takes note of outages that already ended.
  for (const o of sentState === null ? [] : ended) {
    const next = all.find((n) => n.group === o.group && n.start > o.end);
    messages.push({ group: o.group, text: renderPowerOn(o, next) });
  }
  const keepEnds = [...sentEnds, ...ended.map((o) => `${o.group}@${o.end}`)]
    .filter((k) => Number(k.split("@")[1]) > nowMin - 1440);

  const writes = [setState(env, "reminded_until", String(until)), setState(env, "power_on_sent", JSON.stringify(keepEnds))];
  let sent = 0;
  let skipped = 0;
  if (messages.length) {
    const subs = await allSubscribers(env.DB);
    const gone = new Set<string>();
    for (const m of messages) {
      for (const sub of subs.filter((s) => s.group === m.group && !gone.has(s.chatId))) {
        if (sent >= SEND_LIMIT) {
          skipped++;
          continue;
        }
        sent++;
        try {
          await send(env, sub.chatId, m.text);
        } catch (err) {
          console.log(`reminder ${sub.chatId}: ${(err as Error).message}`);
          if (err instanceof TelegramError && (err.status === 403 || err.status === 400)) {
            gone.add(sub.chatId);
            writes.push(removeSubscriber(env.DB, sub.chatId));
          }
        }
      }
    }
  }
  await env.DB.batch(writes);
  return `sent ${sent}` + (skipped ? `, ${skipped} over the limit` : "");
}
