# kouandco.github.io

Rates tools served at [seankou.com](https://seankou.com) by GitHub Pages: plain HTML and JavaScript
pages reading JSON files that a GitHub Action refreshes every weekday at 10:00 London time.

| Page | What it shows |
|------|---------------|
| `homepage.html` | Menu of the tools and a snapshot of generic yields (`index.html` redirects here) |
| `CTD.html` | Bond futures CTD model: CTD probabilities, fair futures and fair net basis from a parametric normal model; draggable generic curve with drift and vol per point; editable basket |
| `BMNT.html` | Bond monitor: every nominal UST, Bund, OAT and BTP with realised vol, 3m carry and roll down, editable repo, futures fly hedge and hedged returns |
| `EURX.html` | Eurex EFP gross basis and EFS invoice spreads, trade by trade |
| `FIHG.html` | DV01 hedge calculator with futures or bonds, single or fly |

## Layout

- `assets/`: shared theme (`terminal.css`), page frame and table helpers (`common.js`), bond maths
  (`bond.js`), futures model and hedge helpers (`futures.js`), the draggable curve (`curve-editor.js`)
  and one `page-*.js` per page.
- `data/`: everything the pages read. `markets/<UST|DE|FR|IT>.json` (bonds, curves, repo proxy, news),
  `futures.json` (front contracts and baskets), `eurex_trades.json`, `meta.json` (refresh status).
  `data/eurex/` archives Eurex's daily trade files (Eurex lists only ~20 days) and `data/history/`
  the TreasuryDirect yield history (queried one date at a time). Do not delete either.
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
