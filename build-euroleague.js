// Calcule l'Elo à partir de l'historique condensé (data/history/*.json) et écrit site/euroleague.json.
// Usage : node build-euroleague.js            (toutes les saisons de data/history)
//         node build-euroleague.js E2025 E2026 (seulement ces saisons)
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { EloEngine, gameScore } from './engine.js';
import { TeamTracker, calibrate, winProb, rateMatchup, keyDuel } from './teams.js';

const seasons = process.argv.slice(2).length ? process.argv.slice(2)
  : (await readdir('data/history')).filter((f) => /^E\d{4}\.json$/.test(f)).map((f) => f.slice(0, 5)).sort();
const seasonLabel = (s) => `${s.slice(1)}-${String((Number(s.slice(1)) + 1) % 100).padStart(2, '0')}`;
// Comme aux échecs, l'Elo suit le joueur toute sa carrière : aucune remise à zéro entre les saisons.

// Poids des matchs selon le tour : plus l'enjeu est grand, plus l'Elo bouge.
const ROUND_WEIGHT = { RS: 1, TS: 1.15, PI: 1.25, PO: 1.4, FF: 1.6 };
const FINAL_WEIGHT = 2;
const ROUND_NAME = { RS: 'Saison régulière', TS: 'Top 16', PI: 'Play-in', PO: 'Playoffs', FF: 'Final Four' };
// Bonus de titre : chaque champion qui a joué la finale gagne des points en plus (moins s'il a peu joué).
const TITLE_BONUS = 15, TITLE_BONUS_BENCH = 6, TITLE_MIN_MINUTES = 10;

