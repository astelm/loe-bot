import { handleUpdate, runPoll, telegram, type Env, type Update } from "./bot.js";
import { runReminders } from "./reminders.js";
import { SCHEMA } from "./store.js";

// Must match the first cron in wrangler.toml.
export const POLL_CRON = "*/10 * * * *";

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

    // Called by the deploy workflow: creates tables, points Telegram at this worker.
    if (request.method === "POST" && url.pathname === "/setup") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WEBHOOK_SECRET}`) {
        return new Response("forbidden", { status: 403 });
      }
      await env.DB.exec(SCHEMA.trim());
      await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      await telegram(env, "setMyCommands", {
        commands: [
          { command: "now", description: "Поточний графік моєї групи" },
          { command: "group", description: "Змінити групу" },
          { command: "stop", description: "Вимкнути сповіщення" },
        ],
      });
      return Response.json({ ok: true, webhook: `${url.origin}/telegram` });
    }

    return new Response("loe-bot is running");
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === POLL_CRON) {
      // Every 10 minutes: check the LOE schedule and send changes.
      ctx.waitUntil(runPoll(env).then((r) => console.log(`poll: ${r}`)));
    } else {
      // Every minute: remind about outages starting soon.
      ctx.waitUntil(runReminders(env).then((r) => console.log(`reminders: ${r}`)));
    }
  },
} satisfies ExportedHandler<Env>;
