// Temporary: what LOE's API returns to a Cloudflare Worker.
export default {
  async fetch() {
    const out = {};
    for (const [label, headers] of [
      ["bot", { Accept: "application/ld+json, application/json", "User-Agent": "loe-outage-telegram-bot/1.0" }],
      ["json", { Accept: "application/json" }],
      ["browser", { Accept: "application/ld+json, application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" }],
    ]) {
      const res = await fetch("https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic", { headers });
      const text = await res.text();
      let summary = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        summary = (j["hydra:member"] ?? []).flatMap((m) => (m.menuItems ?? []).map((i) => `${i.name}: raw=${(i.rawHtml ?? "").length} ${(i.rawHtml ?? "").slice(0, 120)}`));
        out[label + "_keys"] = Object.keys(j).slice(0, 10);
      } catch {}
      out[label] = { status: res.status, type: res.headers.get("content-type"), cf: res.headers.get("cf-cache-status"), age: res.headers.get("age"), len: text.length, summary };
    }
    return Response.json(out);
  },
};
