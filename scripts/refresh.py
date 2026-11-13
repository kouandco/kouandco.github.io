"""Refresh all site data. Each step runs on its own: if a source fails, its previous file is kept
and the failure is recorded in data/meta.json (shown in the site's status bar).

Run: python scripts/refresh.py
"""

import json
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo

import auctions
import curves
import eurex_trades
import futures
import fx
import history
import markets
import wirp
from common import DATA, write_json

# Order matters: markets use the curves for asset swap spreads; futures, WIRP and the GP history use
# the market and curve files.
STEPS = [
    ("Eurex trades", eurex_trades.build),
    ("Swap curves", curves.build),
    *[(f"Market {code}", lambda code=code: markets.build(code)) for code in markets.SOURCES],
    ("Futures baskets", futures.build),
    ("Auctions", auctions.build),
    ("Policy pricing", wirp.build),
    ("GP history", history.build),
    ("FX rates", fx.build),
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
    write_json(meta_path, meta)
    failed = [n for n, s in meta["steps"].items() if not s["ok"]]
    print("Refreshed", now, "| failed:", ", ".join(failed) or "none")


if __name__ == "__main__":
    main()
