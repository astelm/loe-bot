import { handleUpdate, runPoll, telegram, type Env, type Update } from "./bot.js";
import { runReminders } from "./reminders.js";
import { MIGRATIONS, SCHEMA, type City } from "./store.js";

// Must match the crons in wrangler.toml. All three run every minute; they're
// written differently so each is its own run with its own budget of outgoing requests.
export const POLL_CRON = "*/1 * * * *";
export const KYIV_CRON = "0-59 * * * *";
// Each city is checked at the start of its minute and again this much later.
const SECOND_CHECK_MS = 30_000;

/** Two checks a minute: one now, one SECOND_CHECK_MS after the scheduled time. */
async function pollTwice(env: Env, city: City, scheduledTime: number): Promise<void> {
  console.log(`poll: ${await runPoll(env, { city })}`);
  await new Promise((r) => setTimeout(r, Math.max(0, scheduledTime + SECOND_CHECK_MS - Date.now())));
  console.log(`poll: ${await runPoll(env, { city })}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Telegram delivers every message and button press here, instantly.
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await handleUpdate(env, (await request.json()) as Update);
      } catch (err) {
        // Answer 200 anyway so Telegram doesn't redeliver the same update forever.
        console.log(`update failed: ${(err as Error).stack ?? err}`);
      }
      return new Response("ok");
    }

    const authorized = request.headers.get("Authorization") === `Bearer ${env.WEBHOOK_SECRET}`;

    // Called by the deploy workflow: creates tables, points Telegram at this worker.
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!authorized) return new Response("forbidden", { status: 403 });
      await env.DB.exec(SCHEMA.trim());
      for (const sql of MIGRATIONS) {
        await env.DB.exec(sql).catch(() => {}); // the column already exists
      }
      await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      await telegram(env, "setMyCommands", {
        commands: [
          { command: "now", description: "Поточний графік" },
          { command: "city", description: "Обрати місто" },
          { command: "group", description: "Змінити групу або адресу" },
          { command: "stop", description: "Вимкнути сповіщення" },
        ],
      });
      return Response.json({ ok: true, webhook: `${url.origin}/telegram` });
    }

    return new Response("loe-bot is running");
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === POLL_CRON) {
      // Every 30 seconds: check the Lviv schedule and send changes.
      ctx.waitUntil(pollTwice(env, "lviv", event.scheduledTime));
    } else if (event.cron === KYIV_CRON) {
      // The same for Kyiv.
      ctx.waitUntil(pollTwice(env, "kyiv", event.scheduledTime));
    } else {
      // Every minute: remind about outages starting soon.
      ctx.waitUntil(runReminders(env).then((r) => console.log(`reminders: ${r}`)));
    }
  },
} satisfies ExportedHandler<Env>;
