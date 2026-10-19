import { fetchSchedules, GROUPS, toSortable, type DaySchedule, type Interval } from "./loe.js";
import { diff, fmtInterval, formatDuration, formatList, kyivMinutes, sameIntervals, totalMinutes } from "./schedule.js";
import {
  allSubscribers, getLatest, getPending, getSubscriber, removeSubscriber, saveLatest, saveSubscriber, setPending,
  type City, type Pending, type Subscriber,
} from "./store.js";
import { liveYasno, sameHouse, type Option, type Yasno } from "./yasno.js";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

export type FetchSchedules = () => Promise<DaySchedule[]>;

// Free Workers plan allows 50 outgoing requests per run; one goes to LOE or Yasno.
// Messages over this limit are sent on the next run.
export const SEND_LIMIT = 45;
// Commands reuse schedules fetched this recently instead of asking LOE or Yasno again.
const FRESH_MS = 10 * 60_000;
// Most street or house buttons shown at once.
const MAX_OPTIONS = 8;

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

const CITY_NAMES: Record<City, string> = { lviv: "Львів", kyiv: "Київ" };
/** LOE calls them groups, Yasno calls them queues. */
export const groupWord = (city: City) => (city === "kyiv" ? "черга" : "група");

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function cityKeyboard(current?: City) {
  return {
    inline_keyboard: [
      (Object.keys(CITY_NAMES) as City[]).map((c) => ({
        text: c === current ? `• ${CITY_NAMES[c]} •` : CITY_NAMES[c], callback_data: `city:${c}`,
      })),
    ],
  };
}

