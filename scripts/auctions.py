"""Build data/auctions.json: recent and upcoming government bond auctions and syndications,
from the issuers' own websites, with links to the official notices.

- UST: TreasuryDirect upcoming and recent auctions (nominal notes and bonds).
- Germany: Finanzagentur issuance calendar (Bunds, Bobls, Schatz, green) and syndicates.
- Italy: MEF Treasury Department auction announcements (BTPs, BTP Short, BTP Green).
- France: AFT's site does not allow automated access, so dates follow AFT's standing calendar
  (long-term OATs on the first Thursday of the month, medium-term on the third); lines and
  amounts are announced by AFT shortly before each auction.
"""

import io
import json
import re
from datetime import date, datetime, timedelta

import pandas as pd
from pypdf import PdfReader

from common import DATA, add_months, get, isin_from_cusip, write_json

PAST_DAYS = 21
AHEAD_DAYS = 45


def window(d):
    today = date.today()
    if d is None or not today - timedelta(days=PAST_DAYS) <= d <= today + timedelta(days=AHEAD_DAYS):
        return None
    return "upcoming" if d >= today else "recent"


def deal(d, kind, name, isin=None, maturity=None, coupon=None, size=None, reopening=None, result=None, link=None):
    return {"date": str(d), "status": window(d), "kind": kind, "name": name, "id": isin,
            "maturity": str(maturity) if maturity else None, "coupon": coupon, "size": size,
            "reopening": reopening, "result": result, "link": link}


# ---------------------------------------------------------------- UST

def ust():
    base = "https://www.treasurydirect.gov/TA_WS/securities"
    pdf = "https://www.treasurydirect.gov/instit/annceresult/press/preanre/{year}/{name}"
    rows = get(f"{base}/upcoming?format=json").json() + get(f"{base}/auctioned?format=json&days={PAST_DAYS}").json()
    out, seen = [], set()
    for r in rows:
        if r["securityType"] not in ("Note", "Bond") or r.get("inflationProtected") == "Yes" or r.get("floatingRate") == "Yes":
            continue
        d = datetime.strptime(r["competitiveAuctionCloseDate"][:10], "%Y-%m-%d").date()
        if (r["cusip"], d) in seen or not window(d):
            continue
        seen.add((r["cusip"], d))
        years = int(r["securityTerm"].split("-")[0])
        issue = datetime.strptime(r["issueDate"][:10], "%Y-%m-%d").date()
        maturity = r.get("maturityDate", "")[:10] or str(add_months(issue, 12 * years))
        size = f"${int(r['offeringAmount']) / 1e9:.0f}bn" if r.get("offeringAmount") else f"TBA ({r['announcementDate'][:10]})"
        files = [r.get("treasuryAuctionResultsPressReleaseFileName"), r.get("treasuryOfferingAnnouncementPressReleaseFileName")]
        name = next((f for f in files if f), None)
        out.append(deal(d, "Auction", f"{r['securityTerm']} {r['securityType']}", isin_from_cusip(r["cusip"]), maturity,
                        float(r["interestRate"]) if r.get("interestRate") else None, size, r.get("reopening") == "Yes",
                        f"high yield {float(r['highYield']):.3f}%" if r.get("highYield") else None,
                        pdf.format(year=name[2:6], name=name) if name else "https://www.treasurydirect.gov/auctions/upcoming/"))
    return {"source": "U.S. Treasury (TreasuryDirect)", "calendar": "https://www.treasurydirect.gov/auctions/upcoming/", "deals": out}


# ---------------------------------------------------------------- Germany

