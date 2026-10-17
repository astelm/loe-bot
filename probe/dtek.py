import json, re, sys, urllib.request, urllib.parse, http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def get(url, data=None, headers={}):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "uk-UA", **headers})
    with op.open(req, timeout=30) as r:
        return r.status, r.read().decode("utf-8", "replace")
st, html = get("https://www.dtek-kem.com.ua/ua/shutdowns")
print("page", st, len(html))
csrf = re.search(r'name="csrf-token" content="([^"]+)"', html)
print("csrf", bool(csrf))
for name in ["preset", "streets", "currentWeekDayIndex", "showCurOutage"]:
    m = re.search(r"DisconSchedule\.%s = (.{0,600})" % name, html)
    print(f"--- {name}:", m.group(1) if m else None)
i = html.index("DisconSchedule.fact = ") + len("DisconSchedule.fact = ")
fact, _ = json.JSONDecoder().raw_decode(html[i:])
print("--- fact meta:", {k: v for k, v in fact.items() if k != "data"})
for day, groups in fact["data"].items():
    print("day", day, len(groups), sorted(groups, key=lambda g: [int(x) for x in g[3:].split(".")]), "values", sorted({v for g in groups.values() for v in g.values()}))
    print("GPV1.1", groups.get("GPV1.1"))
streets = re.search(r"DisconSchedule\.streets = (\[.*?\])", html, re.S)
names = json.loads(streets.group(1)) if streets else []
print("streets", len(names), names[:5])
street = next((s for s in names if "Хрещатик" in s), names[0] if names else "вул. Хрещатик")
form = urllib.parse.urlencode({"method": "getHomeNum", "data[0][name]": "street", "data[0][value]": street,
                               "data[1][name]": "updateFact", "data[1][value]": "17.10.2026 20:00"}).encode()
st, body = get("https://www.dtek-kem.com.ua/ua/ajax", form, {
    "X-Requested-With": "XMLHttpRequest", "X-CSRF-Token": csrf.group(1) if csrf else "",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Referer": "https://www.dtek-kem.com.ua/ua/shutdowns"})
print("--- getHomeNum", street, st, len(body))
print(body[:2500])

d = json.loads(body)
print("--- keys", [k for k in d if k != "data"], {k: d[k] for k in d if k != "data"})
busy = [(h, v) for h, v in d["data"].items() if v.get("type")]
print("houses", len(d["data"]), "with outage", busy[:3])
print("multi groups", [(h, v["sub_type_reason"]) for h, v in d["data"].items() if len(v["sub_type_reason"]) != 1][:5])
import time
t = time.time(); ok = 0
for s2 in names[:20]:
    form = urllib.parse.urlencode({"method": "getHomeNum", "data[0][name]": "street", "data[0][value]": s2}).encode()
    try:
        st, b = get("https://www.dtek-kem.com.ua/ua/ajax", form, {"X-Requested-With": "XMLHttpRequest", "X-CSRF-Token": csrf.group(1),
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Referer": "https://www.dtek-kem.com.ua/ua/shutdowns"})
        ok += json.loads(b).get("result") is True
    except Exception as e:
        print("err", s2, e)
print(f"20 streets without updateFact: ok={ok} in {time.time()-t:.1f}s")