export function groupKeyboard(current?: string) {
  const buttons = GROUPS.map((g) => ({ text: g === current ? `• ${g} •` : g, callback_data: `group:${g}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { inline_keyboard: rows };
}

const optionsKeyboard = (prefix: string, options: Option[]) => ({
  inline_keyboard: options.map((o, i) => [{ text: o.name, callback_data: `${prefix}:${i}` }]),
});

function renderDay(day: DaySchedule, group: string, city: City): string {
  const intervals = day.groups[group];
  const word = groupWord(city);
  if (!intervals) return `📅 <b>${day.date}</b>\n${word[0].toUpperCase() + word.slice(1)} ${group} немає в графіку.`;
  const total = totalMinutes(intervals);
  return [
    `📅 <b>${day.date}</b> — ${word} <b>${group}</b>`,
    formatList(intervals),
    `⏱ Всього без світла: <b>${formatDuration(total)}</b> · зі світлом: ${formatDuration(24 * 60 - total)}`,
    day.updatedAt ? `<i>Станом на ${day.updatedAt}</i>` : "",
  ].filter(Boolean).join("\n");
}

export const NO_OUTAGES_TODAY = "Сьогодні вимкнень електроенергії не заплановано";

/** "DD.MM.YYYY" in Kyiv at the given moment. */
export function kyivDate(now: number): string {
  const d = new Date(kyivMinutes(new Date(now)) * 60_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

/** Today's and later schedules for the group. Without one for today, says there are no outages today. */
export function renderAll(days: DaySchedule[], group: string, city: City, now: number): string {
  const today = toSortable(kyivDate(now));
  const hasToday = days.some((d) => toSortable(d.date) === today && d.groups[group]);
  // Older days are gone; so is today if this group isn't in its schedule.
  days = days.filter((d) => toSortable(d.date) > today || (hasToday && toSortable(d.date) === today));
  const parts = days.map((d) => renderDay(d, group, city));
  if (!hasToday) parts.unshift(NO_OUTAGES_TODAY);
  if (days.length > 1) {
    const sum = days.reduce((s, d) => s + totalMinutes(d.groups[group] ?? []), 0);
    parts.push(`📊 Разом за ${days.length} дн.: <b>${formatDuration(sum)}</b> без світла`);
  }
  return parts.join("\n\n");
}

export function renderChange(day: DaySchedule, group: string, before: Interval[] | undefined, city: City = "lviv"): string {
  const after = day.groups[group] ?? [];
  if (before === undefined) {
    return `🆕 <b>Новий графік</b>\n\n${renderDay(day, group, city)}`;
  }
  const d = diff(before, after);
  const delta = d.afterMinutes - d.beforeMinutes;
  const lines = [`⚠️ <b>Графік змінено</b>`, "", renderDay(day, group, city), ""];
  if (d.removed.length) lines.push(`➖ Скасовано: ${d.removed.map(fmtInterval).join(", ")}`);
  if (d.added.length) lines.push(`➕ Додано: ${d.added.map(fmtInterval).join(", ")}`);
  lines.push(
    `⏱ Було: ${formatDuration(d.beforeMinutes)} → стало: <b>${formatDuration(d.afterMinutes)}</b>` +
      (delta ? ` (${delta > 0 ? "+" : ""}${formatDuration(delta)})` : ""),
  );
  return lines.join("\n");
}

// ---------- Commands ----------

interface Ctx { env: Env; chatId: string; now: number; fetchFn: FetchSchedules; yasno: Yasno }

/** Schedules from the last few minutes, or freshly fetched. */
async function currentSchedules({ env, now, fetchFn, yasno }: Ctx, city: City): Promise<DaySchedule[]> {
  const latest = await getLatest(env.DB, city);
  if (latest && now - latest.at < FRESH_MS) return latest.days;
  try {
    const days = await (city === "kyiv" ? yasno.schedules() : fetchFn());
    await saveLatest(env.DB, city, { at: now, days }).run();
    return days;
  } catch (err) {
    console.log(`fetch failed: ${(err as Error).message}`);
    return latest?.days ?? [];
  }
}

async function subscribe(ctx: Ctx, city: City, group: string, address: string | null): Promise<void> {
  const days = await currentSchedules(ctx, city);
  // Remember what we're showing now, so only later changes trigger alerts.
  const lastSent: Record<string, Interval[]> = {};
  for (const d of days) if (d.groups[group]) lastSent[d.date] = d.groups[group];
  await ctx.env.DB.batch([
    saveSubscriber(ctx.env.DB, { chatId: ctx.chatId, city, group, address, lastSent }),
    setPending(ctx.env.DB, ctx.chatId, null),
  ]);
  const what = address ? `${escape(address)} — ${groupWord(city)} <b>${group}</b>` : `Групу <b>${group}</b>`;
  await send(ctx.env, ctx.chatId, `✅ ${what} збережено. Повідомлю, щойно графік зміниться, і нагадаю перед відключенням.`);
  await send(ctx.env, ctx.chatId, renderAll(days, group, city, ctx.now));
}

async function askStreet(ctx: Ctx, text = "Напиши назву вулиці в Києві, наприклад: <i>Хрещатик</i>") {
  await setPending(ctx.env.DB, ctx.chatId, { step: "street" }).run();
  await send(ctx.env, ctx.chatId, text);
}

async function chooseStreet(ctx: Ctx, street: Option) {
  await setPending(ctx.env.DB, ctx.chatId, { step: "house", street }).run();
  await send(ctx.env, ctx.chatId, `📍 ${escape(street.name)}\nНапиши номер будинку, наприклад: <i>27</i> або <i>27б</i>`);
}

async function chooseHouse(ctx: Ctx, street: Option, house: Option) {
  const group = await ctx.yasno.group(street.id, house.id);
  if (!group) {
    return void (await send(ctx.env, ctx.chatId, `Yasno не знає черги для ${escape(street.name)}, ${escape(house.name)}. Спробуй інший номер або /city.`));
  }
  await subscribe(ctx, "kyiv", group, `${street.name}, ${house.name}`);
}

/** Text typed during the Kyiv address dialog. */
async function handleAddressText(ctx: Ctx, pending: Pending, text: string) {
  if (pending.step === "street" || pending.step === "pickStreet") {
    const found = await ctx.yasno.streets(text);
    if (!found.length) return void (await send(ctx.env, ctx.chatId, "Не знайшов такої вулиці. Спробуй інакше, без «вул.», наприклад: <i>Хрещатик</i>"));
    if (found.length === 1) return chooseStreet(ctx, found[0]);
    const options = found.slice(0, MAX_OPTIONS);
    await setPending(ctx.env.DB, ctx.chatId, { step: "pickStreet", options }).run();
    const more = found.length > MAX_OPTIONS ? `\nЗнайшов ${found.length}, показую перші ${MAX_OPTIONS}. Можеш уточнити назву.` : "";
    return void (await send(ctx.env, ctx.chatId, `Обери вулицю:${more}`, { reply_markup: optionsKeyboard("street", options) }));
  }
  const { street } = pending;
  // Search by the number, then match the letter or fraction here: "27 б" finds "27Б".
  const found = await ctx.yasno.houses(street.id, text.match(/\d+/)?.[0] ?? text);
  const exact = found.find((h) => sameHouse(h.name, text));
  if (exact) return chooseHouse(ctx, street, exact);
  if (!found.length) {
    return void (await send(ctx.env, ctx.chatId, `Не знайшов будинок «${escape(text)}» на ${escape(street.name)}. Спробуй ще раз або /city, щоб почати спочатку.`));
  }
  const options = found.slice(0, MAX_OPTIONS);
  await setPending(ctx.env.DB, ctx.chatId, { step: "pickHouse", street, options }).run();
  await send(ctx.env, ctx.chatId, "Обери будинок:", { reply_markup: optionsKeyboard("house", options) });
}

async function handleCallback(ctx: Ctx, query: NonNullable<Update["callback_query"]>) {
  const [kind, value] = (query.data ?? "").split(":");
  await telegram(ctx.env, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  const msg = query.message;
  // Remove the buttons that were just used, so old ones can't be pressed again.
  if (msg) {
    await telegram(ctx.env, "editMessageReplyMarkup", { chat_id: ctx.chatId, message_id: msg.message_id })
      .catch(() => {});
  }

  if (kind === "city" && value === "lviv") {
    await setPending(ctx.env.DB, ctx.chatId, null).run();
    const sub = await getSubscriber(ctx.env.DB, ctx.chatId);
    await send(ctx.env, ctx.chatId, "Львів (poweron.loe.lviv.ua). Обери свою групу:", {
      reply_markup: groupKeyboard(sub?.city === "lviv" ? sub.group : undefined),
    });
  } else if (kind === "city" && value === "kyiv") {
    await askStreet(ctx, "Київ (Yasno). Черга залежить від адреси.\nНапиши назву вулиці, наприклад: <i>Хрещатик</i>");
  } else if (kind === "group" && (GROUPS as readonly string[]).includes(value)) {
    await subscribe(ctx, "lviv", value, null);
  } else if (kind === "street" || kind === "house") {
    const pending = await getPending(ctx.env.DB, ctx.chatId);
    const i = Number(value);
    if (kind === "street" && pending?.step === "pickStreet" && pending.options[i]) {
      await chooseStreet(ctx, pending.options[i]);
    } else if (kind === "house" && pending?.step === "pickHouse" && pending.options[i]) {
      await chooseHouse(ctx, pending.street, pending.options[i]);
    }
  }
}

export async function handleUpdate(
  env: Env,
  update: Update,
  { now = Date.now(), fetchFn = fetchSchedules as FetchSchedules, yasno = liveYasno } = {},
): Promise<void> {
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  if (!chat) return;
  const ctx: Ctx = { env, chatId: String(chat.id), now, fetchFn, yasno };
  if (update.callback_query) return handleCallback(ctx, update.callback_query);

  const text = update.message?.text?.trim();
  if (!text) return;
  if (!text.startsWith("/")) {
    const pending = await getPending(env.DB, ctx.chatId);
    if (pending) await handleAddressText(ctx, pending, text);
    return;
  }

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const sub = await getSubscriber(env.DB, ctx.chatId);
  if (command === "/start" || command === "/city") {
    const intro = command === "/start"
      ? "Привіт! Я надсилаю графіки відключень світла, повідомляю про зміни і нагадую за 15 хвилин до відключення.\n\n"
      : "";
    await send(env, ctx.chatId, `${intro}Обери місто:`, { reply_markup: cityKeyboard(sub?.city) });
  } else if (command === "/group") {
    if (sub?.city === "kyiv") return askStreet(ctx);
    await send(env, ctx.chatId, "Обери групу:", { reply_markup: groupKeyboard(sub?.group) });
  } else if (command === "/now") {
    if (!sub) return void (await send(env, ctx.chatId, "Спершу обери місто: /city"));
    const where = sub.address ? `📍 ${escape(sub.address)}\n\n` : "";
    await send(env, ctx.chatId, where + renderAll(await currentSchedules(ctx, sub.city), sub.group, sub.city, ctx.now));
  } else if (command === "/stop") {
    await env.DB.batch([removeSubscriber(env.DB, ctx.chatId), setPending(env.DB, ctx.chatId, null)]);
    await send(env, ctx.chatId, "Сповіщення вимкнено. /start — щоб увімкнути знову.");
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

/** Saves the new schedules for a city and tells each of its subscribers about changes for their group. */
export async function notifyChanges(env: Env, city: City, days: DaySchedule[], now: number): Promise<string> {
  const writes = [saveLatest(env.DB, city, { at: now, days })];
  const known = new Set(days.map((d) => d.date));
  let sent = 0;
  let postponed = 0;
  for (const sub of await allSubscribers(env.DB, city)) {
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
        await send(env, sub.chatId, renderChange(day, sub.group, before, city));
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
      // Only if they haven't switched city or group meanwhile.
      writes.push(
        env.DB.prepare("UPDATE subscribers SET last_sent = ? WHERE chat_id = ? AND grp = ? AND city = ?")
          .bind(JSON.stringify(sub.lastSent), sub.chatId, sub.group, city),
      );
    }
  }
  await env.DB.batch(writes);
  const dates = days.map((d) => d.date).join(", ") || "no schedule";
  return `${city} ${dates}: sent ${sent}` + (postponed ? `, ${postponed} left for the next run` : "");
}

/** Called every 10 minutes for each city: fetches its schedule and sends changes. */
export async function runPoll(
  env: Env,
  { city = "lviv" as City, now = Date.now(), fetchFn = fetchSchedules as FetchSchedules, yasno = liveYasno } = {},
): Promise<string> {
  let days: DaySchedule[];
  try {
    days = await (city === "kyiv" ? yasno.schedules() : fetchFn());
  } catch (err) {
    return `${city} fetch failed: ${(err as Error).message}`; // subscribers keep the previous state
  }
  return notifyChanges(env, city, days, now);
}
