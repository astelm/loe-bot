import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, runPoll, SEND_LIMIT } from "../src/bot.js";
import { allSubscribers, getSubscriber } from "../src/store.js";
import { day, env, fakeTelegram, message, press } from "./helpers.js";

const today = day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }], "2.1": [] });
const fetchFn = async () => [today];
// Noon in Kyiv on the day above.
const now = Date.parse("2026-10-17T12:00:00+03:00");

test("/start asks for the city, Lviv then shows group buttons", async () => {
  const e = env();
  let calls = fakeTelegram();
  await handleUpdate(e, message(1, "/start"), { fetchFn, now });
  assert.deepEqual(calls[0].reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ["city:lviv", "city:kyiv"]);
  calls = fakeTelegram();
  await handleUpdate(e, press(1, "city:lviv"), { fetchFn, now });
  assert.equal(calls.at(-1)!.reply_markup.inline_keyboard.flat().length, 12);
});

test("picking a group subscribes and shows the schedule without an alert later", async () => {
  const e = env();
  let calls = fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn, now });
  const sub = await getSubscriber(e.DB, "1");
  assert.equal(sub?.city, "lviv");
  assert.deepEqual(sub?.lastSent, { "17.10.2026": today.groups["1.1"] });
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.text);
  assert.match(texts[0], /Групу <b>1.1<\/b> збережено/);
  assert.match(texts[1], /20:00–22:00/);

  calls = fakeTelegram();
  assert.match(await runPoll(e, { fetchFn }), /sent 0/);
  assert.equal(calls.length, 0);
});

test("poll sends new days and changes, once", async () => {
  const e = env();
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn, now });

  const changed = day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }, { from: "23:00", to: "24:00" }] });
  const tomorrow = day("18.10.2026", { "1.1": [] });
  let calls = fakeTelegram();
  await runPoll(e, { fetchFn: async () => [changed, tomorrow] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /Графік змінено/);
  assert.match(calls[0].text, /Додано: 23:00–24:00/);
  assert.match(calls[1].text, /Новий графік/);

  calls = fakeTelegram();
  await runPoll(e, { fetchFn: async () => [changed, tomorrow] });
  assert.equal(calls.length, 0);
});

test("/now needs a city, then answers", async () => {
  const e = env();
  let calls = fakeTelegram();
  await handleUpdate(e, message(1, "/now"), { fetchFn, now });
  assert.match(calls[0].text, /Спершу обери місто/);
  await handleUpdate(e, press(1, "group:2.1"), { fetchFn, now });
  calls = fakeTelegram();
  await handleUpdate(e, message(1, "/now@loe_bot"), { fetchFn, now });
  assert.match(calls[0].text, /Електроенергія є весь день/);
});

test("/now without today's schedule says there are no outages today, and shows tomorrow", async () => {
  const e = env();
  const tomorrow = day("18.10.2026", { "1.1": [{ from: "08:00", to: "10:00" }] });
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn, now });
  // The next day, only yesterday's schedule and tomorrow's are known.
  let calls = fakeTelegram();
  const later = now + 24 * 3600_000;
  await handleUpdate(e, message(1, "/now"), { now: later, fetchFn: async () => [today] });
  assert.equal(calls[0].text, "Сьогодні вимкнень електроенергії не заплановано");
  calls = fakeTelegram();
  await handleUpdate(e, message(1, "/now"), { now: later + 3600_000, fetchFn: async () => [day("18.10.2026", { "2.1": [] })] });
  assert.match(calls[0].text, /^Сьогодні вимкнень електроенергії не заплановано$/);
  // A fresh chat on the 17th, when only tomorrow's schedule is out.
  const e2 = env();
  fakeTelegram();
  await handleUpdate(e2, press(1, "group:1.1"), { now, fetchFn: async () => [tomorrow] });
  calls = fakeTelegram();
  await handleUpdate(e2, message(1, "/now"), { now, fetchFn: async () => [tomorrow] });
  assert.match(calls[0].text, /^Сьогодні вимкнень електроенергії не заплановано\n\n📅 <b>18.10.2026<\/b>[\s\S]*08:00–10:00/);
});

test("/stop and blocked users are removed", async () => {
  const e = env();
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn: async () => [] });
  await handleUpdate(e, press(2, "group:1.1"), { fetchFn: async () => [] });
  await handleUpdate(e, message(1, "/stop"), { fetchFn, now });
  fakeTelegram({ blocked: ["2"] });
  await runPoll(e, { fetchFn, now: Date.now() + 3_600_000 });
  assert.deepEqual(await allSubscribers(e.DB), []);
});

test("sends at most SEND_LIMIT messages per run, the rest next run", async () => {
  const e = env();
  fakeTelegram();
  for (let i = 1; i <= SEND_LIMIT + 5; i++) await handleUpdate(e, press(i, "group:1.1"), { fetchFn: async () => [] });
  let calls = fakeTelegram();
  assert.match(await runPoll(e, { fetchFn }), /5 left/);
  assert.equal(calls.length, SEND_LIMIT);
  calls = fakeTelegram();
  await runPoll(e, { fetchFn });
  assert.equal(calls.length, 5);
});

test("failed fetch changes nothing", async () => {
  const e = env();
  const calls = fakeTelegram();
  assert.match(await runPoll(e, { fetchFn: async () => { throw new Error("LOE API responded 502"); } }), /fetch failed/);
  assert.equal(calls.length, 0);
});
