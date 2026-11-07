"""Build data/futures.json: the front bond futures contracts, their deliverable baskets with
conversion factors, and a futures price where a free source exists.

- UST (TU, FV, TY, UXY, US, WN): CME eligibility rules applied to the bonds in
  data/markets/UST.json; conversion factors from the CME formula.
- Eurex (DU, OE, RX, UB, OAT, BTS, IK): notified deliverable bonds and conversion factors.
- Futures prices: Eurex, the daily volume-weighted futures price of EFP trades over the last
  ten trading days (data/eurex_trades.json). UST: none (CME data cannot be scraped); the pages use the
  model's fair futures price instead.

The front contract rolls automatically: UST before the delivery month starts (first
position day), Eurex two business days before the delivery day.
"""

import io
import json
import re
from datetime import date, timedelta

import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar

from common import DATA, add_business_days, add_months, get, parse_date, write_json

UST_CONTRACTS = {
    # code: name, CF rounding (months), face, last delivery
    "TU": ("2-Year T-Note", 1, 200_000, "bd3"),
    "FV": ("5-Year T-Note", 1, 100_000, "bd3"),
    "TY": ("10-Year T-Note", 3, 100_000, "eom"),
    "UXY": ("Ultra 10-Year T-Note", 3, 100_000, "eom"),
    "US": ("T-Bond", 3, 100_000, "eom"),
    "WN": ("Ultra T-Bond", 3, 100_000, "eom"),
}
EUREX_CONTRACTS = {
    # code: Eurex product, market, name, coupon frequency
    "DU": ("FGBS", "DE", "Euro-Schatz", 1),
    "OE": ("FGBM", "DE", "Euro-Bobl", 1),
    "RX": ("FGBL", "DE", "Euro-Bund", 1),
    "UB": ("FGBX", "DE", "Euro-Buxl", 1),
    "OAT": ("FOAT", "FR", "Euro-OAT", 1),
    "BTS": ("FBTS", "IT", "Short-Term Euro-BTP", 2),
    "IK": ("FBTP", "IT", "Euro-BTP", 2),
}


def last_business_day(year, month):
    d = add_months(date(year, month, 1), 1) - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def ust_front(today):
    """First quarterly contract whose delivery month has not started (rolled by month end)."""
    m = date(today.year, today.month, 1)
    while True:
        m = add_months(m, 1)
        if m.month % 3 == 0 and today < last_business_day(*(add_months(m, -1).year, add_months(m, -1).month)):
            return m


def cme_conversion_factor(coupon, maturity, first_day, round_months):
    """CME conversion factor (6% notional coupon), term rounded down to whole months or quarters."""
    months = (maturity.year - first_day.year) * 12 + maturity.month - first_day.month
    if maturity.day < first_day.day:
        months -= 1
    months -= months % round_months
    n, z = divmod(months, 12)
    v = z if z < 7 else (3 if round_months == 3 else z - 6)
    c = coupon / 100
    a = 1 / 1.03 ** (v / 6)
    b = c / 2 * (6 - v) / 6
    cc = 1 / 1.03 ** (2 * n) if z < 7 else 1 / 1.03 ** (2 * n + 1)
    d = c / 0.06 * (1 - cc)
    return round(a * (c / 2 + cc + d) - b, 4)


def ust_eligible(code, term, maturity, first, last):
    if term is None:
        return False
    if code == "TU":
        return term <= 5 and add_months(first, 21) <= maturity <= add_months(last, 24)
    if code == "FV":
        return term <= 5 and maturity >= add_months(first, 50)
    if code == "TY":
        return term <= 10 and add_months(first, 78) <= maturity <= add_months(first, 96)
    if code == "UXY":
        return term == 10 and add_months(first, 113) <= maturity <= add_months(first, 120)
    if code == "US":
        return term in (20, 30) and add_months(first, 180) <= maturity < add_months(first, 300)
    if code == "WN":
        return term == 30 and maturity >= add_months(first, 300)


def us_business_days(d, n):
    """`n` US business days after `d` (weekends and federal holidays skipped)."""
    holidays = {h.date() for h in USFederalHolidayCalendar().holidays(d, d + timedelta(days=n + 10))}
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5 and d not in holidays:
            n -= 1
    return d


def build_ust(today):
    bonds = json.loads((DATA / "markets" / "UST.json").read_text())["bonds"]
    first = ust_front(today)
    last = last_business_day(first.year, first.month)
    out = {}
    for code, (name, round_months, face, last_rule) in UST_CONTRACTS.items():
        # TU and FV deliver up to the third business day of the following month.
        delivery = us_business_days(last, 3) if last_rule == "bd3" else last
        basket = []
        for b in bonds:
            term = int(b["group"][:-1]) if b["group"].endswith("Y") else None
            maturity = parse_date(b["maturity"])
            if ust_eligible(code, term, maturity, first, last):
                basket.append({"id": b["id"], "name": b["name"], "coupon": b["coupon"], "maturity": b["maturity"],
                               "cf": cme_conversion_factor(b["coupon"], maturity, first, round_months)})
        out[code] = {"market": "UST", "name": name, "expiry": f"{first:%Y-%m}", "firstDelivery": str(first),
                     "delivery": str(delivery), "face": face, "futures": None, "basket": basket}
    return out


