// FX from the ECB reference rates (units per EUR): crosses, realised vol and correlation, and forwards
// by covered interest parity off the OIS curves (cross-currency basis ignored).

import { loadJSON } from "../common.js";
import { addMonths, addBusinessDays, parse } from "./rates.js";

export const CCY_CURVE = { USD: "USD.SOFR.1D", EUR: "EUR.ESTR.1D", GBP: "GBP.SONIA.1D" };
export const SYM = { USD: "$", EUR: "€", GBP: "£" };

export async function loadFX() {
  const d = await loadJSON("../data/fx.json");
  const per = { EUR: d.dates.map(() => 1), ...d.perEUR };
  return { asOf: d.asOf, dates: d.dates, per };
}

// Price of 1 unit of `ccy` in `base` on each date (e.g. ccy GBP, base USD → GBPUSD).
export function series(fx, ccy, base) {
  return fx.dates.map((_, i) => {
    const a = fx.per[base][i], b = fx.per[ccy][i];
    return a == null || b == null ? null : a / b;
  });
}
export const last = (s) => { for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]; return null; };

// Daily log returns over the last `days` fixings, aligned across series (dates where all are present).
export function returns(list, days = 260) {
  const n = list[0].length, out = list.map(() => []);
  for (let i = Math.max(1, n - days); i < n; i++) {
    if (list.every((s) => s[i] != null && s[i - 1] != null)) list.forEach((s, k) => out[k].push(Math.log(s[i] / s[i - 1])));
  }
  return out;
}
const ANN = 260;   // ECB fixings a year
export function vol(r) {
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt((r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * ANN);
}
export function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

// Outright forward of 1 unit of ccy in base for `months`, from spot S: F = S · DF_ccy(T) / DF_base(T).
export function forward(mkt, S, ccy, base, months) {
  const spot = addBusinessDays(mkt.asOf, 2), end = addMonths(spot, months);
  const df = (c, d) => mkt.curves[CCY_CURVE[c]](d);
  return S * (df(ccy, end) / df(ccy, spot)) / (df(base, end) / df(base, spot));
}
export const fxDate = (fx) => parse(fx.asOf);
