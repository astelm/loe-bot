import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, ingestKyiv } from "../src/bot.js";
import { findHouse, parseFact, searchStreets, type DtekFact } from "../src/dtek.js";
import { runReminders } from "../src/reminders.js";
import { getPending, getSubscriber, saveKyivStreet } from "../src/store.js";
import { env, fakeTelegram, message, press } from "./helpers.js";

const hours = (off: Record<number, string>) =>
  Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), off[i + 1] ?? "yes"]));

// 1792184400 is 17.10.2026 00:00 in Kyiv, as on the live site.
const fact = (g15: Record<number, string>): DtekFact => ({
  data: { "1792184400": { "GPV15.1": hours(g15), "GPV19.1": hours({}) } },
  update: "16.10.2026 23:40",
});

test("DTEK fact becomes intervals, with half hours", () => {
  const [day] = parseFact(fact({ 20: "no", 21: "no", 22: "no", 23: "first", 8: "second", 10: "maybe" }), "20:16 17.10.2026");
  assert.equal(day.date, "17.10.2026");
  assert.equal(day.updatedAt, "20:16 17.10.2026");
  assert.deepEqual(day.groups["15.1"], [{ from: "07:30", to: "08:00" }, { from: "19:00", to: "22:30" }]);
  assert.deepEqual(day.groups["19.1"], []);
  const [late] = parseFact(fact({ 23: "second", 24: "no" }));
  assert.deepEqual(late.groups["15.1"], [{ from: "22:30", to: "24:00" }]);
});

test("street search and house matching", () => {
  const names = ["вул. Хрещатик", "пров. Хрещатий", "просп. Курбаса Леся", "вул. Садова 3", "вул. Садова 30"];
  assert.deepEqual(searchStreets(names, "хрещатик"), ["вул. Хрещатик"]);
  assert.deepEqual(searchStreets(names, "вул. Леся Курбаса"), ["просп. Курбаса Леся"]);
  assert.deepEqual(searchStreets(names, "садова 3"), ["вул. Садова 3", "вул. Садова 30"]);
  const houses = { "27": "15.1", "27/Б": "15.1", "10,12": "20.1", "4": "20.1" };
  assert.deepEqual(findHouse(houses, "27 б"), { exact: "27/Б" });
  assert.deepEqual(findHouse(houses, "10"), { options: ["10,12"] });
  assert.deepEqual(findHouse(houses, "99"), { options: [] });
});

async function kyivEnv() {
  const e = env();
  await saveKyivStreet(e.DB, "вул. Хрещатик", { "25": "15.1", "27": "15.1", "27/Б": "15.1", "17": "19.1" }).run();
  await saveKyivStreet(e.DB, "пров. Хрещатий", { "1": "19.1" }).run();
  fakeTelegram();
  await ingestKyiv(e, { fact: fact({ 20: "no", 21: "no" }), updateTimestamp: "20:16 17.10.2026" });
  return e;
}

test("Kyiv: city, street, house, subscribed with the schedule", async () => {
  const e = await kyivEnv();
  let calls = fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"));
  assert.match(calls.at(-1)!.text, /Напиши назву вулиці/);

  calls = fakeTelegram();
  await handleUpdate(e, message(1, "хрещат"));
  assert.deepEqual(calls[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text), ["вул. Хрещатик", "пров. Хрещатий"]);

  calls = fakeTelegram();
  await handleUpdate(e, press(1, "street:0"));
  assert.match(calls.at(-1)!.text, /вул. Хрещатик\nНапиши номер будинку/);

  calls = fakeTelegram();
  await handleUpdate(e, message(1, "27б"));
  const sub = await getSubscriber(e.DB, "1");
  assert.deepEqual([sub?.city, sub?.group, sub?.address], ["kyiv", "15.1", "вул. Хрещатик, 27/Б"]);
  assert.equal(await getPending(e.DB, "1"), null);
  assert.match(calls[0].text, /вул. Хрещатик, 27\/Б — черга <b>15.1<\/b> збережено/);
  assert.match(calls[1].text, /черга <b>15.1<\/b>\n🔴 19:00–21:00/);
});

test("Kyiv: house options and unknown street", async () => {
  const e = await kyivEnv();
  fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"));
  let calls = fakeTelegram();
  await handleUpdate(e, message(1, "Майдан Незалежності"));
  assert.match(calls[0].text, /Не знайшов такої вулиці/);
  await handleUpdate(e, message(1, "Хрещатик"));
  calls = fakeTelegram();
  await handleUpdate(e, message(1, "27 а"));
  assert.deepEqual(calls[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text), ["27", "27/Б"]);
  await handleUpdate(e, press(1, "house:0"));
  assert.equal((await getSubscriber(e.DB, "1"))?.address, "вул. Хрещатик, 27");
});

test("Kyiv: changes from GitHub reach Kyiv subscribers only, reminders say черга", async () => {
  const e = await kyivEnv();
  fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"));
  await handleUpdate(e, message(1, "вул. Хрещатик"));
  await handleUpdate(e, message(1, "25"));
  await handleUpdate(e, press(2, "group:1.1"), { fetchFn: async () => [] });

  let calls = fakeTelegram();
  await ingestKyiv(e, { fact: fact({ 20: "no", 21: "no", 22: "no" }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat_id, "1");
  assert.match(calls[0].text, /Графік змінено[\s\S]*Додано: 19:00–22:00/);

  fakeTelegram();
  await runReminders(e, { now: new Date("2026-10-17T18:40:00+03:00") });
  calls = fakeTelegram();
  await runReminders(e, { now: new Date("2026-10-17T18:45:00+03:00") });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Через 15 хв вимкнуть світло — черга <b>15.1<\/b>\n🔴 19:00–22:00/);
});
