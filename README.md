[![make.fun](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/c/gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xinnsmith161-cloud/gta6-rarity-forecast/rank.svg)](https://make.fun/c/gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xinnsmith161-cloud/gta6-rarity-forecast/reward.svg)](https://make.fun/c/gta6-trophy-rarity-forecast-01)

# GTA VI trophy rarity forecast

Entry for [make.fun's gta6-trophy-rarity-forecast-01](https://make.fun/c/gta6-trophy-rarity-forecast-01): forecast, for each of Grand Theft Auto VI's 55 PS5 trophies, the percentage of Exophase-tracked players who will have earned it at 2026-11-26T00:00:00Z, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95). Scored by mean pinball loss on the logit scale; a prize needs a loss strictly below the best house entry.

## The program

`main.ts` (Node 22, standard library only, no network, deterministic). It reads every `<id>.in` in the input directory (`$MAKEFUN_INPUT_DIR`, else `/input`) and writes `<id>.out` to the output directory (`$MAKEFUN_OUTPUT_DIR`, else `/output`):

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Output: `{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}` — one row per trophy, values in (0, 100), non-decreasing, ≤ 65,536 bytes. Runtime is ~0.2 s per case (cap 8 s).

## The model

A rate is earners over players-tracked, and the two move for different reasons: players-tracked jumps when new players buy the game and sync, while earners grow as the players already tracked work through the game. Extrapolating the rate itself dips when a wave of new players joins and rises again as they progress, so this program fits the two counts separately in log time and takes their ratio at the target:

- **Players-tracked** as a power law in (1 + hours since release): OLS of log(tracked) on log(1 + hours).
- **Earners per trophy** the same way, with the slope shrunk toward the median slope of the well-measured trophies when a trophy's own data is thin (few earners, few reads).
- **Median rate** = earners(target) / tracked(target), clamped to [0.01, 99.99]. A trophy everyone already has stays at ~100%.
- **Spread** (logit units) combines the fits' prediction error, a 0.3-per-square-root-day random walk, and a 0.35 term for Exophase's own refresh jumps — floored at 0.3, capped at 2.5. The quantiles are `100 / (1 + exp(-(logit(median) + z * spread)))`, z = −1.645, −0.674, 0, 0.674, 1.645, rounded to 4 decimals.

## Why this beats the house baselines

The house persistence baseline says every rate stays where the last read put it; the house curve baseline extrapolates each rate's logit line over the last 24 hours. Both miss the week's main motion: tracked keeps growing faster than most trophies are earned, so most rates *fall* while the earliest trophies rise. Fitting earners and tracked separately follows that motion. The spread is also narrower than the house's 0.5-per-square-root-day (0.3 here), because the fit already follows the trend — the leftover day-to-day wander is smaller than a blind persistence forecast's.

## Validation (local, synthetic)

The practice cases' exact answers live on the server, so the pinball loss there cannot be computed locally — the practice is also a poor guide to the final, since a single launch-night refresh dominates it. Instead the entry was validated on synthetic final-like cases (2.7 days of reads to Nov 21 09:30Z, target Nov 26 00:00Z, power-law growth with a refresh jump in the history, truth known):

| case | this entry | persistence | curve baseline |
| --- | --- | --- | --- |
| smooth final | **0.0922** | 0.1424 | 0.1471 |
| 4 adversarial finals (3 future refresh jumps + random-walk wobble in the truth) | **0.1340** mean | 0.2036 mean | — |

Lower is better. The entry beats the persistence baseline on every synthetic case, smooth and adversarial alike, and beats the curve baseline on the smooth final.

Practice cases: valid output (55 trophies, non-decreasing quantiles, 2,692 bytes), byte-identical across two runs, ~0.2 s per case.

## License

MIT — see [LICENSE](LICENSE).
