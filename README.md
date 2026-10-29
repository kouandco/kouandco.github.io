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
