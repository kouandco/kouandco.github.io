"""Archive Eurex EFP-Fin and EFS trade files and build eurex_trades.json.

Eurex only lists the last ~20 trading days of trade files, so every file is kept
in ARCHIVE (outside the website repo). The latest two days are re-downloaded on
each run because the current day's file grows during the session.

Scaling (Eurex trade file format): futures price has 3 implied decimals for FGBS, FGBM
and FBTS and 2 for the other bond futures; cash price has 4; nominal is in thousands. The
swap fixed rate mostly has 4 implied decimals (34884 = 3.4884%), but some rows are
written with 2 and a decimal point (320.96 = 3.2096%); anything else is dropped.

Run: python update_eurex_trades.py     (scheduled hourly via launchd)
"""

import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
HERE = Path(__file__).parent
ARCHIVE = HERE.parent / "eurex_data"
OUT = HERE / "eurex_trades.json"
PAGES = {"efpf": "https://www.eurex.com/ex-en/data/trading-files/efpf",
         "efs": "https://www.eurex.com/ex-en/data/trading-files/efs"}
PRODUCTS = {"FGBS": "DU", "FGBM": "OE", "FGBL": "RX", "FGBX": "UB", "FOAT": "OAT", "FBTS": "BTS", "FBTP": "IK"}
FUT_DECIMALS = {"FGBS": 3, "FGBM": 3, "FBTS": 3}


def download():
    fetched = []
    for kind, page in PAGES.items():
        folder = ARCHIVE / kind
        folder.mkdir(parents=True, exist_ok=True)
        html = requests.get(page, headers=UA, timeout=60).text
        # Links are served either absolute or relative to the site root.
        links = sorted(
            {("https://www.eurex.com" + u if u.startswith("/") else u, d)
             for u, d in re.findall(rf'href="((?:https://www\.eurex\.com)?/[^"]*/{kind}(\d{{8}})\.csv)"', html)},
            key=lambda x: x[1],
        )
        if not links:
            raise RuntimeError(f"no {kind} files listed on {page}")
        recent = {d for _, d in links[-2:]}
        for url, day in links:
            path = folder / f"{kind}{day}.csv"
            if path.exists() and day not in recent:
                continue
            path.write_bytes(requests.get(url, headers=UA, timeout=60).content)
            fetched.append(path.name)
    return fetched


def load(kind):
    frames = [pd.read_csv(f, sep=";", dtype=str) for f in sorted((ARCHIVE / kind).glob(f"{kind}*.csv"))]
    df = pd.concat(frames)
    df = df[(df["HEAD"] == "DATA") & df["prodId"].isin(PRODUCTS)].drop_duplicates("tranIdNo", keep="last")
    df["futPrc"] = df["futPrc"].astype(float) / 10 ** df["prodId"].map(FUT_DECIMALS).fillna(2)
    bad = df.loc[(df["futPrc"] < 50) | (df["futPrc"] > 250), "prodId"].unique()
    if len(bad):
        raise ValueError(f"futures prices out of range for {list(bad)}: check FUT_DECIMALS")
    df["lots"] = df["futSiz"].astype(int)
    df["ts"] = pd.to_datetime(df["date"] + df["time"].str.zfill(8).str[:6], format="%Y%m%d%H%M%S")
    df["contract"] = df["prodId"].map(PRODUCTS)
    df["expiry"] = df["year"].astype(int).astype(str) + "-" + df["month"].astype(int).astype(str).str.zfill(2)
    return df.sort_values("ts")


def build():
    efp = load("efpf")
    efp["cash"] = efp["cashPrc"].astype(float) / 1e4
    efp = efp[efp["cash"] > 0]
    # Keep EFPs against deliverable bonds only: the page shows CTD and 2nd CTD basis.
    baskets = json.loads((HERE / "baskets.json").read_text())["contracts"]
    deliverable = {b["id"] for k in PRODUCTS.values() for b in baskets[k]["bonds"]}
    efp = efp[efp["bondId"].isin(deliverable)]
    efs = load("efs")
    raw = efs["cpnFixRat"].astype(float)
    efs["rate"] = raw.where(raw >= 1000, raw * 100) / 1e4
    efs = efs[(raw >= 100) & (efs["rate"] < 15)]
    efs["years"] = (pd.to_datetime(efs["swapEndDat"]) - pd.to_datetime(efs["swapStrtDat"])).dt.days / 365.25

    def trades(df, cols):
        return [
            {"t": r.ts.strftime("%Y-%m-%dT%H:%M:%S"), "c": r.contract, "x": r.expiry, "f": r.futPrc, "q": r.lots,
             **{k: (round(getattr(r, v), 4) if isinstance(getattr(r, v), float) else getattr(r, v)) for k, v in cols.items()}}
            for r in df.itertuples()
        ]

    data = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "days": sorted(set(efp["date"]) | set(efs["date"])),
        "efp": trades(efp, {"isin": "bondId", "cash": "cash"}),
        "efs": trades(efs, {"rate": "rate", "years": "years", "s": "swapStrtDat", "e": "swapEndDat"}),
    }
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    return len(data["efp"]), len(data["efs"]), data["days"]


if __name__ == "__main__":
    fetched = download()
    n_efp, n_efs, days = build()
    print(f"{datetime.now():%Y-%m-%d %H:%M} fetched {len(fetched)} files; "
          f"{n_efp} EFP / {n_efs} EFS trades over {len(days)} days ({days[0]}..{days[-1]})")
