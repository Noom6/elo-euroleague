// Elo des équipes et intérêt des prochains matchs.
//
// L'Elo d'une équipe = moyenne des Elo de ses joueurs, pondérée par leurs minutes sur ses 5 derniers matchs :
// c'est la force de la rotation actuelle (un blessé qui ne joue plus ne compte plus, une recrue compte dès qu'elle joue).

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

const pct = (arr, v) => arr.filter((x) => x <= v).length / arr.length;

// Note d'intérêt d'un match (0 à 100) : niveau des deux équipes, équilibre entre elles, et stars sur le terrain.
export function rateMatchup({ home, away, teamRatings, starRatings }) {
  const quality = pct(teamRatings, (home.rating + away.rating) / 2);
  // Équilibre : 1 quand les deux équipes ont le même Elo (avantage du terrain compris), 0 à 120 points d'écart.
  const balance = Math.max(0, 1 - Math.abs(home.rating + HOME_ADVANTAGE - away.rating) / 120);
  const stars = pct(starRatings, (home.top[0].rating + away.top[0].rating) / 2);
  const score = Math.round(100 * (0.45 * quality + 0.35 * balance + 0.2 * stars));
  const reasons = [];
  if (home.rank <= 6 && away.rank <= 6) reasons.push(`Deux équipes du top 6 (${home.rank}e et ${away.rank}e)`);
  else if (Math.min(home.rank, away.rank) <= 3) reasons.push(`Le ${Math.min(home.rank, away.rank) === 1 ? '1er' : Math.min(home.rank, away.rank) + 'e'} du classement en jeu`);
  if (balance >= 0.8) reasons.push('Deux équipes de même niveau');
  return { score, quality, balance, stars, reasons };
}

// Les duels à venir, poste par poste : le meilleur joueur de chaque équipe à ce poste.
// Le premier de la liste est le duel phare (les deux joueurs les mieux notés).
export function keyDuels(home, away) {
  const list = [];
  for (const pos of ['Guard', 'Forward', 'Center']) {
    const a = home.rotation.find((x) => x.position === pos), b = away.rotation.find((x) => x.position === pos);
    if (a && b) list.push({ position: pos, home: a, away: b });
  }
  return list.sort((x, y) => y.home.rating + y.away.rating - (x.home.rating + x.away.rating));
}
