"""Build data/cftc.json: CFTC Commitments of Traders positioning in Treasury futures, weekly since 2006.

Source: CFTC Public Reporting Environment, Traders in Financial Futures (TFF), futures only (dataset gpe5-46if,
https://publicreporting.cftc.gov). Positions are as of Tuesday's close and published on Friday at 15:30 New York
(20:30 London), so the Friday 23:30 London refresh picks up the new week; earlier runs keep the last report.

Traders are grouped by the CFTC as dealers / intermediaries, asset managers / institutional, leveraged funds,
other reportables, and non-reportable (small) positions. Long and short exclude spread positions, which are
equal on both sides, so net = long − short.

Outputs: data/cftc.json (CFTC page) and data/gp/cftc.json (net positions in contracts, GP page).
"""

from datetime import datetime, timezone

from common import DATA, get, write_json

URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
CONTRACTS = {  # CME code: CFTC contract market code, name
    "TU": ("042601", "2-Year T-Note"),
    "FV": ("044601", "5-Year T-Note"),
    "TY": ("043602", "10-Year T-Note"),
    "UXY": ("043607", "Ultra 10-Year T-Note"),
    "US": ("020601", "T-Bond"),
    "WN": ("020604", "Ultra T-Bond"),
}
GROUPS = {  # key: label, CFTC long field, short field, traders long, traders short
    "asset": ("Asset managers", "asset_mgr_positions_long", "asset_mgr_positions_short", "traders_asset_mgr_long_all", "traders_asset_mgr_short_all"),
    "lev": ("Leveraged funds", "lev_money_positions_long", "lev_money_positions_short", "traders_lev_money_long_all", "traders_lev_money_short_all"),
    "dealer": ("Dealers", "dealer_positions_long_all", "dealer_positions_short_all", "traders_dealer_long_all", "traders_dealer_short_all"),
    "other": ("Other reportables", "other_rept_positions_long", "other_rept_positions_short", "traders_other_rept_long_all", "traders_other_rept_short"),
    "nonrep": ("Non-reportables", "nonrept_positions_long_all", "nonrept_positions_short_all", None, None),
}


def build():
    codes = {v[0]: k for k, v in CONTRACTS.items()}
    fields = ["report_date_as_yyyy_mm_dd", "cftc_contract_market_code", "open_interest_all"]
    fields += [f for g in GROUPS.values() for f in g[1:] if f]
    where = "cftc_contract_market_code in (" + ",".join(f"'{c}'" for c in codes) + ")"
    rows = get(URL, params={"$select": ",".join(fields), "$where": where, "$order": "report_date_as_yyyy_mm_dd", "$limit": 50000},
               timeout=120).json()
    if not rows:
        raise RuntimeError("no CFTC rows")
    num = lambda r, f: int(float(r.get(f) or 0)) if f else None
    out = {}
    for r in rows:
        code = codes[r["cftc_contract_market_code"]]
        c = out.setdefault(code, {"name": CONTRACTS[code][1], "cftc": CONTRACTS[code][0], "dates": [], "oi": [],
                                  **{g: {"long": [], "short": [], "tLong": [], "tShort": []} for g in GROUPS}})
        c["dates"].append(r["report_date_as_yyyy_mm_dd"][:10])
        c["oi"].append(num(r, "open_interest_all"))
        for g, (_, lf, sf, tl, ts) in GROUPS.items():
            c[g]["long"].append(num(r, lf))
            c[g]["short"].append(num(r, sf))
            c[g]["tLong"].append(num(r, tl))
            c[g]["tShort"].append(num(r, ts))
    as_of = max(c["dates"][-1] for c in out.values())
    write_json(DATA / "cftc.json", {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "https://publicreporting.cftc.gov/stories/s/r4w3-av2u",
        "asOf": as_of,
        "groups": {g: v[0] for g, v in GROUPS.items()},
        "contracts": {k: out[k] for k in CONTRACTS if k in out},
    })
    # GP: net positions (contracts) by contract and group, on the union of report dates.
    dates = sorted({d for c in out.values() for d in c["dates"]})
    series = {}
    for code, c in out.items():
        at = dict(zip(c["dates"], range(len(c["dates"]))))
        for g, (label, *_rest) in GROUPS.items():
            series[f"{code} {label} net"] = [c[g]["long"][at[d]] - c[g]["short"][at[d]] if d in at else None for d in dates]
        series[f"{code} open interest"] = [c["oi"][at[d]] if d in at else None for d in dates]
    write_json(DATA / "gp" / "cftc.json", {"dates": dates, "series": series})
    ty = out["TY"]
    print(f"CFTC: {len(rows)} rows, {len(out)} contracts, {dates[0]}..{as_of}; TY leveraged funds net "
          f"{ty['lev']['long'][-1] - ty['lev']['short'][-1]:,}, asset managers net {ty['asset']['long'][-1] - ty['asset']['short'][-1]:,}")


if __name__ == "__main__":
    build()
