# kouandco.github.io

Rates tools served at [seankou.com](https://seankou.com) by GitHub Pages: plain HTML and JavaScript
pages reading JSON files that a GitHub Action refreshes every weekday at 10:00 London time.

| Page | What it shows |
|------|---------------|
| `homepage.html` | Menu of the tools and generic yields from the actual benchmark bonds (`index.html` redirects here) |
| `CTD.html` | Bond futures CTD model: CTD probabilities, fair futures and fair net basis from a parametric normal model; draggable generic curve with drift and vol per point; editable basket, bonds can be added |
| `BMNT.html` | Bond monitor: every nominal UST, Bund, OAT and BTP with realised vol, 3m carry and roll down, editable repo curve with boxing premium, futures fly hedge and hedged returns, recent and upcoming auctions |
| `EURX.html` | Eurex EFP gross basis and EFS invoice spreads, trade by trade |
| `FIHG.html` | DV01 hedge calculator with futures or bonds, single or fly |
| `GP.html` | History of bond yields, prices and asset swap spreads, generic yields, swap rates, Eurex futures, gross basis, invoice spreads and WIRP pricing; formulas over the series (spreads, flies), line chart, scatter with OLS regression, rolling and matrix correlation |
| `WIRP.html` | Fed, ECB and BoE moves priced meeting by meeting by the OIS curves |
| `IRS.html` | USD and EUR swap pricer on the Eurex Clearing curves: NPV, par rate, PV01, DV01, cashflows; every field two-way, editable par swap curve |
| `TEST.html` | Backtest of trades of up to 5 legs (bond, ASW, futures, IRS) from a start date: notional or DV01 sizing, repo and haircut, entry / target / stop / holding period; cash P&L, return on capital and on balance sheet. Trades kept in the browser (export / import JSON) |
| `BLOT.html` | Portfolio key-rate risk (1–30Y) on the government curve, swap curve and ASW, plus futures gross basis per contract: ΔV for 1bp in one point with everything else unchanged |

### Risk advisory pages (`/risk`, not linked from the homepage)

| Page | What it shows |
|------|---------------|
| `risk/index.html` | Menu, par swap rates (SONIA, 6M Euribor, €STR, SOFR), forward curves, FX spot / vol / forwards |
| `risk/HSWP.html` | Debt hedging strategy: amortising project loan (sculpted, annuity, linear, bullet), swap / cap / zero-cost collar / mix priced on the curves, simulated all-in cost, DSCR lock-up risk, MTM at ±100bp |
| `risk/RFP.html` | Execution: mid of the amortising swap or cap, fair credit charge (CVA + capital), bank quotes vs mid, pro-rata or competitive allocation, checklist, transparency note |
| `risk/FXHG.html` | Fund FX hedging: hedge ratio vs FX vol and carry, roll liquidity stress, fund IRR distribution and cumulative settlements |

Their code is in `assets/risk/`; they read `data/curves.json` and `data/fx.json`.

## Data sources

| Data | Source | Updated |
|------|--------|---------|
| UST prices | TreasuryDirect FedInvest end-of-day prices; original terms from TreasuryDirect auction records | daily, previous US business day |
| Bund prices and yields | Bundesbank prices and yields of listed Federal securities | daily |
| OAT and BTP prices | Borsa Italiana MOT / EuroMOT closing prices | daily, previous close |
| Swap curves (SOFR, Fed funds, €STR, 6M Euribor, SONIA) | Eurex Clearing (EurexOTC Clear) daily settlement curves | daily, previous close |
| Policy rates | NY Fed (EFFR, target range), ECB Data Portal (deposit rate, €STR), Bank of England database (Bank Rate, SONIA) | daily |
| Meeting dates | federalreserve.gov, ecb.europa.eu, bankofengland.co.uk | on each refresh |
| Repo proxy | NY Fed SOFR and Treasury bill curve; ECB €STR and AAA government spot curve | daily |
| Eurex baskets and conversion factors | Eurex notified deliverable bonds file | on each refresh |
| Eurex EFP and EFS trades | Eurex trading files (EFP-Fin, EFS) | daily |
| Auctions | TreasuryDirect, Finanzagentur, MEF; France from AFT's standing calendar | daily |
| FX reference rates (USD, GBP, JPY, CHF, SGD, AUD; AED from the USD peg) | ECB euro foreign exchange reference rates | daily |

## Layout

- `assets/`: shared theme (`terminal.css`), page frame and table helpers (`common.js`), bond maths
  (`bond.js`), instruments, risk and history for TEST / BLOT (`positions.js`), futures model and hedge helpers (`futures.js`), the draggable curve (`curve-editor.js`)
  and one `page-*.js` per page.
- `data/`: everything the pages read. `markets/<UST|DE|FR|IT>.json` (bonds with ASW, benchmarks, curves, repo proxy),
  `futures.json` (front contracts and baskets), `auctions.json` (recent and upcoming auctions and syndications), `eurex_trades.json`,
  `curves.json` (OIS and IBOR discount factors), `wirp.json` (policy pricing), `gp/` (histories for the GP page), `meta.json` (refresh status).
  `data/eurex/` archives Eurex's daily trade files (Eurex lists only ~20 days) and `data/history/`
  the yield histories (UST is queried one date at a time; Bund, OAT and BTP sources serve only months),
  the archived ASW, par swap rates (1–30Y, used by TEST), policy pricing and Eurex conversion factors, none of which the sources
  keep. Do not delete either.
- `scripts/`: the Python builders. `refresh.py` runs them all; each step that fails keeps its previous
  file and is flagged in the site's status bar.

## Refreshing data

The `Refresh data` workflow (`.github/workflows/refresh.yml`) runs on weekdays and commits the new
data. To run it by hand: Actions → Refresh data → Run workflow, or locally:

```bash
pip install -r scripts/requirements.txt
python scripts/refresh.py          # or: python scripts/markets.py DE   (one market)
```

To preview locally, serve the folder (pages load JSON, so `file://` will not work):

```bash
python -m http.server 8000         # then open http://localhost:8000/homepage.html
```

Front futures contracts roll automatically (UST before the delivery month, Eurex two business days
before delivery).
