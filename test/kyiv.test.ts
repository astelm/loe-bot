import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, runPoll } from "../src/bot.js";
import { runReminders } from "../src/reminders.js";
import { getPending, getSubscriber } from "../src/store.js";
import { parsePlanned, sameHouse, streetQuery, type PlannedOutages, type Yasno } from "../src/yasno.js";
import { env, fakeTelegram, message, press } from "./helpers.js";

const slot = (start: number, end: number, type = "Definite") => ({ start, end, type });
const day = (date: string, slots: { start: number; end: number; type: string }[], status = "ScheduleApplies") =>
  ({ date: `${date}T00:00:00+03:00`, status, slots });

// Shaped like the live response for 17.10.2026.
const planned = (g15: { start: number; end: number; type: string }[]): PlannedOutages => ({
  "15.1": {
    today: day("2026-10-17", [slot(0, 1140, "NotPlanned"), ...g15]),
    tomorrow: day("2026-10-18", [], "WaitingForSchedule"),
    updatedOn: "2026-10-17T08:16:49+00:00",
  },
  "19.1": { today: day("2026-10-17", [slot(0, 1440, "NotPlanned")]), updatedOn: "2026-10-17T07:00:00+00:00" },
});

test("Yasno schedule becomes intervals per day", () => {
  const [today, ...rest] = parsePlanned(planned([slot(1140, 1200), slot(1200, 1260), slot(1350, 1440)]));
  assert.equal(rest.length, 0, "tomorrow is still waiting for a schedule");
  assert.equal(today.date, "17.10.2026");
  assert.equal(today.updatedAt, "11:16 17.10.2026");
  assert.deepEqual(today.groups["15.1"], [{ from: "19:00", to: "21:00" }, { from: "22:30", to: "24:00" }]);
  assert.deepEqual(today.groups["19.1"], []);
});

test("street prefixes and house spelling", () => {
  assert.equal(streetQuery("вул. Хрещатик"), "Хрещатик");
  assert.equal(streetQuery("проспект Лесі Українки"), "Лесі Українки");
  assert.ok(sameHouse("27Б", "27 б"));
  assert.ok(sameHouse("27/Б", "27б"));
  assert.ok(!sameHouse("27", "27б"));
});

/** Fake Yasno with two streets near Хрещатик. */
function fakeYasno(schedule: () => PlannedOutages) {
  const houses: Record<number, { id: number; name: string; group: string }[]> = {
    952: [
      { id: 1, name: "25", group: "15.1" }, { id: 2, name: "27", group: "15.1" },
      { id: 3, name: "27А", group: "19.1" }, { id: 4, name: "27Б", group: "15.1" },
    ],
    953: [{ id: 5, name: "1", group: "19.1" }],
  };
  const yasno: Yasno = {
    schedules: async () => parsePlanned(schedule()),
    streets: async (q) =>
      [{ id: 952, name: "вул. Хрещатик" }, { id: 953, name: "пров. Хрещатий" }]
        .filter((s) => s.name.toLowerCase().includes(streetQuery(q).toLowerCase())),
    houses: async (streetId, q) => (houses[streetId] ?? []).filter((h) => h.name.startsWith(q)),
    group: async (streetId, houseId) => houses[streetId]?.find((h) => h.id === houseId)?.group ?? null,
  };
  return yasno;
}

const opts = (yasno: Yasno) => ({ now: Date.parse("2026-10-17T15:00:00Z"), yasno });

test("Kyiv: city, street, house, subscribed with the schedule", async () => {
  const e = env();
  const yasno = fakeYasno(() => planned([slot(1140, 1260)]));
  let calls = fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"), opts(yasno));
  assert.match(calls.at(-1)!.text, /Напиши назву вулиці/);

  calls = fakeTelegram();
  await handleUpdate(e, message(1, "хрещат"), opts(yasno));
  assert.deepEqual(calls[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text), ["вул. Хрещатик", "пров. Хрещатий"]);

  calls = fakeTelegram();
  await handleUpdate(e, press(1, "street:0"), opts(yasno));
  assert.match(calls.at(-1)!.text, /вул. Хрещатик\nНапиши номер будинку/);

  calls = fakeTelegram();
  await handleUpdate(e, message(1, "27 б"), opts(yasno));
  const sub = await getSubscriber(e.DB, "1");
  assert.deepEqual([sub?.city, sub?.group, sub?.address], ["kyiv", "15.1", "вул. Хрещатик, 27Б"]);
  assert.equal(await getPending(e.DB, "1"), null);
  assert.match(calls[0].text, /вул. Хрещатик, 27Б — черга <b>15.1<\/b> збережено/);
  assert.match(calls[1].text, /черга <b>15.1<\/b>\n🔴 19:00–21:00/);
});

test("Kyiv: house options and unknown street", async () => {
  const e = env();
  const yasno = fakeYasno(() => planned([]));
  fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"), opts(yasno));
  let calls = fakeTelegram();
  await handleUpdate(e, message(1, "Майдан Незалежності"), opts(yasno));
  assert.match(calls[0].text, /Не знайшов такої вулиці/);
  await handleUpdate(e, message(1, "вул. Хрещатик"), opts(yasno));
  calls = fakeTelegram();
  await handleUpdate(e, message(1, "27 в"), opts(yasno));
  assert.deepEqual(calls[0].reply_markup.inline_keyboard.flat().map((b: any) => b.text), ["27", "27А", "27Б"]);
  await handleUpdate(e, press(1, "house:1"), opts(yasno));
  const sub = await getSubscriber(e.DB, "1");
  assert.deepEqual([sub?.group, sub?.address], ["19.1", "вул. Хрещатик, 27А"]);
});

test("Kyiv: changes reach Kyiv subscribers only, reminders say черга", async () => {
  const e = env();
  let schedule = planned([slot(1140, 1260)]);
  const yasno = fakeYasno(() => schedule);
  fakeTelegram();
  await handleUpdate(e, press(1, "city:kyiv"), opts(yasno));
  await handleUpdate(e, message(1, "Хрещатик"), opts(yasno));
  await handleUpdate(e, message(1, "25"), opts(yasno));
  await handleUpdate(e, press(2, "group:1.1"), { fetchFn: async () => [] });

  schedule = planned([slot(1140, 1320)]);
  let calls = fakeTelegram();
  await runPoll(e, { city: "kyiv", yasno });
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