def archive_cfs(df):
    """Keep every notified conversion factor in data/history/eurex_cf.csv: Eurex lists only current and
    future deliveries, and the GP page's basis history needs the factors of expired contracts too."""
    path = DATA / "history" / "eurex_cf.csv"
    codes = {product: code for code, (product, *_rest) in EUREX_CONTRACTS.items()}
    new = pd.DataFrame({"contract": df["product"].map(codes), "expiry": [f"{d:%Y-%m}" for d in df.delivery],
                        "delivery": df.delivery.astype(str), "isin": df["isin"], "coupon": df.coupon,
                        "maturity": df.maturity.astype(str), "cf": df.cf}).dropna(subset=["contract"])
    old = pd.read_csv(path, dtype=str) if path.exists() else pd.DataFrame(columns=new.columns)
    out = pd.concat([old, new.astype(str)]).drop_duplicates(["contract", "expiry", "isin"], keep="last")
    out.sort_values(["contract", "expiry", "maturity"]).to_csv(path, index=False)


def eurex_front(today, deliveries):
    """Earliest delivery day whose last trading day (two business days before) is still ahead."""
    for d in sorted(deliveries):
        if add_business_days(today, 2) < d:
            return d


def build_eurex(today):
    page = get("https://www.eurex.com/ex-en/data/clearing-files/notified-deliverable-bonds-conversion-factors").text
    href = re.search(r'href="([^"]*deliverable-bonds-and-conversion-factors\.csv)"', page).group(1)
    df = pd.read_csv(io.StringIO(get("https://www.eurex.com" + href).text), sep=";")
    df.columns = ["contract", "isin", "coupon", "maturity", "cf"]
    df["product"] = df.contract.str.split().str[0]
    # The date in the series name ("FGBL SI 20261208 PS") is the last trading day; delivery is two
    # exchange days later (the 10th of the month, or the next exchange day).
    df["lastTrading"] = pd.to_datetime(df.contract.str.split().str[2], format="%Y%m%d").dt.date
    df["delivery"] = [add_business_days(d, 2) for d in df.lastTrading]
    df["maturity"] = pd.to_datetime(df.maturity, format="%d.%m.%Y").dt.date
    archive_cfs(df)
    trades = json.loads((DATA / "eurex_trades.json").read_text())
    markets = {m: {b["id"]: b for b in json.loads((DATA / "markets" / f"{m}.json").read_text())["bonds"]}
               for m in ("DE", "FR", "IT")}
    out = {}
    for code, (product, market, name, freq) in EUREX_CONTRACTS.items():
        rows = df[df["product"] == product]
        delivery = eurex_front(today, set(rows.delivery))
        rows = rows[rows.delivery == delivery].sort_values(["maturity", "coupon"])
        expiry = f"{delivery:%Y-%m}"
        last_trading = rows.lastTrading.iloc[0]
        # Daily VWAP of the futures leg of EFP trades, so pages can match the date of their bond prices.
        vwap = {}
        for t in trades["efp"]:
            if t["c"] == code and t["x"] == expiry:
                pq, q = vwap.get(t["t"][:10], (0, 0))
                vwap[t["t"][:10]] = (pq + t["f"] * t["q"], q + t["q"])
        days = sorted(vwap)[-10:]
        futures = {"vwap": {d: round(vwap[d][0] / vwap[d][1], 4) for d in days},
                   "lots": {d: vwap[d][1] for d in days}} if days else None
        out[code] = {
            "market": market, "name": name, "product": product, "expiry": expiry, "lastTrading": str(last_trading),
            "firstDelivery": str(delivery), "delivery": str(delivery), "face": 100_000, "futures": futures,
            "basket": [{"id": r.isin, "name": markets[market].get(r.isin, {}).get("name", r.isin), "coupon": float(r.coupon),
                        "maturity": str(r.maturity), "cf": float(r.cf)} for r in rows.itertuples()],
        }
    return out


def build():
    today = date.today()
    contracts = {**build_ust(today), **build_eurex(today)}
    write_json(DATA / "futures.json", {"built": str(today), "contracts": contracts})
    for code, c in contracts.items():
        fut = list(c["futures"]["vwap"].items())[-1] if c["futures"] else "model"
        print(f"{code:4} {c['expiry']} delivery {c['delivery']}  {len(c['basket'])} deliverables  futures {fut}")


if __name__ == "__main__":
    build()
