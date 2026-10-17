import { fetchSchedules, GROUPS, toSortable, type DaySchedule, type Interval } from "./loe.js";
import { diff, fmtInterval, formatDuration, formatList, isQuietTime, sameIntervals, totalMinutes } from "./schedule.js";
import {
  allSubscribers, getLatest, getSubscriber, removeSubscriber, saveLatest, saveSubscriber, type Subscriber,
} from "./store.js";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

export type FetchSchedules = () => Promise<DaySchedule[]>;

// Free Workers plan allows 50 outgoing requests per run; one goes to LOE.
// Messages over this limit are sent on the next run.
export const SEND_LIMIT = 45;
// Commands reuse schedules fetched this recently instead of asking LOE again.
const FRESH_MS = 10 * 60_000;

// ---------- Telegram ----------

export class TelegramError extends Error {
  constructor(readonly status: number, description: string) {
    super(`Telegram error ${status}: ${description}`);
  }
}

export async function telegram(env: Env, method: string, params: object = {}): Promise<unknown> {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (!resp.ok || !data.ok) throw new TelegramError(resp.status, data.description ?? resp.statusText);
  return data.result;
}

export const send = (env: Env, chatId: string, text: string, extra: object = {}) =>
  telegram(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

interface Chat { id: number }
export interface Update {
  message?: { chat: Chat; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
}

// ---------- UI ----------

export function groupKeyboard(current?: string) {
  const buttons = GROUPS.map((g) => ({ text: g === current ? `• ${g} •` : g, callback_data: `group:${g}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { inline_keyboard: rows };
}

function renderDay(day: DaySchedule, group: string): string {
  const intervals = day.groups[group];
  if (!intervals) return `📅 <b>${day.date}</b>\nГрупи ${group} немає в графіку.`;
  const total = totalMinutes(intervals);
  return [
    `📅 <b>${day.date}</b> — група <b>${group}</b>`,
    formatList(intervals),
    `⏱ Всього без світла: <b>${formatDuration(total)}</b> · зі світлом: ${formatDuration(24 * 60 - total)}`,
    day.updatedAt ? `<i>Станом на ${day.updatedAt}</i>` : "",
  ].filter(Boolean).join("\n");
}

export function renderAll(days: DaySchedule[], group: string): string {
  if (days.length === 0) return "Не вдалося отримати графік. Спробую ще раз за кілька хвилин.";
  const parts = days.map((d) => renderDay(d, group));
  if (days.length > 1) {
    const sum = days.reduce((s, d) => s + totalMinutes(d.groups[group] ?? []), 0);
    parts.push(`📊 Разом за ${days.length} дн.: <b>${formatDuration(sum)}</b> без світла`);
  }
  return parts.join("\n\n");
}

export function renderChange(day: DaySchedule, group: string, before: Interval[] | undefined): string {
  const after = day.groups[group] ?? [];
  if (before === undefined) {
    return `🆕 <b>Новий графік</b>\n\n${renderDay(day, group)}`;
  }
  const d = diff(before, after);
  const delta = d.afterMinutes - d.beforeMinutes;
  const lines = [`⚠️ <b>Графік змінено</b>`, "", renderDay(day, group), ""];
  if (d.removed.length) lines.push(`➖ Скасовано: ${d.removed.map(fmtInterval).join(", ")}`);
  if (d.added.length) lines.push(`➕ Додано: ${d.added.map(fmtInterval).join(", ")}`);
  lines.push(
    `⏱ Було: ${formatDuration(d.beforeMinutes)} → стало: <b>${formatDuration(d.afterMinutes)}</b>` +
      (delta ? ` (${delta > 0 ? "+" : ""}${formatDuration(delta)})` : ""),
  );
  return lines.join("\n");
}

// ---------- Commands ----------

/** Schedules from the last few minutes, or freshly fetched. */
async function currentSchedules(env: Env, fetchFn: FetchSchedules, now: number): Promise<DaySchedule[]> {
  const latest = await getLatest(env.DB);
  if (latest && now - latest.at < FRESH_MS) return latest.days;
  try {
    const days = await fetchFn();
    await saveLatest(env.DB, { at: now, days }).run();
    return days;
  } catch (err) {
    console.log(`fetch failed: ${(err as Error).message}`);
    return latest?.days ?? [];
  }
}

async function pickGroup(env: Env, query: NonNullable<Update["callback_query"]>, fetchFn: FetchSchedules, now: number) {
  const group = /^group:(\d\.\d)$/.exec(query.data ?? "")?.[1];
  const msg = query.message;
  if (!group || !msg) return;
  const chatId = String(msg.chat.id);
  const days = await currentSchedules(env, fetchFn, now);
  // Remember what we're showing now, so only later changes trigger alerts.
  const lastSent: Record<string, Interval[]> = {};
  for (const d of days) if (d.groups[group]) lastSent[d.date] = d.groups[group];
  await saveSubscriber(env.DB, { chatId, group, lastSent }).run();

  await telegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: `Група ${group}` }).catch(() => {});
  await telegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: msg.message_id,
    text: `Групу <b>${group}</b> збережено. Повідомлю, щойно графік зміниться.`,
    parse_mode: "HTML",
  }).catch((err) => console.log(`edit ${chatId}: ${err.message}`));
  await send(env, chatId, renderAll(days, group));
}

export async function handleUpdate(
  env: Env,
  update: Update,
  { now = Date.now(), fetchFn = fetchSchedules as FetchSchedules } = {},
): Promise<void> {
  if (update.callback_query) return pickGroup(env, update.callback_query, fetchFn, now);
  const msg = update.message;
  if (!msg?.chat || !msg.text?.startsWith("/")) return;
  const command = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  const chatId = String(msg.chat.id);

  if (command === "/start") {
    const sub = await getSubscriber(env.DB, chatId);
    await send(
      env, chatId,
      "Привіт! Я стежу за графіком відключень Львівобленерго (poweron.loe.lviv.ua) кожні 10 хвилин.\n\nОбери свою групу:",
      { reply_markup: groupKeyboard(sub?.group) },
    );
  } else if (command === "/group") {
    const sub = await getSubscriber(env.DB, chatId);
    await send(env, chatId, "Обери групу:", { reply_markup: groupKeyboard(sub?.group) });
  } else if (command === "/now") {
    const sub = await getSubscriber(env.DB, chatId);
    if (!sub) return void (await send(env, chatId, "Спершу обери групу: /group"));
    await send(env, chatId, renderAll(await currentSchedules(env, fetchFn, now), sub.group));
  } else if (command === "/stop") {
    await removeSubscriber(env.DB, chatId).run();
    await send(env, chatId, "Сповіщення вимкнено. /start — щоб увімкнути знову.");
  }
}

// ---------- Polling ----------

/** Forget dates the site no longer publishes, keeping the newest few. Returns true if any were dropped. */
function pruneLastSent(sub: Subscriber, known: Set<string>): boolean {
  const dates = Object.keys(sub.lastSent);
  const keep = [...dates].sort((a, b) => toSortable(b).localeCompare(toSortable(a))).slice(0, 3);
  let pruned = false;
  for (const date of dates) {
    if (!keep.includes(date) && !known.has(date)) {
      delete sub.lastSent[date];
      pruned = true;
    }
  }
  return pruned;
}

/** Called every 10 minutes: fetches schedules and tells each subscriber about changes for their group. */
export async function runPoll(
  env: Env,
  { now = Date.now(), fetchFn = fetchSchedules as FetchSchedules } = {},
): Promise<string> {
  let days: DaySchedule[];
  try {
    days = await fetchFn();
  } catch (err) {
    return `fetch failed: ${(err as Error).message}`; // subscribers keep the previous state
  }

  const writes = [saveLatest(env.DB, { at: now, days })];
  const known = new Set(days.map((d) => d.date));
  let sent = 0;
  let postponed = 0;
  for (const sub of await allSubscribers(env.DB)) {
    let changed = false;
    let gone = false;
    for (const day of days) {
      const current = day.groups[sub.group];
      if (!current) continue;
      const before = sub.lastSent[day.date];
      if (sameIntervals(before, current)) continue;
      if (sent >= SEND_LIMIT) {
        postponed++; // lastSent stays as is, so the next run sends it
        continue;
      }
      sent++;
      try {
        await send(env, sub.chatId, renderChange(day, sub.group, before), { disable_notification: isQuietTime(new Date(now)) });
        sub.lastSent[day.date] = current;
        changed = true;
      } catch (err) {
        console.log(`send ${sub.chatId}: ${(err as Error).message}`);
        // Blocked the bot, or the chat no longer exists.
        if (err instanceof TelegramError && (err.status === 403 || err.status === 400)) {
          writes.push(removeSubscriber(env.DB, sub.chatId));
          gone = true;
          break;
        }
      }
    }
    if (gone) continue;
    if (pruneLastSent(sub, known) || changed) {
      // Only if they haven't switched groups meanwhile.
      writes.push(
        env.DB.prepare("UPDATE subscribers SET last_sent = ? WHERE chat_id = ? AND grp = ?")
          .bind(JSON.stringify(sub.lastSent), sub.chatId, sub.group),
      );
    }
  }
  await env.DB.batch(writes);
  const dates = days.map((d) => d.date).join(", ") || "no schedule";
  return `${dates}: sent ${sent}` + (postponed ? `, ${postponed} left for the next run` : "");
}
