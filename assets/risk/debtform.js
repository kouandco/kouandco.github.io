// The loan and hedge inputs shared by HSWP and RFP.

import { el } from "../common.js";
import { field } from "./common.js";
import { INDICES, addMonths, buildDebt, curveFor, levelDebtService, parse } from "./rates.js";

export const DEBT_DEFAULTS = {
  ccy: "GBP", notional: 500, start: null, constrMonths: 24, tenorYears: 18, freq: 6, amort: "sculpted", balloon: 0,
  margin: 225, cfads: null, growth: 2.5, hedgeRatio: 75, hedgeYears: 20,
};

export const AMORTS = [
  { v: "sculpted", label: "Sculpted to CFADS" }, { v: "annuity", label: "Annuity (level DS)" },
  { v: "linear", label: "Linear" }, { v: "bullet", label: "Bullet" },
];

// Group of fields: currency and loan, then repayment, then hedge. `extra` adds fields to the hedge group.
export function debtForm(state, onChange, extra = []) {
  // A CFADS the page sized itself (cfadsAuto) is resized when the loan changes; one typed in is kept.
  const on = (k) => {
    if (k === "ccy") { state.vol = null; state.capK = null; }
    if (k === "cfads") state.cfadsAuto = state.cfads == null;
    if (["ccy", "notional", "constrMonths", "tenorYears", "freq", "margin", "balloon"].includes(k) && state.cfadsAuto) state.cfads = null;
    onChange(k);
  };
  return el("div", {},
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Loan"),
      el("div", { class: "form" },
        field("Currency / index", state, "ccy", on, { options: Object.values(INDICES).map((i) => ({ v: i.ccy, label: `${i.ccy} ${i.label}` })) }),
        field("Notional (mm)", state, "notional", on, { step: 10 }),
        field("First drawdown", state, "start", on, { kind: "date" }),
        field("Construction (m)", state, "constrMonths", on, { step: 6, title: "Debt drawn evenly over construction; no repayment until operations start" }),
        field("Repayment (y)", state, "tenorYears", on, { step: 1 }),
        field("Periods", state, "freq", on, { options: [{ v: 3, label: "Quarterly" }, { v: 6, label: "Semi-annual" }] }),
        field("Margin (bp)", state, "margin", on, { step: 5 }))),
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Repayment and cash flow"),
      el("div", { class: "form" },
        field("Amortisation", state, "amort", on, { options: AMORTS }),
        field("Balloon (%)", state, "balloon", on, { step: 5 }),
        field("CFADS yr 1 (mm)", state, "cfads", on, { step: 1, title: "Cash flow available for debt service in the first year of operations. Blank: sized for a 1.35x DSCR on a level annuity" }),
        field("CFADS growth (%/y)", state, "growth", on, { step: 0.5, title: "e.g. RPI/CPI indexation of revenues" }))),
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Hedge"),
      el("div", { class: "form" },
        field("Hedge ratio (%)", state, "hedgeRatio", on, { step: 5 }),
        field("Hedge tenor (y)", state, "hedgeYears", on, { step: 1, title: "Years from first drawdown; debt beyond this is left floating" }),
        ...extra)));
}

// Debt profile and hedged notionals (before the hedge ratio) for the state on market mkt.
export function debtFor(state, mkt) {
  const c = curveFor(mkt, state.ccy);
  if (!state.start) state.start = mkt.spot.toISOString().slice(0, 10);
  if (state.cfads == null) {
    state.cfadsAuto = true;
    const level = buildDebt({ ...state, amort: "annuity", cfads: 0 }, c);
    state.cfads = Math.round((levelDebtService(level) * 1.35) / 1e5) / 10;
  }
  const debt = buildDebt(state, c);
  const end = addMonths(parse(state.start), Math.round(state.hedgeYears * 12));
  const base = debt.per.map((q) => (q.e <= new Date(end.getTime() + 7 * 864e5) ? q.out : 0));
  return { c, debt, base };
}