async function loadGames() {
  const all = [];
  for (const season of seasons) {
    const h = JSON.parse(await readFile(`data/history/${season}.json`, 'utf8'));
    let mismatch = 0, noMinutes = 0;
    for (const g of h.games) {
      const teams = g.teams.map((t) => ({ ...t, players: t.players.filter((p) => p.sec > 0).map((p) => ({
        ...p, min: p.sec / 60, info: { ...h.people[p.id], club: p.club ?? h.people[p.id]?.club } })) }));
      if (teams.some((t) => t.players.length === 0)) { noMinutes++; continue; }
      // Contrôle : la somme des points des joueurs doit égaler le score officiel.
      if (teams.some((t) => t.players.reduce((a, p) => a + p.pts, 0) !== t.score)) mismatch++;
      all.push({ id: `${season}_${g.code}`, season, date: g.date, league: 'Euroleague', round: g.round, gameday: g.gameday,
        weight: ROUND_WEIGHT[g.round] ?? 1, teams });
    }
    if (mismatch || noMinutes) console.warn(`${season} : ${noMinutes} matchs sans minutes, ${mismatch} avec écart de score`);
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  // La finale : le dernier match du Final Four, une fois les demi-finales et la finale jouées (la petite finale
  // se joue avant). En 2000-01, sans Final Four, c'est le dernier match des playoffs. 2019-20 (Covid) : pas de champion.
  for (const season of seasons) {
    const sg = all.filter((g) => g.season === season);
    const ff = sg.filter((g) => g.round === 'FF');
    const final = ff.length >= 3 ? ff.at(-1) : season === 'E2000' ? sg.filter((g) => g.round === 'PO').at(-1) : null;
    if (!final) continue;
    final.isFinal = true; final.weight = FINAL_WEIGHT;
  }
  return all;
}

// ---- Elo d'arrivée selon la provenance ----
// Wikidata (data/nba-careers.json) liste les joueurs passés par la NBA. On les retrouve par date de naissance et nom.
const norm = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
let nbaByDob = new Map();
try {
  for (const p of JSON.parse(await readFile('data/nba-careers.json', 'utf8'))) {
    if (!p.dob) continue;
    nbaByDob.set(p.dob, [...(nbaByDob.get(p.dob) ?? []), p]);
  }
} catch { console.warn('data/nba-careers.json absent : lancer node fetch-nba-careers.js pour repérer les anciens joueurs NBA'); }

function nbaMatch(info) {
  const cands = nbaByDob.get(info.birthDate) ?? [];
  const words = norm(info.name);
  // Il faut au moins un passage dans une franchise NBA (une simple fiche ou une draft ne suffit pas).
  return cands.find((c) => { const cw = norm(c.name); return c.stints.length && words.some((w) => w.length > 2 && cw.includes(w)); }) ?? null;
}

// Catégorie d'arrivée : ancien NBA, jeune (21 ans ou moins à son 1er match), ou autre.
function origin(info, debutDate) {
  const age = info.birthDate ? (new Date(debutDate) - new Date(info.birthDate)) / (365.25 * 864e5) : null;
  const nba = nbaMatch(info);
  if (nba) {
    const starts = nba.stints.map((s) => Number(s.start)).filter(Boolean);
    const debutYear = Number(debutDate.slice(0, 4));
    // Avec des années connues : il faut être passé en NBA avant ses débuts en Euroleague.
    // Sans années : on suppose qu'un joueur arrivé à 23 ans ou plus vient de NBA, un plus jeune y est allé après.
    const before = starts.length ? Math.min(...starts) < debutYear : age != null && age >= 23;
    if (before) return 'nba';
  }
  if (age != null && age <= 21) return 'young';
  return 'other';
}
const ORIGIN_NAME = { nba: 'Arrivé de NBA', young: 'Jeune (21 ans ou moins)', other: 'Autre provenance' };

function runEngine(games, cfg, entry = { nba: 1500, young: 1500, other: 1500 }, hooks = {}) {
  const e = new EloEngine(cfg);
  for (const g of games) {
    hooks.before?.(e, g);
    // Nouveaux joueurs : on les crée avec l'Elo d'arrivée de leur catégorie avant de jouer le match.
    for (const t of g.teams) for (const s of t.players) {
      if (e.players.has(s.id)) continue;
      const o = origin(s.info, g.date);
      const p = e.player(s.id, s.info);
      p.rating = entry[o]; p.origin = o; p.entryRating = entry[o];
    }
    const res = e.processGame(g);
    // On garde l'adversaire et la ligne de stats dans l'historique, pour la fiche joueur.
    const byId = new Map(res.map((r) => [r.id, r]));
    for (const [i, t] of g.teams.entries()) for (const s of t.players) {
      const h = e.players.get(s.id).history.at(-1);
      if (!byId.has(s.id) || h.gameId !== g.id) continue;
      Object.assign(h, { season: g.season, team: t.code, club: s.info.club, opp: g.teams[1 - i].code, home: t.home,
        round: g.round, final: !!g.isFinal,
        line: { min: Math.round(s.min), pts: s.pts, reb: s.reb, ast: s.ast, stl: s.stl, blk: s.blk, tov: s.tov, pir: s.pir, pm: s.pm } });
      // Titre : bonus pour les champions qui ont joué la finale.
      if (g.isFinal && t.score > g.teams[1 - i].score) {
        const p = e.players.get(s.id);
        const bonus = s.min >= TITLE_MIN_MINUTES ? TITLE_BONUS : TITLE_BONUS_BENCH;
        p.rating += bonus; h.after += bonus; h.delta += bonus; h.parts.title = bonus;
        (p.titles ??= []).push(g.season);
      }
    }
    hooks.after?.(e, g);
  }
  return e;
}

const current = seasons.at(-1);
const games = await loadGames();

// Calibrage sur les données : Game Score moyen pour 36 minutes, et combien il monte avec l'Elo.
let tot = 0, mins = 0;
for (const g of games) for (const t of g.teams) for (const s of t.players) { tot += gameScore(s); mins += s.min; }
const leagueGmSc36 = (tot / mins) * 36;
// +2 de Game Score attendu par tranche de 100 Elo : réglage fixe (un calage automatique tournait en rond,
// les essais à 1 / 1,5 / 2 / 3 donnent des classements très proches). Modifiable avec PER_ELO=0.03.
const cfg = { perf: { leagueGmSc36, perEloPoint: Number(process.env.PER_ELO ?? 0.02) } };
console.log(`Réglage : Game Score moyen/36 = ${leagueGmSc36.toFixed(1)}, +${(cfg.perf.perEloPoint * 100).toFixed(1)} par 100 Elo`);

// Elo d'arrivée calé sur les données : un premier calcul où tout le monde part de 1500 donne, pour chaque
// catégorie, le niveau moyen atteint après 20 matchs. Ce niveau devient l'Elo d'arrivée des suivants.
// (Un seul passage : en répétant, les catégories s'écartent de plus en plus sans se stabiliser.)
let engine = runEngine(games, cfg);
const acc = {};
for (const p of engine.players.values()) if (p.history.length >= 20) (acc[p.origin] ??= []).push(p.history[19].after);
const entry = Object.fromEntries(['nba', 'young', 'other'].map((k) => [k, acc[k]?.length ? Math.round(acc[k].reduce((a, b) => a + b) / acc[k].length) : 1500]));
console.log(`Elo d'arrivée : ${Object.entries(entry).map(([k, v]) => `${ORIGIN_NAME[k]} ${v} (${acc[k]?.length ?? 0} joueurs)`).join(' · ')}`);
// Calcul final. En parallèle on suit la rotation de chaque équipe, pour l'Elo des équipes et les pronostics :
// avant chaque match des 5 dernières saisons, on note la force des deux équipes et le résultat (calage).
const lastDate = games.at(-1).date;
const weekCutoff = new Date(new Date(lastDate.slice(0, 10) + 'T12:00:00Z') - 6 * 864e5).toISOString().slice(0, 10);
const tracker = new TeamTracker();
const samples = [];
let weekAgo = null;
engine = runEngine(games, cfg, entry, {
  before: (e, g) => {
    if (!weekAgo && g.season === current && g.date.slice(0, 10) >= weekCutoff) weekAgo = tracker.snapshot(e);
    if (g.season < `E${Number(current.slice(1)) - 5}`) return;
    const [h, a] = g.teams.map((t) => tracker.strength(e, t.code));
    if (h != null && a != null) samples.push({ home: h, away: a, homeWon: g.teams[0].score > g.teams[1].score });
  },
  after: (e, g) => tracker.update(g),
});
weekAgo ??= tracker.snapshot(engine);
const calib = calibrate(samples);
console.log(`Pronostics calés sur ${calib.games} matchs : échelle ${calib.scale}, ${Math.round(calib.accuracy * 100)} % de vainqueurs trouvés (toujours parier sur l'équipe à domicile : ${Math.round(calib.homeRate * 100)} %)`);

// Contrôle de cohérence : l'Elo doit aller dans le même sens que l'évaluation officielle (PIR) moyenne.
const rows = [...engine.players.values()].map((p) => {
  const h = p.history.filter((x) => x.season === current);
  return { p, h, pir: h.length ? h.reduce((a, x) => a + x.line.pir, 0) / h.length : null };
}).filter((r) => r.h.length >= 5);
const corr = (xs, ys) => {
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let n = 0, dx = 0, dy = 0;
  xs.forEach((x, i) => { n += (x - mx) * (ys[i] - my); dx += (x - mx) ** 2; dy += (ys[i] - my) ** 2; });
  return n / Math.sqrt(dx * dy);
};
const rs = rows.map((r) => r.p.rating).sort((a, b) => a - b);
console.log(`Étendue des notes (5 matchs min.) : min ${rs[0].toFixed(0)}, 10e pct ${rs[Math.floor(rs.length * 0.1)].toFixed(0)}, médiane ${rs[Math.floor(rs.length / 2)].toFixed(0)}, 90e pct ${rs[Math.floor(rs.length * 0.9)].toFixed(0)}, max ${rs.at(-1).toFixed(0)}`);
console.log(`Corrélation Elo / PIR moyen ${current} (${rows.length} joueurs, 5 matchs min.) : ${corr(rows.map((r) => r.p.rating), rows.map((r) => r.pir)).toFixed(2)}`);

// Résumé de carrière : saison par saison, pic d'Elo (l'« Elo de l'époque ») et dernière note.
const r1 = (v) => Math.round(v * 10) / 10;
function career(p) {
  const bySeason = new Map();
  for (const h of p.history) {
    const s = bySeason.get(h.season) ?? { s: h.season, club: h.club, g: 0, pts: 0, r: 0, peak: 0 };
    s.g++; s.pts += h.line.pts; s.r = h.after; s.peak = Math.max(s.peak, h.after); s.club = h.club ?? s.club;
    bySeason.set(h.season, s);
  }
  const seasonsList = [...bySeason.values()].map((s) => ({ s: s.s, club: s.club, g: s.g, ppg: r1(s.pts / s.g), r: r1(s.r), peak: r1(s.peak) }));
  // Le pic ne compte qu'après 15 matchs, pour éviter les notes gonflées par un début de carrière.
  const eligible = p.history.slice(14);
  const top = eligible.reduce((a, h) => (!a || h.after > a.after ? h : a), null);
  return {
    first: seasonsList[0].s, last: seasonsList.at(-1).s, totalGames: p.history.length,
    peak: top ? r1(top.after) : null, peakSeason: top?.season ?? null, peakDate: top?.date.slice(0, 10) ?? null, peakClub: top?.club ?? null,
    final: r1(p.history.at(-1).after),
    origin: p.origin, entryRating: p.entryRating, titles: p.titles ?? [],
    clubs: [...new Set(seasonsList.map((s) => s.club).filter(Boolean))],
    seasons: seasonsList,
  };
}

const formerPlayers = [...engine.players.values()]
  .filter((p) => !p.history.some((h) => h.season === current) && p.history.length >= 30)
  .map((p) => ({ id: p.id, name: p.name, position: p.position, heightCm: p.heightCm, weightKg: p.weightKg,
    country: p.country, birthDate: p.birthDate, ...career(p) }))
  .sort((a, b) => b.peak - a.peak);

// ---- Classement des équipes ----
const titleCase = (s) => (s ?? '').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
const seasonGames = games.filter((g) => g.season === current);
const teamCodes = [...new Set(seasonGames.flatMap((g) => g.teams.map((t) => t.code)))];
const teams = teamCodes.map((code) => {
  const played = seasonGames.filter((g) => g.teams.some((t) => t.code === code)).map((g) => {
    const i = g.teams.findIndex((t) => t.code === code);
    return { date: g.date, won: g.teams[i].score > g.teams[1 - i].score, diff: g.teams[i].score - g.teams[1 - i].score, opp: g.teams[1 - i].code };
  });
  // Nom court : le nom de club le plus fréquent chez ses joueurs cette saison.
  const clubs = {};
  for (const g of seasonGames) for (const t of g.teams) if (t.code === code) for (const s of t.players) if (s.info.club) clubs[s.info.club] = (clubs[s.info.club] ?? 0) + 1;
  const fullName = seasonGames.flatMap((g) => g.teams).find((t) => t.code === code).name;
  const rotation = tracker.rotation(code).filter((x) => x.avgMin >= 12).map(({ id, avgMin }) => {
    const p = engine.players.get(id);
    return { id, name: p.name, position: p.position, rating: r1(p.rating), avgMin: Math.round(avgMin) };
  }).sort((a, b) => b.rating - a.rating);
  const rating = tracker.strength(engine, code);
  return {
    code, name: Object.entries(clubs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? titleCase(fullName), fullName: titleCase(fullName),
    rating: r1(rating), week: r1(rating - (weekAgo[code] ?? rating)),
    wins: played.filter((x) => x.won).length, losses: played.filter((x) => !x.won).length,
    pointDiff: played.reduce((a, x) => a + x.diff, 0), form: played.slice(-5).map((x) => (x.won ? 'V' : 'D')),
    top: rotation.slice(0, 3), rotation,
  };
}).sort((a, b) => b.rating - a.rating).map((t, i) => ({ ...t, rank: i + 1 }));

// ---- Prochains matchs : pronostic et intérêt ----
let schedule = [];
try { schedule = JSON.parse(await readFile(`data/raw/${current}/schedule.json`, 'utf8')); } catch { console.warn('Pas de calendrier : lancer node fetch-euroleague.js pour les pronostics'); }
const today = new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.now() + 13 * 864e5).toISOString().slice(0, 10);
const byCode = new Map(teams.map((t) => [t.code, t]));
const teamRatings = teams.map((t) => t.rating);
const starRatings = teams.map((t) => t.top[0]?.rating ?? 1500);
const upcoming = schedule.filter((g) => g.date >= today && g.date <= horizon && byCode.has(g.home.code) && byCode.has(g.away.code)).map((g) => {
  const home = byCode.get(g.home.code), away = byCode.get(g.away.code);
  const p = winProb(home.rating, away.rating, calib.scale);
  const interest = rateMatchup({ home, away, p, teamRatings, starRatings });
  const duel = keyDuel(home, away);
  return { code: g.code, date: g.date, time: g.time, confirmed: g.confirmed, round: g.round, gameday: g.gameday, arena: titleCase(g.arena),
    home: home.code, away: away.code, pHome: Math.round(p * 1000) / 1000, interest: interest.score, reasons: interest.reasons,
    duel: duel && { position: duel.position, home: { id: duel.home.id, name: duel.home.name, rating: duel.home.rating }, away: { id: duel.away.id, name: duel.away.name, rating: duel.away.rating } } };
});
console.log(`Équipes : ${teams.slice(0, 5).map((t) => `${t.name} ${Math.round(t.rating)}`).join(' · ')}`);
console.log(`À suivre (${upcoming.length} matchs d'ici le ${horizon}) : ${[...upcoming].sort((a, b) => b.interest - a.interest).slice(0, 3).map((g) => `${byCode.get(g.home).name}-${byCode.get(g.away).name} ${g.interest}/100 (${Math.round(g.pHome * 100)} %)`).join(' · ')}`);

const out = {
  generatedAt: new Date().toISOString(), league: 'Euroleague', seasons: seasons.map((s) => ({ code: s, label: seasonLabel(s) })),
  totalGames: games.length, formerPlayers, teamRanking: teams, upcoming,
  predictions: { scale: calib.scale, accuracy: Math.round(calib.accuracy * 1000) / 1000, homeRate: Math.round(calib.homeRate * 1000) / 1000, games: calib.games, homeAdvantage: 50 },
  currentSeason: current, lastGameDate: lastDate,
  games: games.filter((g) => g.season === current).length,
  config: { ...cfg, entry, originNames: ORIGIN_NAME, roundWeight: ROUND_WEIGHT, finalWeight: FINAL_WEIGHT, roundNames: ROUND_NAME,
    titleBonus: TITLE_BONUS, titleBonusBench: TITLE_BONUS_BENCH },
  teams: Object.fromEntries(games.filter((g) => g.season === current).flatMap((g) => g.teams.map((t) => [t.code, t.name]))),
  players: [...engine.players.values()].filter((p) => p.history.some((h) => h.season === current)).map((p) => ({
    id: p.id, name: p.name, position: p.position, heightCm: p.heightCm, weightKg: p.weightKg, country: p.country,
    birthDate: p.birthDate, club: p.club, rating: Math.round(p.rating * 10) / 10,
    games: p.history.filter((h) => h.season === current).length,
    seasonStart: Math.round(p.history.find((h) => h.season === current).before * 10) / 10,
    career: career(p),
    history: p.history.filter((h) => h.season === current).map((h) => ({ d: h.date.slice(0, 10), s: h.season, opp: h.opp, home: h.home, w: h.won, m: h.margin,
      rd: h.round, fin: h.final || undefined,
      r: Math.round(h.after * 10) / 10, dt: Math.round(h.delta * 10) / 10,
      pt: { t: Math.round(h.parts.team * 10) / 10, p: Math.round(h.parts.perf * 10) / 10 }, l: h.line })),
  })),
};
await writeFile('site/euroleague.json', JSON.stringify(out));

console.log(`\n${current} : ${out.games} matchs, ${out.players.length} joueurs, dernier match le ${lastDate.slice(0, 10)}`);
console.log(`Historique : ${seasons.length} saisons, ${games.length} matchs, ${formerPlayers.length} anciens joueurs (30 matchs min.)\n`);
console.log('Top 15 des pics d\'Elo, anciens joueurs :');
for (const [i, p] of formerPlayers.slice(0, 15).entries()) console.log(`  ${String(i + 1).padStart(3)}. ${p.name.padEnd(26)} ${String(Math.round(p.peak)).padStart(5)}  ${seasonLabel(p.peakSeason)}  ${p.peakClub ?? ''}  (${p.totalGames} matchs, ${p.titles.length} titre(s), arrivée ${p.entryRating} ${p.origin})`);
const nbaArrivals = [...engine.players.values()].filter((p) => p.origin === 'nba');
console.log(`\n${nbaArrivals.length} joueurs repérés comme arrivés de NBA, par ex. : ${nbaArrivals.filter((p) => p.history.length > 60).slice(0, 12).map((p) => p.name).join(', ')}`);
const champs = new Map();
for (const p of engine.players.values()) for (const s of p.titles ?? []) champs.set(s, [...(champs.get(s) ?? []), p.history.find((h) => h.season === s && h.final)?.club]);
console.log('Champions détectés : ' + [...champs.entries()].sort().map(([s, c]) => `${seasonLabel(s)} ${c[0]}`).join(' · '));
console.log('');
console.log('Top 15 (5 matchs min. cette saison) :');
for (const r of engine.rankings({ minGames: 1 }).filter((r) => out.players.find((p) => p.id === r.id)?.games >= 5).slice(0, 15)) {
  const p = out.players.find((x) => x.id === r.id);
  console.log(`  ${String(r.rank).padStart(3)}. ${r.name.padEnd(26)} ${String(r.rating).padStart(5)}  ${(p.position ?? '').padEnd(8)} ${p.heightCm ?? '?'} cm  ${p.club}`);
}
