const URLS = {
  loe: "https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic",
  yasno: "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages",
};
const KEEP = ["cache-control", "age", "cf-cache-status", "expires", "last-modified", "etag", "date"];
export default {
  async fetch() {
    const out = {};
    for (const [name, url] of Object.entries(URLS)) {
      const t = Date.now();
      const r = await fetch(url, { headers: { Accept: "application/ld+json, application/json", "User-Agent": "loe-outage-telegram-bot/1.0" } });
      const body = await r.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
      out[name] = { status: r.status, ms: Date.now() - t, bytes: body.byteLength, hash, ...Object.fromEntries(KEEP.map((k) => [k, r.headers.get(k)]).filter(([, v]) => v)) };
    }
    return Response.json(out);
  },
};
