// Teste si l'Elo (et la tendance, la forme, les écarts récents...) permet de prédire les prochains matchs.
// Usage : BACKTEST=1 node build-euroleague.js   puis   node backtest.js
//
// Règle d'honnêteté : chaque pronostic n'utilise que ce qu'on savait AVANT le match. Les réglages sont appris
// sur les saisons 2005-06 à 2020-21, puis testés sur 2021-22 à 2025-26, que le modèle n'a jamais vues.
import { readFile, writeFile } from 'node:fs/promises';

const rows = JSON.parse(await readFile('data/backtest-features.json', 'utf8'));
const TRAIN = (s) => s >= 'E2005' && s <= 'E2020';
const TEST = (s) => s >= 'E2021' && s <= 'E2025';
const CURRENT = (s) => s === 'E2026';

// ---- Elo d'équipe « classique » : uniquement les résultats, comme aux échecs (sert de point de comparaison) ----
function teamElo(rows, { k, home, carry }) {
  const r = new Map(); let season = null;
  for (const g of rows) {
    if (g.season !== season) { season = g.season; for (const [c, v] of r) r.set(c, 1500 + (v - 1500) * carry); }
    const h = r.get(g.home.code) ?? 1500, a = r.get(g.away.code) ?? 1500;
    g.classic = h - a;
    const exp = 1 / (1 + 10 ** (-(h + home - a) / 400));
    const diff = g.hs - g.as, won = diff > 0 ? 1 : 0;
    const mov = Math.log(Math.abs(diff) + 1) * 2.2 / ((won ? h + home - a : a - h - home) * 0.001 + 2.2);
    const d = k * mov * (won - exp);
    r.set(g.home.code, h + d); r.set(g.away.code, a - d);
  }
}
let bestClassic = null;
for (const k of [10, 15, 20, 25, 30]) for (const carry of [0.5, 0.65, 0.8, 1]) {
  teamElo(rows, { k, home: 60, carry });
  const ll = rows.filter((g) => TRAIN(g.season)).reduce((s, g) => {
    const p = 1 / (1 + 10 ** (-(g.classic + 60) / 400)); return s - Math.log(g.hs > g.as ? p : 1 - p);
  }, 0);
  if (!bestClassic || ll < bestClassic.ll) bestClassic = { k, carry, ll };
}
teamElo(rows, { k: bestClassic.k, home: 60, carry: bestClassic.carry });

// ---- Les indices disponibles avant le match (équipe à domicile moins équipe à l'extérieur) ----
const v = (x, d) => (x == null || Number.isNaN(x) ? d : x);
const FEATURES = {
  eloJoueurs: (g) => v(g.home.strength, 1500) - v(g.away.strength, 1500),
  tendance: (g) => v(g.home.trend, 0) - v(g.away.trend, 0),
  forme5: (g) => v(g.home.form5, 0.5) - v(g.away.form5, 0.5),
  ecart5: (g) => v(g.home.diff5, 0) - v(g.away.diff5, 0),
  ecart10: (g) => v(g.home.diff10, 0) - v(g.away.diff10, 0),
  repos: (g) => Math.min(10, v(g.home.rest, 7)) - Math.min(10, v(g.away.rest, 7)),
  eloEquipe: (g) => g.classic,
  playoffs: (g) => (['PO', 'FF', 'PI'].includes(g.round) ? 1 : 0),
};
const usable = rows.filter((g) => g.home.strength != null && g.away.strength != null);

