import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DaySchedule } from "../src/loe.js";
import type { Env, Update } from "../src/bot.js";
import { SCHEMA } from "../src/store.js";

/** Minimal D1 API over node:sqlite. */
export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...p: SQLInputValue[]) => statement(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => db.exec(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

export interface Call { method: string; [key: string]: any }

/** Replaces global fetch with a fake Telegram API. Returns the list of calls. */
export function fakeTelegram({ blocked = [] as string[] } = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const params = JSON.parse(init.body as string);
    calls.push({ method, ...params });
    if (method === "sendMessage" && blocked.includes(String(params.chat_id))) {
      return Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return calls;
}

export const env = (): Env => ({ DB: fakeD1(), TELEGRAM_BOT_TOKEN: "t", WEBHOOK_SECRET: "s" });

export const message = (chatId: number, text: string): Update => ({ message: { chat: { id: chatId }, text } });
export const press = (chatId: number, data: string): Update => ({
  callback_query: { id: "q", data, message: { message_id: 7, chat: { id: chatId } } },
});

export const day = (date: string, groups: DaySchedule["groups"]): DaySchedule => ({ date, updatedAt: null, groups });
