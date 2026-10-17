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
    const A = `${B}/addresses/v2`;
    const r = await fetch(`${B}/regions/25/dsos/902/planned-outages`, { headers: H });
    const planned = await r.json();
    out.groups = Object.keys(planned);
    out.statuses = [...new Set(Object.values(planned).flatMap((g) => [g.today?.status, g.tomorrow?.status]))];
    out.types = [...new Set(Object.values(planned).flatMap((g) => [...(g.today?.slots ?? []), ...(g.tomorrow?.slots ?? [])].map((s) => s.type)))];
    out.extraKeys = [...new Set(Object.values(planned).flatMap((g) => Object.keys(g)))];
    for (const [k, url] of Object.entries({
      houses1: `${A}/houses?regionId=25&streetId=952&query=27&dsoId=902`,
      houses2: `${A}/houses?regionId=25&streetId=952&dsoId=902`,
      streets2: `${A}/streets?regionId=25&query=${encodeURIComponent("Курбаса")}&dsoId=902`,
    })) out[k] = await get(url);
    let houseId = null;
    try { houseId = JSON.parse(out.houses1.body)[0]?.id; } catch {}
    out.houseId = houseId;
    for (const [k, url] of Object.entries({
      group1: `${A}/group?regionId=25&streetId=952&houseId=${houseId}&dsoId=902`,
      group2: `${A}/groups?regionId=25&streetId=952&houseId=${houseId}&dsoId=902`,
      group3: `${B}/addresses/v2/group?regionId=25&dsoId=902&streetId=952&houseId=${houseId}`,
    })) out[k] = await get(url);
    return Response.json(out);
  },
};
