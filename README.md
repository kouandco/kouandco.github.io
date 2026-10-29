# kouandco.github.io

Personal site served at [seankou.com](https://seankou.com) via GitHub Pages.

The homepage (`index.html`) is rendered from [`index.qmd`](index.qmd) with [Quarto](https://quarto.org/): the BTP–Bund spread chart on the left and commentary on the right. Data is pulled from FRED when the page is rendered.

## Updating the page

Edit the "My comment" section in `index.qmd`, then re-render and push:

```bash
export QUARTO_PYTHON=../.venv/bin/python   # needs pandas, plotly, requests, jupyter
quarto render index.qmd
git add -A && git commit -m "Update BTP-Bund page" && git push
```

Re-rendering also refreshes the chart with the latest data.

## CTD Monte Carlo page

`ctd.qmd` (model code in `ctd.js`) covers UST, Bund, OAT and BTP futures. Baskets, yields,
betas and vols live in `baskets.json`, built from TreasuryDirect, the Treasury par curve,
Eurex, Borsa Italiana, the Bundesbank and FRED. To refresh the data:

```bash
../.venv/bin/python build_baskets.py
quarto render ctd.qmd
git add -A && git commit -m "Refresh CTD data" && git push
```

`build_baskets.py` targets the December 2026 contracts (`UST_MONTH`, `EUREX_DELIVERY`);
roll those constants forward at each expiry.

## Eurex flow page

`eurex-flow.qmd` shows EFP basis trades against the CTD and 2nd CTD, EFS invoice spreads, and monthly
open interest, volume and positioning for DU, OE, RX, UB, OAT, BTS and IK.

EFP and EFS trades: `update_eurex_trades.py` archives Eurex's daily trade files in `../eurex_data/`
(Eurex only lists about 20 days) and rebuilds `eurex_trades.json`. The page reads that file on load,
so after an update only a commit and push is needed, no re-render. To run it hourly, install the
launchd job saved in `../eurex_data/com.seankou.eurex-trades.plist`.

Monthly open interest:
Eurex only keeps the latest five monthly statistics files online, so `build_eurex_flow.py` stores every
month it reads in `eurex_flow_history.csv`; run it each month (Eurex publishes early in the following month)
to keep extending the history:

```bash
../.venv/bin/python build_eurex_flow.py
quarto render eurex-flow.qmd
git add -A && git commit -m "Refresh Eurex flow" && git push
```
