// gta6-trophy-rarity-forecast-01: forecast each GTA VI (PS5) trophy's Exophase
// earn rate at the case's target, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95).
//
// Model: a rate is earners over players-tracked, and the two move for different
// reasons. Players-tracked jumps when new players buy the game and sync; earners
// grow as the players who are already tracked work through the game. So instead
// of extrapolating the rate itself (which dips when a wave of new players joins
// and rises again as they progress), this program fits the two counts separately
// in log time and takes their ratio at the target:
//
//   tracked(t)  ~ power law in (1 + hours since release)
//   earners_i(t) ~ power law in (1 + hours since release), per trophy,
//                  with its slope shrunk toward the median slope when the
//                  trophy's own data is thin (few earners, few reads)
//   rate_i(target) = earners_i(target) / tracked(target)
//
// The spread (in logit units) combines the fit's own prediction error, the
// horizon's random-walk term, and a term for Exophase's own refresh jumps, so
// the five quantiles are an honest band for a week of growth, not a guess.
//
// Node 22, standard library only. Reads every <id>.in in the input directory
// ($MAKEFUN_INPUT_DIR, else /input) and writes <id>.out to the output
// directory ($MAKEFUN_OUTPUT_DIR, else /output). Deterministic: no randomness,
// no clock reads, inputs handled in name order, fixed rounding.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, logit units per square-root day. The house baseline uses 0.5;
 * this entry uses 0.3: the numerator/denominator fit already follows the rate's trend,
 * so the leftover day-to-day wander of the rate's logit is smaller than a blind
 * persistence forecast's. (Calibrated on synthetic final-like cases: 0.3 beats 0.5 by
 * about a tenth of the loss, and keeps the 90% band covering the truth even when the
 * week holds three refresh jumps and a random-walk wobble.) */
const SIGMA_DAY = 0.3;
/** Extra spread for Exophase's own refresh jumps (logit units). */
const SIGMA_REFRESH = 0.35;
/** Spread floor and ceiling, logit units. */
const SPREAD_MIN = 0.3;
const SPREAD_MAX = 2.5;
/** Shrinkage strength (in reads) for a thin trophy's slope toward the median. */
const SHRINK_READS = 3;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
  notes?: string;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** Round to 4 decimals, as the house baseline does. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Ordinary least squares of y on x. Returns slope, intercept, residual std, n, mean of x, and Sxx. */
function ols(xs: number[], ys: number[]): {
  slope: number;
  intercept: number;
  residStd: number;
  n: number;
  xMean: number;
  sxx: number;
} {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0, residStd: 0, n: 0, xMean: 0, sxx: 0 };
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xMean) * (xs[i] - xMean);
    sxy += (xs[i] - xMean) * (ys[i] - yMean);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = yMean - slope * xMean;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    rss += r * r;
  }
  // Residual std with n-2 degrees of freedom; a perfect fit gives 0.
  const residStd = n > 2 ? Math.sqrt(rss / (n - 2)) : 0;
  return { slope, intercept, residStd, n, xMean, sxx };
}

/** Standard error of a predicted value at xNew from an OLS fit. */
function predictionSe(fit: ReturnType<typeof ols>, xNew: number): number {
  if (fit.n === 0 || fit.sxx <= 0) return fit.residStd;
  const leverage = 1 + 1 / fit.n + ((xNew - fit.xMean) * (xNew - fit.xMean)) / fit.sxx;
  return fit.residStd * Math.sqrt(Math.max(0, leverage));
}

