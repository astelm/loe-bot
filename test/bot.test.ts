import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, runPoll, SEND_LIMIT } from "../src/bot.js";
import { allSubscribers, getSubscriber } from "../src/store.js";
import { day, env, fakeTelegram, message, press } from "./helpers.js";

const today = day("17.10.2026", { "1.1": [{ from: "20:00", to: "22:00" }], "2.1": [] });
const fetchFn = async () => [today];

test("/start shows group buttons", async () => {
  const calls = fakeTelegram();
  await handleUpdate(env(), message(1, "/start"), { fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reply_markup.inline_keyboard.flat().length, 12);
});

test("picking a group subscribes and shows the schedule without an alert later", async () => {
  const e = env();
  let calls = fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn });
  assert.deepEqual((await getSubscriber(e.DB, "1"))?.lastSent, { "17.10.2026": today.groups["1.1"] });
  assert.deepEqual(calls.map((c) => c.method), ["answerCallbackQuery", "editMessageText", "sendMessage"]);
  assert.match(calls[2].text, /20:00–22:00/);

  calls = fakeTelegram();
  assert.match(await runPoll(e, { fetchFn }), /sent 0/);
  assert.equal(calls.length, 0);
});

test("poll sends new days and changes, once", async () => {
  const e = env();
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn });

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

test("/now needs a group, then answers", async () => {
  const e = env();
  let calls = fakeTelegram();
  await handleUpdate(e, message(1, "/now"), { fetchFn });
  assert.match(calls[0].text, /Спершу обери групу/);
  await handleUpdate(e, press(1, "group:2.1"), { fetchFn });
  calls = fakeTelegram();
  await handleUpdate(e, message(1, "/now@loe_bot"), { fetchFn });
  assert.match(calls[0].text, /Електроенергія є весь день/);
});

test("/stop and blocked users are removed", async () => {
  const e = env();
  fakeTelegram();
  await handleUpdate(e, press(1, "group:1.1"), { fetchFn: async () => [] });
  await handleUpdate(e, press(2, "group:1.1"), { fetchFn: async () => [] });
  await handleUpdate(e, message(1, "/stop"), { fetchFn });
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
