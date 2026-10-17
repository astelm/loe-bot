// Temporary: what Yasno's API returns to a Cloudflare Worker.
const B = "https://app.yasno.ua/api/blackout-service/public/shutdowns";
const H = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" };
async function get(url) {
  try {
    const r = await fetch(url, { headers: H });
    const t = await r.text();
    return { status: r.status, len: t.length, body: t.slice(0, 1500) };
  } catch (e) { return { error: String(e) }; }
}
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const q = u.searchParams.get("q");
    if (q) return Response.json(await get(q));
    const out = {};
    out.planned = await get(`${B}/regions/25/dsos/902/planned-outages`);
    out.regions = await get(`${B}/addresses/v2/regions`);
    out.streets = await get(`${B}/addresses/v2/streets?regionId=25&query=${encodeURIComponent("Хрещатик")}&dsoId=902`);
    return Response.json(out);
  },
};