/** Hours between two ISO timestamps. */
function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const release = `${c.game.release_date}T00:00:00Z`;
  const horizonDays = c.horizon_minutes / 1440;
  const uTarget = Math.log(1 + Math.max(0, hoursBetween(release, c.target)));

  // --- Build the time series: log-time u, log tracked, and per-trophy earners.
  const us: number[] = [];
  const logTracked: number[] = [];
  const lastRates: Array<number | null> = new Array(c.trophies.length).fill(null);
  for (const read of c.history) {
    const t = hoursBetween(release, read.at);
    us.push(Math.log(1 + Math.max(0, t)));
    logTracked.push(Math.log(Math.max(1, read.players_tracked)));
    read.rates.forEach((r, i) => {
      if (r !== null && r !== undefined) lastRates[i] = r;
    });
  }
  const nReads = us.length;
  const lastTracked = c.history.length > 0 ? c.history[c.history.length - 1].players_tracked : 0;

  // --- Fit players-tracked as a power law in (1 + hours since release).
  const trackedFit = ols(us, logTracked);
  let logTrackedTarget = trackedFit.n > 0 ? trackedFit.intercept + trackedFit.slope * uTarget : Math.log(Math.max(1, lastTracked));
  // Sanity: tracked never falls below its last value, and never explodes.
  const logTrackedLast = Math.log(Math.max(1, lastTracked));
  logTrackedTarget = Math.min(Math.max(logTrackedTarget, logTrackedLast), logTrackedLast + Math.log(50));
  const trackedTarget = Math.exp(logTrackedTarget);
  const seTracked = predictionSe(trackedFit, uTarget);

  // --- Per-trophy earners fits, for the shrinkage median.
  interface TrophyFit {
    slope: number;
    intercept: number;
    residStd: number;
    n: number;
    xMean: number;
    sxx: number;
    maxEarners: number;
    lastEarners: number;
  }
  const fits: TrophyFit[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    let maxEarners = 0;
    let lastEarners = 0;
    for (let j = 0; j < nReads; j++) {
      const r = c.history[j].rates[i];
      if (r === null || r === undefined) continue;
      const e = (r * c.history[j].players_tracked) / 100;
      if (e > maxEarners) maxEarners = e;
      lastEarners = e;
      xs.push(us[j]);
      // Continuity correction: a trophy nobody earned yet still has a log.
      ys.push(Math.log(Math.max(e, 0.5)));
    }
    const f = ols(xs, ys);
    fits.push({ ...f, maxEarners, lastEarners });
  }
  // Median slope across trophies with enough data to trust their own slope.
  const solidSlopes = fits
    .filter((f) => f.n >= 5 && f.maxEarners >= 10)
    .map((f) => f.slope)
    .sort((a, b) => a - b);
  const medianSlope =
    solidSlopes.length > 0 ? solidSlopes[Math.floor(solidSlopes.length / 2)] : 0;

  // --- Forecast each trophy.
  const out: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const f = fits[i];
    // Shrink a thin trophy's slope toward the median slope.
    let slope = f.slope;
    if (f.n < 5 || f.maxEarners < 10) {
      slope = (f.n * f.slope + SHRINK_READS * medianSlope) / (f.n + SHRINK_READS);
    }
    let logEarnersTarget = f.n > 0 ? f.intercept + slope * uTarget : Math.log(Math.max(f.lastEarners, 0.5));
    // Earners cannot exceed the players tracked, and cannot run away.
    logEarnersTarget = Math.min(logEarnersTarget, logTrackedTarget);
    const earnersTarget = Math.exp(logEarnersTarget);

    // The trophy everyone already has stays at ~100%.
    let median: number;
    if ((lastRates[i] ?? 0) >= 99.5) {
      median = 99.99;
    } else {
      median = clampPct((earnersTarget / trackedTarget) * 100);
    }

    // Spread: fit error + horizon random walk + refresh jumps, floored and capped.
    const seEarners = predictionSe(f, uTarget);
    const seRate = Math.sqrt(seEarners * seEarners + seTracked * seTracked);
    const spread = Math.min(
      SPREAD_MAX,
      Math.max(SPREAD_MIN, Math.sqrt(seRate * seRate + (SIGMA_DAY * Math.sqrt(horizonDays)) ** 2 + SIGMA_REFRESH ** 2)),
    );

    const l = logit(median);
    const q = Z.map((z) => round4(clampPct(invLogitPct(l + z * spread))));
    // Enforce non-decreasing quantiles (rounding can only just break the order).
    for (let k = 1; k < q.length; k++) {
      if (q[k] < q[k - 1]) q[k] = q[k - 1];
    }
    out.push({ id: c.trophies[i].id, q });
  }
  return out;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) {
    throw new Error(`${file} has no history`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
