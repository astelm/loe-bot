"""Reads DTEK Kyiv (dtek-kem.com.ua) and posts it to the bot.

The site blocks Cloudflare, so this runs on GitHub Actions (.github/workflows/kyiv.yml):
  python3 scripts/dtek.py schedule   # newest outage schedule -> /kyiv/schedule
  python3 scripts/dtek.py streets    # every street's house -> group list -> /kyiv/streets

Needs WORKER_URL and TELEGRAM_BOT_TOKEN (the worker's secret is derived from it, as in deploy.yml).
"""
import hashlib, http.cookiejar, json, os, re, sys, time, urllib.parse, urllib.request

SITE = "https://www.dtek-kem.com.ua"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
WORKER = os.environ["WORKER_URL"].rstrip("/")
SECRET = hashlib.sha256(f"{os.environ['TELEGRAM_BOT_TOKEN']}:webhook".encode()).hexdigest()[:48]
CHUNK = 40  # streets per request to the worker


class Dtek:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.html = self._open(f"{SITE}/ua/shutdowns")
        token = re.search(r'name="csrf-token" content="([^"]+)"', self.html)
        if not token:
            raise RuntimeError("no csrf token on the page (blocked?)")
        self.csrf = token.group(1)

    def _open(self, url, data=None, headers={}):
        req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "uk-UA", **headers})
        with self.opener.open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")

    def page_value(self, name):
        start = self.html.index(f"DisconSchedule.{name} = ") + len(f"DisconSchedule.{name} = ")
        return json.JSONDecoder().raw_decode(self.html[start:])[0]

    def street(self, name, update_fact=None):
        fields = {"method": "getHomeNum", "data[0][name]": "street", "data[0][value]": name}
        if update_fact:  # the schedule version we have; the answer carries a newer `fact` if there is one
            fields.update({"data[1][name]": "updateFact", "data[1][value]": update_fact})
        form = urllib.parse.urlencode(fields).encode()
        body = json.loads(self._open(f"{SITE}/ua/ajax", form, {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": self.csrf,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Referer": f"{SITE}/ua/shutdowns",
        }))
        if body.get("result") is not True:
            raise RuntimeError(f"getHomeNum {name!r}: {str(body)[:200]}")
        return body


def post(path, payload):
    req = urllib.request.Request(f"{WORKER}{path}", data=json.dumps(payload, ensure_ascii=False).encode(), headers={
        "Authorization": f"Bearer {SECRET}", "Content-Type": "application/json", "User-Agent": "loe-bot-github",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt == 2:
                raise
            print(f"worker {path}: {e}, retrying")
            time.sleep(5)


def schedule():
    dtek = Dtek()
    fact = dtek.page_value("fact")
    # `update` is when DTEK last changed the schedule. (getHomeNum's updateTimestamp is just the time of the request.)
    print(f"schedule as of {fact.get('update')}: {list(fact['data'])}")
    print(post("/kyiv/schedule", {"fact": fact, "updateTimestamp": fact.get("update")}))


def streets():
    dtek = Dtek()
    names = dtek.page_value("streets")
    print(f"{len(names)} streets")
    chunk, failed, houses_total = {}, [], 0
    for i, name in enumerate(names):
        for attempt in range(2):
            try:
                data = dtek.street(name)["data"]
                break
            except Exception as e:
                if attempt == 1:
                    print(f"failed {name}: {e}")
                    failed.append(name)
                    data = None
                else:
                    time.sleep(3)
                    dtek = Dtek()  # new session and token
        if data:
            houses = {h: v["sub_type_reason"][0].removeprefix("GPV") for h, v in data.items() if v.get("sub_type_reason")}
            if houses:
                chunk[name] = houses
                houses_total += len(houses)
        if len(chunk) >= CHUNK or (i == len(names) - 1 and chunk):
            post("/kyiv/streets", {"streets": chunk})
            chunk = {}
        if i % 200 == 0:
            print(f"{i}/{len(names)}")
        time.sleep(0.2)
    print(f"done: {len(names) - len(failed)} streets, {houses_total} houses, {len(failed)} failed")
    if len(failed) > len(names) // 10:
        sys.exit(1)


if __name__ == "__main__":
    {"schedule": schedule, "streets": streets}[sys.argv[1]]()
