---
name: workflow-spreadsheet-model
description: Build or review a spreadsheet model with clean inputs, formulas, scenarios, checks and a summary. Use for budgets, forecasts, pricing and operational models.
---

# Spreadsheet model

## Structure
- Separate Inputs, Calculations and Outputs. Put one assumption per input cell.
- Name ranges for key drivers; keep formulas short and consistent.
- Decide the time grain and units before building.

## Build
- Every calculated cell should trace to inputs; no hardcoded numbers in formulas.
- Add a checks block: balance, totals, units and scenario switches.
- Build scenarios with one switch, not copied sheets.
- Label units, dates and sources.

## Verify
- Recalculate the whole workbook and spot-check by hand.
- Test zero, negative, missing and extreme inputs.
- Use the project's spreadsheet tooling to read values back; do not trust a stale formula cache.

## Deliver
- A short summary of drivers, scenarios and limitations. If a file is requested, deliver the workbook and state how to change the inputs.
