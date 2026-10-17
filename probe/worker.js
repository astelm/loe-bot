// Temporary: checks whether DTEK's site answers a Cloudflare Worker.
export default {
  async fetch() {
    const out = {};
    const page = await fetch("https://www.dtek-kem.com.ua/ua/shutdowns", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "uk-UA,uk;q=0.9",
      },
    });
    const html = await page.text();
    out.status = page.status;
    out.length = html.length;
    out.incapsula = /incapsula|_Incapsula_Resource|Request unsuccessful/i.test(html);
    out.csrf = /name="csrf-token"/.test(html);
    out.fact = /DisconSchedule\.fact/.test(html);
    const m = html.match(/DisconSchedule\.fact\s*=\s*(\{[\s\S]{0,1500})/);
    out.factSample = m ? m[1] : null;
    out.head = html.slice(0, 400);
    out.setCookie = page.headers.get("set-cookie")?.slice(0, 300) ?? null;
    return Response.json(out);
  },
};
