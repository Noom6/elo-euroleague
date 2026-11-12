// Moteur Elo hybride pour le basket.
// Un joueur gagne ou perd des points selon trois choses, à chaque match :
//   1. le résultat de son équipe face à la force de l'équipe adverse,
//   2. sa performance individuelle (fiche de stats) comparée à ce qu'on attendait de lui,
//   3. ses duels : comment il a dominé (ou non) les joueurs qu'il a affrontés directement.
// Une défaite avec une grosse performance fait donc perdre moins de points (voire en faire gagner).
//
// Le moteur ne dépend d'aucune source : chaque match est un objet au format décrit dans README.md.

export const DEFAULTS = {
  start: 1500,          // note de départ
  k: 32,                // vitesse de variation normale
  kProvisional: 64,     // plus rapide pendant les premiers matchs (le temps de trouver son niveau)
  provisionalGames: 10,
  fullMinutes: 36,      // à 36 minutes jouées, le joueur prend 100 % de la variation
  minMinutes: 5,        // en dessous, le match ne compte pas pour lui
  weights: { team: 0.35, perf: 0.35, duel: 0.30 }, // sans données de duels, le poids est réparti sur les deux autres
  homeAdvantage: 50,    // points d'Elo d'avantage pour l'équipe à domicile
  marginScale: 8,       // un écart de 8 points pèse ~0.73 dans le score d'équipe
  perf: {
    leagueGmSc36: 13,   // Game Score moyen pour 36 minutes à 1500
    perEloPoint: 0.025, // +2,5 de Game Score attendu par tranche de 100 Elo
    oppPerEloPoint: 0.01, // -1 de Game Score attendu par 100 Elo de force adverse
    scale: 6,           // écart de Game Score qui fait passer le score de perf de 0.5 à ~0.73
  },
  duel: {
    minPoss: 5,         // un duel compte à partir de 5 possessions
    leaguePPP: 1.1,     // points par possession moyens
    scale: 0.35,
  },
};

const logistic = (x) => 1 / (1 + Math.exp(-x));
const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

// Game Score de John Hollinger : un résumé de la fiche de stats en un seul nombre.
export function gameScore(s) {
  return (s.pts ?? 0) + 0.4 * (s.fgm ?? 0) - 0.7 * (s.fga ?? 0) - 0.4 * ((s.fta ?? 0) - (s.ftm ?? 0))
    + 0.7 * (s.oreb ?? 0) + 0.3 * ((s.reb ?? 0) - (s.oreb ?? 0)) + (s.stl ?? 0) + 0.7 * (s.ast ?? 0)
    + 0.7 * (s.blk ?? 0) - 0.4 * (s.pf ?? 0) - (s.tov ?? 0);
}

export class EloEngine {
  constructor(config = {}) {
    this.cfg = { ...DEFAULTS, ...config,
      weights: { ...DEFAULTS.weights, ...config.weights },
      perf: { ...DEFAULTS.perf, ...config.perf },
      duel: { ...DEFAULTS.duel, ...config.duel } };
    this.players = new Map(); // id -> { id, name, rating, games, history: [] }
  }

  player(id, info = {}) {
    let p = this.players.get(id);
    if (!p) {
      p = { id, rating: this.cfg.start, games: 0, history: [], ...info };
      this.players.set(id, p);
    } else Object.assign(p, info, { rating: p.rating, games: p.games, history: p.history });
    return p;
  }

  // Force d'une équipe = moyenne des Elo de ses joueurs, pondérée par les minutes jouées.
  teamStrength(team) {
    let sum = 0, min = 0;
    for (const s of team.players) {
      if (!(s.min > 0)) continue;
      sum += this.player(s.id).rating * s.min; min += s.min;
    }
    return min ? sum / min : this.cfg.start;
  }