// Régression logistique (probabilité de victoire à domicile) et linéaire (écart de points), sans librairie.
function fit(train, names, { logistic }) {
  const X = train.map((g) => names.map((n) => FEATURES[n](g)));
  const y = train.map((g) => (logistic ? (g.hs > g.as ? 1 : 0) : g.hs - g.as));
  const mu = names.map((_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const sd = names.map((_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((xj, j) => (xj - mu[j]) / sd[j]));
  let w = names.map(() => 0), b = 0;
  const lr = logistic ? 0.5 : 0.05;
  for (let it = 0; it < 3000; it++) {
    const gw = w.map(() => 0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const z = b + Z[i].reduce((s, zj, j) => s + zj * w[j], 0);
      const err = (logistic ? 1 / (1 + Math.exp(-z)) : z) - y[i];
      gb += err; Z[i].forEach((zj, j) => (gw[j] += err * zj));
    }
    b -= (lr * gb) / Z.length;
    w = w.map((wj, j) => wj - lr * (gw[j] / Z.length + 0.001 * wj));
  }
  return (g) => {
    const z = b + names.reduce((s, n, j) => s + ((FEATURES[n](g) - mu[j]) / sd[j]) * w[j], 0);
    return logistic ? 1 / (1 + Math.exp(-z)) : z;
  };
}

function score(set, prob, margin) {
  let acc = 0, ll = 0, brier = 0, mae = 0;
  for (const g of set) {
    const p = Math.min(0.99, Math.max(0.01, prob(g))), won = g.hs > g.as;
    acc += (p >= 0.5) === won; ll -= Math.log(won ? p : 1 - p); brier += (p - won) ** 2;
    if (margin) mae += Math.abs(margin(g) - (g.hs - g.as));
  }
  const n = set.length;
  return { acc: acc / n, ll: ll / n, brier: brier / n, mae: margin ? mae / n : null };
}

// Pronostics « sûrs » : quand le modèle donne 70 % ou plus à une équipe, a-t-il raison ~70 % du temps ?
function confidence(set, prob) {
  const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  return bins.map(([lo, hi]) => {
    const g = set.filter((x) => { const p = prob(x), c = Math.max(p, 1 - p); return c >= lo && c < hi; });
    const ok = g.filter((x) => (prob(x) >= 0.5) === (x.hs > x.as)).length;
    return { range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))} %`, games: g.length, hit: g.length ? ok / g.length : null };
  });
}

const train = usable.filter((g) => TRAIN(g.season)), test = usable.filter((g) => TEST(g.season)), cur = usable.filter((g) => CURRENT(g.season));
const homeRate = train.filter((g) => g.hs > g.as).length / train.length;
const homeMargin = train.reduce((s, g) => s + g.hs - g.as, 0) / train.length;

const MODELS = [
  ['Toujours l\'équipe à domicile', null],
  ['Elo des équipes (résultats seuls)', ['eloEquipe']],
  ['Elo des joueurs (notre modèle)', ['eloJoueurs']],
  ['Elo joueurs + tendance', ['eloJoueurs', 'tendance']],
  ['Elo joueurs + forme et écarts récents', ['eloJoueurs', 'forme5', 'ecart5', 'ecart10']],
  ['Elo joueurs + repos', ['eloJoueurs', 'repos']],
  ['Elo joueurs + Elo équipes', ['eloJoueurs', 'eloEquipe']],
  ['Tout combiné', ['eloJoueurs', 'tendance', 'forme5', 'ecart5', 'ecart10', 'repos', 'eloEquipe', 'playoffs']],
];

const results = [];
for (const [name, feats] of MODELS) {
  const prob = feats ? fit(train, feats, { logistic: true }) : () => homeRate;
  const margin = feats ? fit(train, feats, { logistic: false }) : () => homeMargin;
  results.push({ name, feats, test: score(test, prob, margin), current: score(cur, prob, margin), conf: confidence(test, prob) });
}

const pc = (x) => (x * 100).toFixed(1).padStart(5) + ' %';
console.log(`Elo équipes classique : K=${bestClassic.k}, report d'une saison à l'autre ${bestClassic.carry}`);
console.log(`Appris sur ${train.length} matchs (2005-2021), testé sur ${test.length} matchs (2021-2026) + ${cur.length} cette saison\n`);
console.log('Modèle'.padEnd(42), 'Bons vainq.', ' Log-loss', ' Brier', ' Erreur écart', '| Saison en cours');
for (const r of results) {
  console.log(r.name.padEnd(42), pc(r.test.acc).padStart(11), r.test.ll.toFixed(4).padStart(9), r.test.brier.toFixed(4).padStart(7),
    (r.test.mae.toFixed(1) + ' pts').padStart(13), '|', pc(r.current.acc), `(${cur.length} m.)`);
}
const ours = results.find((r) => r.feats?.length === 1 && r.feats[0] === 'eloJoueurs');
console.log('\nFiabilité du modèle Elo joueurs selon sa confiance (saisons test) :');
for (const c of ours.conf) console.log(`  favori à ${c.range} : ${c.games} matchs, favori vainqueur ${c.hit == null ? '-' : pc(c.hit)}`);

await writeFile('data/backtest-results.json', JSON.stringify({ classic: bestClassic, train: train.length, test: test.length, current: cur.length, results }, null, 1));
