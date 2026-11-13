"""Build data/fx.json: ECB euro foreign exchange reference rates (daily, ~16:00 CET), last three years.

The ECB publishes the full history as one zipped CSV, units of each currency per euro. The risk pages
derive every cross from it (e.g. GBPUSD = USD per EUR / GBP per EUR), plus realised volatility and
correlation. AED is not published by the ECB; it is derived from USD at the UAE dirham's peg (3.6725).
"""

import io
import zipfile
from datetime import date, timedelta

import pandas as pd

from common import DATA, get, write_json

URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip"
KEEP = ("USD", "GBP", "JPY", "CHF", "SGD", "AUD")
AED_PEG = 3.6725
YEARS = 3


def build():
    raw = zipfile.ZipFile(io.BytesIO(get(URL).content))
    df = pd.read_csv(raw.open(raw.namelist()[0]), na_values=["N/A"])
    df = df.loc[:, ~df.columns.str.startswith("Unnamed")]
    df["Date"] = pd.to_datetime(df["Date"]).dt.date
    df = df.drop_duplicates("Date").sort_values("Date")
    df = df[df["Date"] >= date.today() - timedelta(days=round(365.25 * YEARS))]
    df = df.dropna(subset=["USD", "GBP"])
    if len(df) < 200:
        raise ValueError(f"only {len(df)} ECB fixings in the last {YEARS} years")
    rates = {c: [None if pd.isna(x) else round(float(x), 6) for x in df[c]] for c in KEEP}
    rates["AED"] = [round(x * AED_PEG, 6) for x in rates["USD"]]
    write_json(DATA / "fx.json", {
        "asOf": df["Date"].iloc[-1].isoformat(),
        "source": "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/",
        "note": "Units of currency per 1 EUR; AED derived from USD at the 3.6725 peg.",
        "dates": [d.isoformat() for d in df["Date"]],
        "perEUR": rates,
    })
    return len(df)


if __name__ == "__main__":
    print("ECB fixings:", build())
