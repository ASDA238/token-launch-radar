# Token Launch Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ASDA238/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ASDA238/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

Which protocol with no token recorded is worth farming next — and what to do about it.

Built for the [make.fun "Build the best token launch radar" bounty](https://make.fun/bounty/token-radar-01).

## What it does

`main.ts` (Node 22, standard library only) reads the sealed DefiLlama snapshot
(`input/snapshot.json`: 758 protocols, 40 on the watchlist), fits an implied-value
model on the snapshot's own live-token peers, and ranks 200 pre-token protocols
by what their launch would be worth.

- **Value model, fitted at run time, nothing hardcoded by name:** fitted FDV =
  exp(6.965 + 0.522 × ln TVL), a log-log OLS fit on the 128 live-token peers.
  Growth and age tilts are small and capped; launch odds come from the peers'
  record by age bucket and category.
- **Blind-test results** (recomputed at run time and shown on the dashboard):
  leave-one-out mean |log error| 1.596, median 1.224, 32% within 2×;
  walk-forward median 1.151. The starter's flat 0.25× multiple scores worse
  (mean 1.768) and is not used.
- **Farm plans:** 7 concrete steps per protocol with costs and times, sized
  from its TVL and chain.
- **Dashboard:** sortable/filterable board, a detail view for every protocol,
  the model card with validation numbers, and the live-token protocols shown
  separately as an already-trading reference.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` into the output directory. Runs are deterministic:
two runs write byte-identical output.
