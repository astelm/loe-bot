import type { DaySchedule, Interval } from "./loe.js";

export interface Subscriber {
  chatId: string;
  group: string;
  /** What we last told this user, per date: date -> intervals for their group. */
  lastSent: Record<string, Interval[]>;
}

/** The schedules from the last fetch, so commands can answer without asking LOE again. */
export interface Latest {
  at: number;
  days: DaySchedule[];
}

// One statement per line: /setup runs it with DB.exec.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (chat_id TEXT PRIMARY KEY, grp TEXT NOT NULL, last_sent TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`;

interface Row {
  chat_id: string;
  grp: string;
  last_sent: string;
}

const toSubscriber = (r: Row): Subscriber => ({ chatId: r.chat_id, group: r.grp, lastSent: JSON.parse(r.last_sent) });

export async function getSubscriber(db: D1Database, chatId: string): Promise<Subscriber | null> {
  const row = await db.prepare("SELECT * FROM subscribers WHERE chat_id = ?").bind(chatId).first<Row>();
  return row && toSubscriber(row);
}

export async function allSubscribers(db: D1Database): Promise<Subscriber[]> {
  const { results } = await db.prepare("SELECT * FROM subscribers").all<Row>();
  return results.map(toSubscriber);
}

export function saveSubscriber(db: D1Database, sub: Subscriber): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO subscribers (chat_id, grp, last_sent) VALUES (?, ?, ?) " +
        "ON CONFLICT(chat_id) DO UPDATE SET grp = excluded.grp, last_sent = excluded.last_sent",
    )
    .bind(sub.chatId, sub.group, JSON.stringify(sub.lastSent));
}

export function removeSubscriber(db: D1Database, chatId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM subscribers WHERE chat_id = ?").bind(chatId);
}

export async function getLatest(db: D1Database): Promise<Latest | null> {
  const row = await db.prepare("SELECT value FROM state WHERE key = 'latest'").first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

export function saveLatest(db: D1Database, latest: Latest): D1PreparedStatement {
  return db
    .prepare("INSERT INTO state (key, value) VALUES ('latest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(latest));
}
