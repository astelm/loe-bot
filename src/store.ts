import type { DaySchedule, Interval } from "./loe.js";

export type City = "lviv" | "kyiv";
export const CITIES: City[] = ["lviv", "kyiv"];

export interface Subscriber {
  chatId: string;
  city: City;
  group: string;
  /** Kyiv only: the address the group was found by. */
  address: string | null;
  /** What we last told this user, per date: date -> intervals for their group. */
  lastSent: Record<string, Interval[]>;
}

/** The schedules from the last fetch, so commands can answer without asking again. */
export interface Latest {
  at: number;
  days: DaySchedule[];
}

/** Where a chat is in the Kyiv address dialog. */
export type Pending =
  | { step: "street" }
  | { step: "pickStreet"; options: string[] }
  | { step: "house"; street: string }
  | { step: "pickHouse"; street: string; options: string[] };

// One statement per line: /setup runs it with DB.exec.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (chat_id TEXT PRIMARY KEY, grp TEXT NOT NULL, last_sent TEXT NOT NULL DEFAULT '{}', city TEXT NOT NULL DEFAULT 'lviv', address TEXT);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS kyiv_streets (street TEXT PRIMARY KEY, houses TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL);
`;

// Columns added after the first release. /setup runs each and ignores "duplicate column".
export const MIGRATIONS = [
  "ALTER TABLE subscribers ADD COLUMN city TEXT NOT NULL DEFAULT 'lviv'",
  "ALTER TABLE subscribers ADD COLUMN address TEXT",
];

interface Row {
  chat_id: string;
  grp: string;
  last_sent: string;
  city: City;
  address: string | null;
}

const toSubscriber = (r: Row): Subscriber => ({
  chatId: r.chat_id, city: r.city, group: r.grp, address: r.address, lastSent: JSON.parse(r.last_sent),
});

export async function getSubscriber(db: D1Database, chatId: string): Promise<Subscriber | null> {
  const row = await db.prepare("SELECT * FROM subscribers WHERE chat_id = ?").bind(chatId).first<Row>();
  return row && toSubscriber(row);
}

export async function allSubscribers(db: D1Database, city?: City): Promise<Subscriber[]> {
  const stmt = city
    ? db.prepare("SELECT * FROM subscribers WHERE city = ?").bind(city)
    : db.prepare("SELECT * FROM subscribers");
  const { results } = await stmt.all<Row>();
  return results.map(toSubscriber);
}

export function saveSubscriber(db: D1Database, sub: Subscriber): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO subscribers (chat_id, grp, last_sent, city, address) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(chat_id) DO UPDATE SET grp = excluded.grp, last_sent = excluded.last_sent, " +
        "city = excluded.city, address = excluded.address",
    )
    .bind(sub.chatId, sub.group, JSON.stringify(sub.lastSent), sub.city, sub.address);
}

export function removeSubscriber(db: D1Database, chatId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM subscribers WHERE chat_id = ?").bind(chatId);
}

// Lviv keeps the key it had before Kyiv was added.
const latestKey = (city: City) => (city === "lviv" ? "latest" : `latest:${city}`);

export async function getLatest(db: D1Database, city: City): Promise<Latest | null> {
  const row = await db.prepare("SELECT value FROM state WHERE key = ?").bind(latestKey(city)).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

export function saveLatest(db: D1Database, city: City, latest: Latest): D1PreparedStatement {
  return db
    .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(latestKey(city), JSON.stringify(latest));
}

export async function getPending(db: D1Database, chatId: string): Promise<Pending | null> {
  const row = await db.prepare("SELECT data FROM pending WHERE chat_id = ?").bind(chatId).first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

export function setPending(db: D1Database, chatId: string, pending: Pending | null): D1PreparedStatement {
  return pending
    ? db.prepare("INSERT INTO pending (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data")
      .bind(chatId, JSON.stringify(pending))
    : db.prepare("DELETE FROM pending WHERE chat_id = ?").bind(chatId);
}

export async function kyivStreetNames(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT street FROM kyiv_streets").all<{ street: string }>();
  return results.map((r) => r.street);
}

/** House number -> group, as DTEK lists them for the street. */
export async function kyivHouses(db: D1Database, street: string): Promise<Record<string, string> | null> {
  const row = await db.prepare("SELECT houses FROM kyiv_streets WHERE street = ?").bind(street).first<{ houses: string }>();
  return row ? JSON.parse(row.houses) : null;
}

export function saveKyivStreet(db: D1Database, street: string, houses: Record<string, string>): D1PreparedStatement {
  return db
    .prepare("INSERT INTO kyiv_streets (street, houses) VALUES (?, ?) ON CONFLICT(street) DO UPDATE SET houses = excluded.houses")
    .bind(street, JSON.stringify(houses));
}
