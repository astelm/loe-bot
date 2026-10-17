# LOE outage bot

A Telegram bot that watches the Lvivoblenergo outage schedule (the JSON feed behind
[poweron.loe.lviv.ua](https://poweron.loe.lviv.ua/)) every 10 minutes and messages each
subscriber about **their group**:

- 🆕 a new day's schedule (e.g. tomorrow's is published)
- ⚠️ a change: what was added or cancelled, hours without power before → after, and the difference
- ⏰ a reminder 15 minutes before each outage
- 💡 a message when power is back, at the end time from the newest schedule

Between 00:00 and 06:00 Kyiv time these messages arrive without sound (`QUIET_HOURS` in `src/schedule.ts`).

It runs on Cloudflare Workers' free plan, so commands are answered instantly.

## Bot commands

- `/start`, `/group` pick a group (1.1 … 6.2) from buttons.
- `/now` shows the current schedule for your group.
- `/stop` unsubscribes you.

## How it works

- Telegram sends every message and button press to the worker (a webhook), which replies right away.
- A Cloudflare schedule runs every 10 minutes. It fetches the LOE schedule and, for each
  subscriber, compares their group's outages with what they were last told. New days and
  changes are sent, up to 45 messages per run (`SEND_LIMIT` in `src/bot.ts`, to stay within
  the free plan's limits); the rest go out on the next run.
- Another schedule runs every minute and reminds subscribers 15 minutes before an outage in their
  group (`LEAD_MINUTES` in `src/reminders.ts`). Back-to-back intervals, also across midnight, count
  as one outage. If a run is missed, the next one catches up; outages already under way get no reminder.
  The same run sends 💡 when an outage ends. It's remembered per group and end time, so if LOE
  extends or shortens an outage the message goes out at the new end (up to an hour late if the
  shorter schedule is published after the fact).
- Subscribers, what each was last told, and the latest schedule are kept in a Cloudflare D1 database.
- The feed is unofficial. If LOE changes the wording or the API shape, adjust `parseSchedule` in `src/loe.ts`.

Layout:

- `src/loe.ts` fetches and parses ("Група 1.1. Електроенергії немає з 20:00 до 22:00.")
- `src/schedule.ts` durations and diffing
- `src/store.ts` D1 storage
- `src/bot.ts` commands, messages and the poll
- `src/reminders.ts` reminders before outages
- `src/index.ts` the worker: webhook, `/setup`, schedule

GitHub Actions only runs tests and deploys when the code changes.

## Setup

1. Create the bot in Telegram with @BotFather (`/newbot`) and copy the token.
2. In Cloudflare, create an API token at **My Profile → API Tokens → Create Token**, using the
   **Edit Cloudflare Workers** template, and add **Account → D1 → Edit** to its permissions.
   (The token and account id from another bot work too, if the token has these permissions.)
3. Copy your **Account ID** from the Workers & Pages overview page (right side).
4. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:
   - `TELEGRAM_BOT_TOKEN`: the bot token
   - `CLOUDFLARE_API_TOKEN`: the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID`: the id from step 3
5. Run **Actions → Deploy bot → Run workflow**. Every push to `main` deploys again.

## Development

```
npm install
npm test
npm run typecheck
```
