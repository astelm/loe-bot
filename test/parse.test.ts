import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSchedules, parseSchedule } from "../src/loe.js";
import { diff, totalMinutes, formatDuration } from "../src/schedule.js";

const sample = `<p><b>Графік погодинних відключень на 17.10.2026</b></p>
<p>Інформація станом на 10:04 17.10.2026</p>
<p>Група 1.1. Електроенергії немає з 20:00 до 22:00.</p>
<p>Група 1.2. Електроенергії немає з 00:00 до 02:30, з 22:00 до 24:00.</p>
<p>Група 2.1. Електроенергія є.</p>
<p>Група 6.2. Електроенергії немає з 18:00 до 20:00.</p>`;

test("parses date, update time and groups", () => {
  const s = parseSchedule(sample)!;
  assert.equal(s.date, "17.10.2026");
  assert.equal(s.updatedAt, "10:04 17.10.2026");
  assert.deepEqual(s.groups["1.1"], [{ from: "20:00", to: "22:00" }]);
  assert.deepEqual(s.groups["1.2"], [{ from: "00:00", to: "02:30" }, { from: "22:00", to: "24:00" }]);
  assert.deepEqual(s.groups["2.1"], []);
  assert.equal(Object.keys(s.groups).length, 4);
});

test("non-schedule html returns null", () => {
  assert.equal(parseSchedule("<p>Архів</p>"), null);
});

test("hours and diff", () => {
  const s = parseSchedule(sample)!;
  assert.equal(totalMinutes(s.groups["1.2"]), 270);
  assert.equal(formatDuration(270), "4 год 30 хв");
  const d = diff([{ from: "20:00", to: "22:00" }], [{ from: "20:00", to: "22:00" }, { from: "23:00", to: "00:00" }]);
  assert.deepEqual(d.added, [{ from: "23:00", to: "00:00" }]);
  assert.equal(d.afterMinutes - d.beforeMinutes, 60);
});

test("an LOE answer without any schedule counts as a failed fetch", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ "hydra:member": [{ menuItems: [{ name: "Today", rawHtml: "" }] }] })) as typeof fetch;
  try {
    await assert.rejects(fetchSchedules(), /no schedule in LOE response/);
  } finally {
    globalThis.fetch = saved;
  }
});
