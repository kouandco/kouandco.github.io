"""Archive Eurex EFP-Fin and EFS trade files and build data/eurex_trades.json.

Eurex only lists the last ~20 trading days of trade files, so every file is kept in
data/eurex/<kind>/. The latest two days are re-downloaded on each run because the current
day's file grows during the session.

Scaling (Eurex trade file format): futures price has 3 implied decimals for FGBS, FGBM
and FBTS and 2 for the other bond futures; cash price has 4; nominal is in thousands. The
swap fixed rate mostly has 4 implied decimals (34884 = 3.4884%), but some rows are
written with 2 and a decimal point (320.96 = 3.2096%); anything else is dropped.
"""

import re
from datetime import datetime, timezone

import pandas as pd

from common import DATA, get, write_json

ARCHIVE = DATA / "eurex"
PAGES = {"efpf": "https://www.eurex.com/ex-en/data/trading-files/efpf",
         "efs": "https://www.eurex.com/ex-en/data/trading-files/efs"}
PRODUCTS = {"FGBS": "DU", "FGBM": "OE", "FGBL": "RX", "FGBX": "UB", "FOAT": "OAT", "FBTS": "BTS", "FBTP": "IK"}
FUT_DECIMALS = {"FGBS": 3, "FGBM": 3, "FBTS": 3}


def download():
    fetched = []
    for kind, page in PAGES.items():
        folder = ARCHIVE / kind
        folder.mkdir(parents=True, exist_ok=True)
        html = get(page).text
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
            path.write_bytes(get(url).content)
            fetched.append(path.name)
    return fetched


def load(kind):
    df = pd.concat(pd.read_csv(f, sep=";", dtype=str) for f in sorted((ARCHIVE / kind).glob(f"{kind}*.csv")))
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


def trades(df, cols):
    return [
        {"t": r.ts.strftime("%Y-%m-%dT%H:%M:%S"), "c": r.contract, "x": r.expiry, "f": r.futPrc, "q": r.lots,
         **{k: (round(getattr(r, v), 4) if isinstance(getattr(r, v), float) else getattr(r, v)) for k, v in cols.items()}}
        for r in df.itertuples()
    ]


def build():
    fetched = download()
    efp = load("efpf")
    efp["cash"] = efp["cashPrc"].astype(float) / 1e4
    # EFPs against bonds only (some reference another futures contract instead of an ISIN).
    efp = efp[(efp["cash"] > 0) & efp["bondId"].str.match(r"^[A-Z]{2}[0-9A-Z]{9}\d$") & ~efp["bondId"].str.startswith("EUREX")]
    efs = load("efs")
    raw = efs["cpnFixRat"].astype(float)
    efs["rate"] = raw.where(raw >= 1000, raw * 100) / 1e4
    efs = efs[(raw >= 100) & (efs["rate"] < 15)]
    data = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "days": sorted(set(efp["date"]) | set(efs["date"])),
        "efp": trades(efp, {"isin": "bondId", "cash": "cash"}),
        "efs": trades(efs, {"rate": "rate", "s": "swapStrtDat", "e": "swapEndDat"}),
    }
    write_json(DATA / "eurex_trades.json", data)
    print(f"Eurex: fetched {len(fetched)} files; {len(data['efp'])} EFP / {len(data['efs'])} EFS trades "
          f"over {len(data['days'])} days ({data['days'][0]}..{data['days'][-1]})")


if __name__ == "__main__":
    build()
