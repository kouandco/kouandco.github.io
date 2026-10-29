"""Build baskets.json: deliverable baskets, yields, betas and vols for the CTD page.

Sources
- UST: TreasuryDirect auction records (coupons, maturities) and the Treasury
  daily par yield curve (yields, 65-day betas and vol).
- Eurex: Eurex notified deliverable bonds and conversion factors, bond reference
  prices from Borsa Italiana (MOT), Bundesbank Svensson curve for betas and vol.
  Italian / French vol = German vol x (IT or FR / DE) ratio of monthly yield-change
  vol from FRED.

Run: python build_baskets.py   (writes baskets.json next to this file)
"""

import json
import re
import time
from datetime import date, timedelta
from io import StringIO
from pathlib import Path

import numpy as np
import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
WINDOW = 65
OUT = Path(__file__).with_name("baskets.json")

# Front contracts (December 2026).
UST_MONTH = date(2026, 12, 1)
UST_LAST_DAY = date(2026, 12, 31)
EUREX_DELIVERY = "20261208"

UST_CONTRACTS = {
    # code: name, generic par-curve node, CF rounding (months), face, delivery date
    "TU": ("2-Year T-Note", "2 Yr", 1, 200_000, "2027-01-06"),
    "FV": ("5-Year T-Note", "5 Yr", 1, 100_000, "2027-01-06"),
    "TY": ("10-Year T-Note", "10 Yr", 3, 100_000, "2026-12-31"),
    "UXY": ("Ultra 10-Year T-Note", "10 Yr", 3, 100_000, "2026-12-31"),
    "US": ("T-Bond", "20 Yr", 3, 100_000, "2026-12-31"),
    "WN": ("Ultra T-Bond", "30 Yr", 3, 100_000, "2026-12-31"),
}

EUREX_CONTRACTS = {
    # code: Eurex product, market, name, Bundesbank generic node (years), coupon frequency
    "DU": ("FGBS", "Bund", "Euro-Schatz", 2, 1),
    "OE": ("FGBM", "Bund", "Euro-Bobl", 5, 1),
    "RX": ("FGBL", "Bund", "Euro-Bund", 10, 1),
    "UB": ("FGBX", "Bund", "Euro-Buxl", 30, 1),
    "OAT": ("FOAT", "OAT", "Euro-OAT", 10, 1),
    "BTS": ("FBTS", "BTP", "Short-Term Euro-BTP", 2, 2),
    "IK": ("FBTP", "BTP", "Euro-BTP", 10, 2),
}


def add_months(d, months):
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


def years_between(a, b):
    return (b - a).days / 365.25


def frac_name(c):
    whole = int(c)
    eighths = round((c - whole) * 8)
    frac = {0: "", 1: " 1/8", 2: " 1/4", 3: " 3/8", 4: " 1/2", 5: " 5/8", 6: " 3/4", 7: " 7/8"}[eighths]
    return f"{whole}{frac}"


def betas_and_vol(changes, generic, x_nodes, maturities_years):
    """65-day beta of each node to the generic node, interpolated at each maturity."""
    d = changes.iloc[-WINDOW:]
    g = d[generic]
    node_beta = np.array([np.cov(d[c], g)[0, 1] / g.var() for c in d.columns])
    vol = g.std() * 100 * np.sqrt(252)  # bp / year
    return np.interp(maturities_years, x_nodes, node_beta), vol


# ---------------------------------------------------------------- UST

def treasury_par_curve():
    frames = []
    for year in (date.today().year - 1, date.today().year):
        url = (
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
            f"daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
            f"&field_tdr_date_value={year}&page&_format=csv"
        )
        frames.append(pd.read_csv(StringIO(requests.get(url, timeout=60).text), parse_dates=["Date"]))
    df = pd.concat(frames).sort_values("Date").set_index("Date")
    return df[["1 Yr", "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr"]].dropna()


