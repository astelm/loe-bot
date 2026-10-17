import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate } from "../src/bot.js";
import { outages, runReminders } from "../src/reminders.js";
import { kyivMinutes } from "../src/schedule.js";
import { saveLatest } from "../src/store.js";
import { day, env, fakeTelegram, press } from "./helpers.js";

// 17.10.2026 is summer time in Kyiv (UTC+3).
const kyiv = (hhmm: string, date = "2026-10-17") => new Date(`${date}T${hhmm}:00+03:00`);

test("kyivMinutes matches schedule times", () => {
  const [o] = outages([day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }] })]);
  assert.equal(o.start, kyivMinutes(kyiv("20:00")));
  assert.equal(o.end - o.start, 120);
});

test("back-to-back intervals, also across midnight, are one outage", () => {
  const list = outages([
    day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }, { from: "22:00", to: "24:00" }] }),
    day("18.10.2026", { "1.1": [{ from: "00:00", to: "02:00" }, { from: "10:00", to: "12:00" }] }),
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].end - list[0].start, 6 * 60);
});

async function setup() {
  const e = env();
  const days = [day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }], "2.1": [{ from: "20:00", to: "21:00" }] })];
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn: async () => days });
  await handleUpdate(e, press(2, "group:3.1"), { fetchFn: async () => days });
  await saveLatest(e.DB, { at: Date.now(), days }).run();
  return e;
}

test("reminds the group 15 minutes before, once", async () => {
  const e = await setup();
  let calls = fakeTelegram();
  await runReminders(e, { now: kyiv("19:44") });
  assert.equal(calls.length, 0);

  calls = fakeTelegram();
  await runReminders(e, { now: kyiv("19:45") });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat_id, "1");
  assert.match(calls[0].text, /Через 15 хв/);
  assert.match(calls[0].text, /20:00–22:00 \(2 год\)/);

  calls = fakeTelegram();
  await runReminders(e, { now: kyiv("19:46") });
  await runReminders(e, { now: kyiv("19:50") });
  assert.equal(calls.length, 0);
});

test("a skipped minute is caught up, an outage already started is not", async () => {
  const e = await setup();
  fakeTelegram();
  await runReminders(e, { now: kyiv("19:40") });
  let calls = fakeTelegram();
  await runReminders(e, { now: kyiv("19:47") }); // cron missed 19:41–19:46
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Через 13 хв/);

  const late = await setup();
  fakeTelegram();
  await runReminders(late, { now: kyiv("19:00") });
  calls = fakeTelegram();
  await runReminders(late, { now: kyiv("20:30") }); // down for an hour and a half
  assert.equal(calls.length, 0);
});

test("power-on message at the end, with the next outage", async () => {
  const e = await setup();
  await saveLatest(e.DB, { at: Date.now(), days: [day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }, { from: "23:00", to: "24:00" }] })] }).run();
  fakeTelegram();
  await runReminders(e, { now: kyiv("21:59") });
  let calls = fakeTelegram();
  await runReminders(e, { now: kyiv("22:00") });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /світло вже є/);
  assert.match(calls[0].text, /20:00–22:00 закінчилося/);
  assert.match(calls[0].text, /Наступне: 🔴 23:00–00:00/);
  calls = fakeTelegram();
  await runReminders(e, { now: kyiv("22:01") });
  assert.equal(calls.length, 0);
});

test("power-on follows an updated end time", async () => {
  const e = await setup();
  const extended = [day("17.10.2026", { "1.1": [{ from: "20:00", to: "23:00" }] })];
  await saveLatest(e.DB, { at: Date.now(), days: extended }).run();
  let calls = fakeTelegram();
  await runReminders(e, { now: kyiv("22:00") }); // old end: nothing
  assert.equal(calls.length, 0);
  await runReminders(e, { now: kyiv("23:00") });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /20:00–23:00/);

  // Cut short, but published after the new end.
  const e2 = await setup();
  fakeTelegram();
  await runReminders(e2, { now: kyiv("21:05") });
  await saveLatest(e2.DB, { at: Date.now(), days: [day("17.10.2026", { "1.1": [{ from: "20:00", to: "21:00" }] })] }).run();
  calls = fakeTelegram();
  await runReminders(e2, { now: kyiv("21:06") });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /20:00–21:00 закінчилося/);
});
