const LOE = "https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic";
const YASNO = "https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages";
const KEEP = ["cache-control", "age", "cf-cache-status", "etag", "content-type"];
const H = { Accept: "application/ld+json, application/json", "User-Agent": "loe-outage-telegram-bot/1.0" };
async function get(url, extra = {}) {
  const t = Date.now();
  const r = await fetch(url, { headers: { ...H, ...extra } });
  const text = await r.text();
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hash = [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { text, info: { status: r.status, ms: Date.now() - t, bytes: text.length, hash, ...Object.fromEntries(KEEP.map((k) => [k, r.headers.get(k)]).filter(([, v]) => v)) } };
}
function diff(a, b, path = "", out = []) {
  if (out.length > 10) return out;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  return out;
}
export default {
  async fetch() {
    const cached = await get(LOE);
    const busted = await get(`${LOE}&_=${Date.now()}`);
    const nocache = await get(LOE, { "Cache-Control": "no-cache", Pragma: "no-cache" });
    const page2 = await get(LOE.replace("page=1", "page=01"));
    let ys = [];
    for (let i = 0; i < 4; i++) ys.push(await get(YASNO));
    const yDiffs = [];
    for (let i = 1; i < ys.length; i++) if (ys[i].info.hash !== ys[0].info.hash) yDiffs.push(diff(JSON.parse(ys[0].text), JSON.parse(ys[i].text)));
    return Response.json({
      loe: { cached: cached.info, busted: busted.info, nocache: nocache.info, page01: page2.info,
        bustedSame: cached.text === busted.text, bustedDiff: cached.text === busted.text ? [] : diff(JSON.parse(cached.text), JSON.parse(busted.text)) },
      yasno: { hashes: ys.map((y) => y.info.hash), diffs: yDiffs },
    });
  },
};
