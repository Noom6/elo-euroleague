// Elo des équipes et pronostics des prochains matchs.
//
// L'Elo d'une équipe = moyenne des Elo de ses joueurs, pondérée par leurs minutes sur ses 5 derniers matchs :
// c'est la force de la rotation actuelle (un blessé qui ne joue plus ne compte plus, une recrue compte dès qu'elle joue).
// Les probabilités de victoire sont calées sur les matchs passés (voir calibrate).

export const HOME_ADVANTAGE = 50;
const RECENT_GAMES = 5;

export class TeamTracker {
  constructor() { this.recent = new Map(); } // code équipe -> 5 derniers matchs [{ minutes: Map(id -> min) }]

  update(game) {
    for (const t of game.teams) {
      const list = this.recent.get(t.code) ?? [];
      list.push({ date: game.date, minutes: new Map(t.players.map((s) => [s.id, s.min])) });
      if (list.length > RECENT_GAMES) list.shift();
      this.recent.set(t.code, list);
    }
  }

  // Rotation récente : minutes moyennes par joueur sur les derniers matchs de l'équipe.
  rotation(code) {
    const list = this.recent.get(code) ?? [];
    const tot = new Map();
    for (const g of list) for (const [id, m] of g.minutes) tot.set(id, (tot.get(id) ?? 0) + m);
    return [...tot.entries()].map(([id, m]) => ({ id, avgMin: m / Math.max(1, list.length) }));
  }

  strength(engine, code, ratingOf = (id) => engine.players.get(id)?.rating) {
    let sum = 0, w = 0;
    for (const { id, avgMin } of this.rotation(code)) {
      const r = ratingOf(id);
      if (r == null) continue;
      sum += r * avgMin; w += avgMin;
    }
    return w ? sum / w : null;
  }

  snapshot(engine) {
    return Object.fromEntries([...this.recent.keys()].map((c) => [c, this.strength(engine, c)]));
  }
}

export const winProb = (home, away, scale) => 1 / (1 + Math.pow(10, -((home + HOME_ADVANTAGE - away) * scale) / 400));

// Calage : on cherche le facteur d'échelle qui donne les probabilités les plus justes sur les matchs passés.
export function calibrate(samples) {
  let best = { scale: 1, logLoss: Infinity };
  for (let s = 0.5; s <= 8; s += 0.05) {
    let ll = 0;
    for (const { home, away, homeWon } of samples) {
      const p = Math.min(0.999, Math.max(0.001, winProb(home, away, s)));
      ll -= homeWon ? Math.log(p) : Math.log(1 - p);
    }
    ll /= samples.length;
    if (ll < best.logLoss) best = { scale: Math.round(s * 100) / 100, logLoss: ll };
  }
  const acc = samples.filter(({ home, away, homeWon }) => (winProb(home, away, best.scale) >= 0.5) === homeWon).length / samples.length;
  // Point de comparaison : toujours parier sur l'équipe à domicile.
  const homeRate = samples.filter((x) => x.homeWon).length / samples.length;
  return { ...best, accuracy: acc, homeRate, games: samples.length };
}

const pct = (arr, v) => arr.filter((x) => x <= v).length / arr.length;

// Note d'intérêt d'un match (0 à 100) : niveau des deux équipes, suspense, et stars sur le terrain.
export function rateMatchup({ home, away, p, teamRatings, starRatings }) {
  const quality = pct(teamRatings, (home.rating + away.rating) / 2);
  const suspense = 1 - Math.abs(p - 0.5) * 2;
  const stars = pct(starRatings, (home.top[0].rating + away.top[0].rating) / 2);
  const score = Math.round(100 * (0.45 * quality + 0.35 * suspense + 0.2 * stars));
  const reasons = [];
  if (home.rank <= 6 && away.rank <= 6) reasons.push(`Deux équipes du top 6 (${home.rank}e et ${away.rank}e)`);
  else if (Math.min(home.rank, away.rank) <= 3) reasons.push(`Le ${Math.min(home.rank, away.rank) === 1 ? '1er' : Math.min(home.rank, away.rank) + 'e'} du classement en jeu`);
  if (suspense >= 0.85) reasons.push('Match très serré sur le papier');
  else if (p < 0.4) reasons.push(`L'équipe à l'extérieur est favorite (${Math.round((1 - p) * 100)} %)`);
  return { score, quality, suspense, stars, reasons };
}

// Le duel à suivre : au poste où les deux meilleurs joueurs se rapprochent le plus du sommet.
export function keyDuel(home, away) {
  let best = null;
  for (const pos of ['Guard', 'Forward', 'Center']) {
    const a = home.rotation.find((x) => x.position === pos), b = away.rotation.find((x) => x.position === pos);
    if (!a || !b) continue;
    if (!best || a.rating + b.rating > best.home.rating + best.away.rating) best = { position: pos, home: a, away: b };
  }
  return best;
}
