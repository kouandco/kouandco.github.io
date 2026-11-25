"""Refresh all site data (GitHub Actions: weekdays at 10:00, 19:00 and 23:30 London, see
.github/workflows/refresh.yml). Each step runs on its own: if a source fails, its previous file is kept
and the failure is recorded in data/meta.json (shown in the site's status bar).

Run: python scripts/refresh.py
"""

import json
import os
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

import auctions
import cftc
import curves
import dtcc
import eurex_trades
import futures
import fx
import history
import markets
import spreads
import wirp
from common import DATA, write_json

# Order matters: markets use the curves for asset swap spreads; futures, WIRP and the GP history use
# the market and curve files; the DTCC check reads the archived par swap rates, and swap spreads the
# swap rates and DTCC histories.
STEPS = [
    ("Eurex trades", eurex_trades.build),
    ("Swap curves", curves.build),
    ("DTCC swaps", dtcc.build),
    ("Swap spreads", spreads.build),
    *[(f"Market {code}", lambda code=code: markets.build(code)) for code in markets.SOURCES],
    ("Futures baskets", futures.build),
    ("Auctions", auctions.build),
    ("Policy pricing", wirp.build),
    ("GP history", history.build),
    ("FX rates", fx.build),
    ("CFTC positioning", cftc.build),
]


def main():
    meta_path = DATA / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"steps": {}}
    now = datetime.now(ZoneInfo("Europe/London")).strftime("%Y-%m-%d %H:%M %Z")
    for name, step in STEPS:
        try:
            step()
            meta["steps"][name] = {"ok": True, "at": now}
        except Exception as e:
            traceback.print_exc()
            meta["steps"][name] = {"ok": False, "at": now, "error": f"{type(e).__name__}: {e}"[:300],
                                   "lastGood": meta["steps"].get(name, {}).get("lastGood") or meta["steps"].get(name, {}).get("at")}
            continue
        meta["steps"][name]["lastGood"] = now
    meta["refreshed"] = now
    # The workflow's slot (morning / evening / night) is done for the day once every step succeeded.
    slot, day = os.environ.get("REFRESH_SLOT"), os.environ.get("REFRESH_DAY")
    if slot and slot != "manual" and day and all(s["ok"] for s in meta["steps"].values()):
        meta.setdefault("slots", {})[slot] = day
    write_json(meta_path, meta)
    failed = [n for n, s in meta["steps"].items() if not s["ok"]]
    print("Refreshed", now, "| failed:", ", ".join(failed) or "none")


if __name__ == "__main__":
    main()