def treasury_securities():
    rows = {}
    for kind, terms, start in (
        ("Note", ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year"], "2016-01-01"),
        ("Bond", ["20-Year", "30-Year"], "2011-01-01"),
    ):
        for term in terms:
            url = (
                "https://www.treasurydirect.gov/TA_WS/securities/search?format=json"
                f"&type={kind}&securityTerm={term}&startDate={start}&endDate={date.today()}"
            )
            for r in requests.get(url, timeout=120).json():
                if not r.get("interestRate"):
                    continue
                rows[r["cusip"]] = {
                    "cusip": r["cusip"],
                    "coupon": float(r["interestRate"]),
                    "maturity": date.fromisoformat(r["maturityDate"][:10]),
                    "issue": date.fromisoformat(r["originalIssueDate"][:10] if r.get("originalIssueDate") else r["issueDate"][:10]),
                    "orig_years": int(r["originalSecurityTerm"].split("-")[0]),
                }
    return list(rows.values())


def ust_eligible(code, s):
    m, orig = s["maturity"], s["orig_years"]
    first, last = UST_MONTH, UST_LAST_DAY
    if s["issue"] > last:
        return False
    if code == "TU":
        return orig <= 5 and add_months(first, 21) <= m <= add_months(last, 24)
    if code == "FV":
        return orig <= 5 and m >= add_months(first, 50)
    if code == "TY":
        return orig <= 10 and add_months(first, 78) <= m <= add_months(first, 96)
    if code == "UXY":
        return orig == 10 and add_months(first, 113) <= m <= add_months(first, 120)
    if code == "US":
        return orig in (20, 30) and add_months(first, 180) <= m < add_months(first, 300)
    if code == "WN":
        return orig == 30 and m >= add_months(first, 300)


def build_ust():
    curve = treasury_par_curve()
    as_of = curve.index[-1].date()
    last = curve.iloc[-1]
    nodes = np.array([1, 2, 3, 5, 7, 10, 20, 30.0])
    changes = curve.diff().dropna()
    secs = treasury_securities()
    out = {}
    for code, (name, generic, round_months, face, delivery) in UST_CONTRACTS.items():
        basket = sorted((s for s in secs if ust_eligible(code, s)), key=lambda s: (s["maturity"], s["coupon"]))
        t = np.array([years_between(as_of, s["maturity"]) for s in basket])
        betas, vol = betas_and_vol(changes, generic, nodes, t)
        yields = np.interp(t, nodes, last.values)
        out[code] = {
            "market": "UST",
            "name": name,
            "currency": "$",
            "face": face,
            "freq": 2,
            "cf": "cme",
            "roundMonths": round_months,
            "asOf": str(as_of),
            "delivery": delivery,
            "generic": f"{generic} par yield",
            "vol": round(vol),
            "yieldSource": "Treasury par curve interpolated at maturity",
            "bonds": [
                {
                    "name": f"T {frac_name(s['coupon'])} {s['maturity']:%m/%d/%y}",
                    "id": s["cusip"],
                    "coupon": s["coupon"],
                    "maturity": str(s["maturity"]),
                    "yield": round(float(y), 3),
                    "beta": round(float(b), 2),
                }
                for s, y, b in zip(basket, yields, betas)
            ],
        }
    return out


# ---------------------------------------------------------------- Eurex

def eurex_baskets():
    page = requests.get(
        "https://www.eurex.com/ex-en/data/clearing-files/notified-deliverable-bonds-conversion-factors",
        headers=UA, timeout=60,
    ).text
    href = re.search(r'href="([^"]*deliverable-bonds-and-conversion-factors\.csv)"', page).group(1)
    csv = requests.get("https://www.eurex.com" + href, headers=UA, timeout=60).text
    df = pd.read_csv(StringIO(csv), sep=";")
    df.columns = ["contract", "isin", "coupon", "maturity", "cf"]
    df["product"] = df["contract"].str.split().str[0]
    df["delivery"] = df["contract"].str.split().str[2]
    df["maturity"] = pd.to_datetime(df["maturity"], format="%d.%m.%Y").dt.date
    return df[df["delivery"] == EUREX_DELIVERY]


def borsa_quote(isin):
    """Reference price, its date and gross yield from Borsa Italiana."""
    paths = ["mot/btp", "mot/euro-obbligazioni"] if isin.startswith("IT") else ["mot/euro-obbligazioni"]
    for path in paths:
        url = f"https://www.borsaitaliana.it/borsa/obbligazioni/{path}/scheda/{isin}.html?lang=en"
        r = requests.get(url, headers=UA, timeout=60)
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
        price = re.search(r"Reference price ([\d.,]+)", text)
        when = re.search(r"Reference price date (\d\d/\d\d/\d{4})", text)
        yld = re.search(r"Gross yield to maturity (-?[\d.,]+)", text)
        time.sleep(0.5)
        if price and yld:
            return {
                "price": float(price.group(1).replace(",", "")),
                "date": when.group(1) if when else None,
                "yield": float(yld.group(1).replace(",", "")),
            }
    return None


def bundesbank_curve():
    frames = {}
    for n in range(1, 31):
        key = f"BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R{n:02d}XX.R.A.A._Z._Z.A"
        url = f"https://api.statistiken.bundesbank.de/rest/data/{key}?lastNObservations=120&format=csv&lang=en"
        lines = requests.get(url, timeout=60).text.splitlines()
        data = [l.split(",")[:2] for l in lines if re.match(r"^\d{4}-\d\d-\d\d,", l)]
        frames[n] = pd.Series({pd.Timestamp(d): float(v) for d, v in data if v not in ("", ".")})
    return pd.DataFrame(frames).dropna().sort_index()


def fred_monthly_vol_ratio(country):
    ids = {"DE": "IRLTLT01DEM156N", "IT": "IRLTLT01ITM156N", "FR": "IRLTLT01FRM156N"}
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={ids['DE']},{ids[country]}"
    df = pd.read_csv(StringIO(requests.get(url, timeout=60).text), na_values=["."]).dropna().iloc[-37:]
    d = df.iloc[:, 1:].diff().dropna()
    return d.iloc[:, 1].std() / d.iloc[:, 0].std()


def eur_name(row, market):
    prefix = {"Bund": "DBR", "OAT": "FRTR", "BTP": "BTPS"}[market]
    green = " (G)" if row.isin.startswith("DE000103") else ""
    return f"{prefix} {row.coupon:g} {row.maturity:%m/%d/%y}{green}"


def build_eurex():
    baskets = eurex_baskets()
    curve = bundesbank_curve()
    changes = curve.diff().dropna()
    nodes = np.array(curve.columns, dtype=float)
    ratio = {"Bund": 1.0, "OAT": fred_monthly_vol_ratio("FR"), "BTP": fred_monthly_vol_ratio("IT")}
    quotes = {}
    out = {}
    for code, (product, market, name, generic, freq) in EUREX_CONTRACTS.items():
        rows = baskets[baskets["product"] == product].sort_values(["maturity", "coupon"])
        bonds, dates = [], set()
        for row in rows.itertuples():
            if row.isin not in quotes:
                quotes[row.isin] = borsa_quote(row.isin)
            q = quotes[row.isin]
            if q is None:
                print(f"  no quote for {row.isin}, skipped")
                continue
            dates.add(q["date"])
            y = q["yield"]
            if freq == 2:  # Borsa quotes annual-compounded yields; convert to semi-annual
                y = 200 * ((1 + y / 100) ** 0.5 - 1)
            bonds.append({"row": row, "yield": y})
        as_of = curve.index[-1].date()
        t = np.array([years_between(as_of, b["row"].maturity) for b in bonds])
        betas, vol = betas_and_vol(changes, generic, nodes, t)
        out[code] = {
            "market": market,
            "name": name,
            "currency": "€",
            "face": 100_000,
            "freq": freq,
            "cf": "given",
            "asOf": max(dates, key=lambda s: s[6:] + s[3:5] + s[:2]) if dates else str(as_of),
            "delivery": f"{EUREX_DELIVERY[:4]}-{EUREX_DELIVERY[4:6]}-{EUREX_DELIVERY[6:]}",
            "generic": f"German {generic}y zero yield" + ("" if market == "Bund" else f" × {ratio[market]:.2f} ({market}/DE vol ratio)"),
            "vol": round(vol * ratio[market]),
            "yieldSource": "Borsa Italiana reference prices (gross yield to maturity)",
            "bonds": [
                {
                    "name": eur_name(b["row"], market),
                    "id": b["row"].isin,
                    "coupon": float(b["row"].coupon),
                    "maturity": str(b["row"].maturity),
                    "yield": round(float(b["yield"]), 3),
                    "beta": round(float(beta), 2),
                    "cf": float(b["row"].cf),
                }
                for b, beta in zip(bonds, betas)
            ],
        }
    return out


if __name__ == "__main__":
    print("UST ...")
    contracts = build_ust()
    print("Eurex ...")
    contracts.update(build_eurex())
    OUT.write_text(json.dumps({"built": str(date.today()), "contracts": contracts}, indent=1))
    for code, c in contracts.items():
        print(f"{code:4} {c['market']:4} as of {c['asOf']}  vol {c['vol']:>3}bp  {len(c['bonds'])} bonds")