def germany():
    site = "https://www.deutsche-finanzagentur.de/en/federal-securities/issuances"
    out = []
    cal = pd.read_html(io.StringIO(get(f"{site}/issuance-calendar").text))
    for t in cal:
        for r in t.itertuples(index=False):
            m = re.match(r"(\d\d\.\d\d\.\d{4})", str(r[0]))
            issuance = re.sub(r"\s+", " ", str(r[1]))
            if not m or issuance.startswith("Bubill"):
                continue
            d = datetime.strptime(m.group(1), "%d.%m.%Y").date()
            if not window(d):
                continue
            isin = re.search(r"DE[0-9A-Z]{10}", issuance)
            mat = re.match(r"(\d\d\.\d\d\.\d{4})", str(r[4]))
            cpn = re.match(r"([\d.]+)", str(r[3]))
            name = re.sub(r"DE[0-9A-Z]{10}|\((R|N)\)", "", issuance).replace("30 Y", "30Y").strip()
            out.append(deal(d, "Syndicate" if "syndicate" in issuance.lower() else "Auction", name, isin.group(0) if isin else None,
                            datetime.strptime(mat.group(1), "%d.%m.%Y").date() if mat else None,
                            float(cpn.group(1)) if cpn else None, str(r[2]).replace(" € bn", "").strip() + " €bn" if "bn" in str(r[2]) else str(r[2]),
                            "(R)" in issuance, None, f"{site}/issuance-calendar"))
    for t in pd.read_html(io.StringIO(get(f"{site}/syndicates").text)):
        for r in t.itertuples(index=False):
            try:
                d = datetime.strptime(str(r[0])[:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            if window(d):
                out.append(deal(d, "Syndicate", re.sub(r"_", " ", str(r[2])), str(r[1]), str(r[5])[:10],
                                float(re.match(r"[\d.]+", str(r[4]).strip()).group(0)), str(r[3]).replace("€ ", "€"),
                                None, None, f"{site}/syndicates"))
    return {"source": "Bundesrepublik Deutschland Finanzagentur", "calendar": f"{site}/issuance-calendar", "deals": out}


# ---------------------------------------------------------------- Italy

MONTH_DATE = r"(January|February|March|April|May|June|July|August|September|October|November|December) (\d\d?), (\d{4})"


def mef_announcement(page_url):
    page = get(page_url).text
    href = re.search(r'href="([^"]+Announcement[^"]+\.pdf)"', page)
    if not href:
        return []
    pdf_url = "https://www.dt.mef.gov.it" + href.group(1)
    text = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(get(pdf_url).content)).pages)
    flat = re.sub(r"\s+", " ", text)
    dates = [datetime.strptime(" ".join(m), "%B %d %Y").date() for m in re.findall(MONTH_DATE, flat)]
    auction = dates[1] if len(dates) > 1 else None
    line = lambda label: next((l for l in text.splitlines() if l.startswith(label)), "")
    isins = re.findall(r"IT[0-9A-Z]{10}", line("ISIN"))
    types = re.findall(r"BTP\s*(?:Short|Green|€i|Italia)?(?:\s*\d+\s*Years)?|CCTeu|CTZ", line("Type"))
    maturities = [datetime.strptime(" ".join(m), "%B %d %Y").date() for m in re.findall(MONTH_DATE, line("Maturity"))]
    coupons = re.findall(r"([\d.]+)%|-", line("Coupon"))
    lo = re.findall(r"[\d,]+", line("Amount Min").split(")")[-1])
    hi = re.findall(r"[\d,]+", line("Amount Max").split(")")[-1])
    out = []
    for i, isin in enumerate(isins):
        kind = types[i] if i < len(types) else "BTP"
        if kind.startswith(("CCT", "BTP €i", "BTP€i", "BTP Italia")) or "€i" in kind:
            continue
        size = f"€{float(lo[i].replace(',', '')) / 1e3:.2f}–{float(hi[i].replace(',', '')) / 1e3:.2f}bn" if i < len(lo) and i < len(hi) else None
        cpn = coupons[i] if i < len(coupons) and coupons[i] else None
        out.append(deal(auction, "Auction", kind.strip(), isin, maturities[i] if i < len(maturities) else None,
                        float(cpn) if cpn else None, size, None, None, pdf_url))
    return out


def italy():
    base = "https://www.dt.mef.gov.it"
    page = get(f"{base}/en/debito_pubblico/").text
    links = sorted({h.split("?")[0] for h in re.findall(r'href="(/en/news_debito_pubblico/\d{4}/comunicazione_emissione_[^"]+)"', page)
                    if "_bot_" not in h})
    out = []
    for h in links:
        out += [d for d in mef_announcement(base + h) if d["status"]]
    # MEF's page lists only its latest few notices, so an announcement drops off while its auction is still
    # recent: keep auctions found on earlier runs while they are inside the window.
    path = DATA / "auctions.json"
    old = json.loads(path.read_text())["markets"].get("IT", {}).get("deals", []) if path.exists() else []
    seen = {(d["date"], d["id"]) for d in out}
    for d in old:
        status = window(date.fromisoformat(d["date"])) if d.get("date") else None
        if status and (d["date"], d["id"]) not in seen:
            out.append({**d, "status": status})
    return {"source": "MEF Department of the Treasury",
            "calendar": f"{base}/en/debito_pubblico/emissioni_titoli_di_stato_interni/calendari_emissioni/", "deals": out}


# ---------------------------------------------------------------- France

def nth_thursday(year, month, n):
    d = date(year, month, 1)
    d += timedelta(days=(3 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def france():
    out = []
    today = date.today()
    for k in range(-1, 3):
        m = add_months(date(today.year, today.month, 1), k)
        if m.month == 8:
            continue  # no OAT auctions in August
        for n, label, tenor in ((1, "Long-term OATs", "8–50y"), (3, "Medium-term OATs", "2–7y")):
            if m.month == 12 and n == 3:
                continue  # December usually has a single (long-term) auction
            d = nth_thursday(m.year, m.month, n)
            if window(d):
                out.append(deal(d, "Auction", f"{label} ({tenor}, lines TBA)", size="TBA",
                                link="https://www.aft.gouv.fr/en"))
    return {"source": "Agence France Trésor (indicative dates from its standing calendar)",
            "calendar": "https://www.aft.gouv.fr/en", "deals": out}


SOURCES = {"UST": ust, "DE": germany, "IT": italy, "FR": france}


def build():
    data = {"built": str(date.today()), "markets": {}}
    for code, f in SOURCES.items():
        try:
            data["markets"][code] = f()
        except Exception as e:  # keep the other markets if one issuer's site changes
            print(f"  {code} auctions failed: {e}")
            data["markets"][code] = {"source": "unavailable", "calendar": None, "deals": [], "error": str(e)[:200]}
        data["markets"][code]["deals"].sort(key=lambda x: x["date"])
        print(f"{code}: {len(data['markets'][code]['deals'])} auctions / syndications")
    write_json(DATA / "auctions.json", data)


if __name__ == "__main__":
    build()