  processGame(game) {
    const c = this.cfg;
    const [A, B] = game.teams;
    for (const t of game.teams) for (const s of t.players) this.player(s.id, s.info ?? {});

    const str = [this.teamStrength(A), this.teamStrength(B)];
    const home = [A.home ? c.homeAdvantage : 0, B.home ? c.homeAdvantage : 0];
    const before = new Map([...this.players.values()].map((p) => [p.id, p.rating]));

    // Duels : on regroupe tous les face-à-face par joueur.
    const duelAgg = new Map(); // id -> { s, e, w }
    for (const m of game.matchups ?? []) {
      if (!(m.poss >= c.duel.minPoss)) continue;
      const ro = before.get(m.off), rd = before.get(m.def);
      if (ro == null || rd == null) continue;
      const sOff = logistic((m.pts / m.poss - c.duel.leaguePPP) / c.duel.scale);
      const eOff = expected(ro, rd);
      for (const [id, s, e] of [[m.off, sOff, eOff], [m.def, 1 - sOff, 1 - eOff]]) {
        const a = duelAgg.get(id) ?? { s: 0, e: 0, w: 0 };
        a.s += s * m.poss; a.e += e * m.poss; a.w += m.poss;
        duelAgg.set(id, a);
      }
    }

    const results = [];
    game.teams.forEach((team, i) => {
      const opp = game.teams[1 - i];
      const margin = team.score - opp.score;
      const eTeam = expected(str[i] + home[i], str[1 - i] + home[1 - i]);
      const sTeam = 0.5 * (margin > 0 ? 1 : margin < 0 ? 0 : 0.5) + 0.5 * logistic(margin / c.marginScale);

      for (const s of team.players) {
        if (!(s.min >= c.minMinutes)) continue;
        const p = this.players.get(s.id);
        const r = before.get(s.id);

        // Performance : Game Score ramené à 36 minutes, comparé à ce qu'on attendait
        // d'un joueur de ce niveau face à cette adversité.
        const gs36 = gameScore(s) * 36 / s.min;
        const expGs36 = c.perf.leagueGmSc36 + c.perf.perEloPoint * (r - c.start)
          - c.perf.oppPerEloPoint * (str[1 - i] - c.start);
        const sPerf = logistic((gs36 - expGs36) / c.perf.scale);

        const d = duelAgg.get(s.id);
        let w = { ...c.weights };
        if (!d) { const t = w.team + w.perf; w = { team: w.team / t, perf: w.perf / t, duel: 0 }; }

        const parts = {
          team: w.team * (sTeam - eTeam),
          perf: w.perf * (sPerf - 0.5),
          duel: d ? w.duel * (d.s / d.w - d.e / d.w) : 0,
        };
        // Les matchs à enjeu (playoffs, Final Four, finale) comptent plus : game.weight multiplie la variation.
        const k = (p.games < c.provisionalGames ? c.kProvisional : c.k) * (game.weight ?? 1);
        const minutesFactor = Math.min(1, s.min / c.fullMinutes);
        const delta = k * minutesFactor * (parts.team + parts.perf + parts.duel);

        p.rating = r + delta;
        p.games += 1;
        const entry = { gameId: game.id, date: game.date, league: game.league, before: r, after: p.rating,
          delta, parts: Object.fromEntries(Object.entries(parts).map(([k2, v]) => [k2, k * minutesFactor * v])),
          won: margin > 0, margin, gs: gameScore(s), min: s.min };
        p.history.push(entry);
        results.push({ id: s.id, name: p.name, ...entry });
      }
    });
    return results;
  }

  run(games) {
    const sorted = [...games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const g of sorted) this.processGame(g);
    return this;
  }

  // Classement, avec filtres : poste, taille, poids, championnat, nombre de matchs minimum.
  rankings({ position, minHeight, maxHeight, minWeight, maxWeight, league, minGames = 1 } = {}) {
    return [...this.players.values()]
      .filter((p) => p.games >= minGames)
      .filter((p) => !position || (p.position ?? '').includes(position))
      .filter((p) => minHeight == null || (p.heightCm ?? 0) >= minHeight)
      .filter((p) => maxHeight == null || (p.heightCm ?? Infinity) <= maxHeight)
      .filter((p) => minWeight == null || (p.weightKg ?? 0) >= minWeight)
      .filter((p) => maxWeight == null || (p.weightKg ?? Infinity) <= maxWeight)
      .filter((p) => !league || p.history.some((h) => h.league === league))
      .sort((a, b) => b.rating - a.rating)
      .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, rating: Math.round(p.rating), games: p.games,
        position: p.position, heightCm: p.heightCm, weightKg: p.weightKg }));
  }

  // Plus grosses hausses / baisses depuis une date (ex. le classement d'après week-end).
  movers(sinceDate, { limit = 10 } = {}) {
    const rows = [];
    for (const p of this.players.values()) {
      const h = p.history.filter((e) => e.date >= sinceDate);
      if (!h.length) continue;
      rows.push({ id: p.id, name: p.name, change: Math.round(h.at(-1).after - h[0].before),
        rating: Math.round(p.rating), games: h.length });
    }
    rows.sort((a, b) => b.change - a.change);
    return { up: rows.slice(0, limit), down: rows.slice(-limit).reverse() };
  }
}
