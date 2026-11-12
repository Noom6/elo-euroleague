// Vérifie que les règles voulues se retrouvent dans les chiffres, sur des matchs inventés.
import { EloEngine } from './engine.js';

const avg = { min: 30, pts: 12, fgm: 5, fga: 11, ftm: 2, fta: 2, oreb: 1, reb: 5, ast: 3, stl: 1, blk: 0, tov: 2, pf: 2 };
const big = { min: 36, pts: 38, fgm: 14, fga: 22, ftm: 8, fta: 9, oreb: 2, reb: 9, ast: 7, stl: 2, blk: 1, tov: 2, pf: 2 };
const bad = { min: 34, pts: 6, fgm: 2, fga: 13, ftm: 2, fta: 4, oreb: 0, reb: 3, ast: 1, stl: 0, blk: 0, tov: 5, pf: 4 };

function scenario(label, { star, won, margin = 8, duel, starRating = 1500, oppRating = 1500, teamRating = 1500 }) {
  const e = new EloEngine();
  const mk = (prefix, rating) => Array.from({ length: 5 }, (_, i) => {
    const p = e.player(`${prefix}${i}`, { name: `${prefix}${i}` }); p.rating = rating; p.games = 50; return { id: p.id, ...avg };
  });
  const teamA = mk('A', teamRating), teamB = mk('B', oppRating);
  const x = e.player('A0'); x.rating = starRating; x.name = 'Joueur X';
  Object.assign(teamA[0], star);
  const scoreA = 100 + (won ? margin : -margin);
  const res = e.processGame({ id: 'g', date: '2026-11-08', league: 'TEST', matchups: duel ? [{ off: 'A0', def: 'B0', ...duel[0] }, { off: 'B0', def: 'A0', ...duel[1] }] : [],
    teams: [{ score: scoreA, home: false, players: teamA }, { score: 100, home: false, players: teamB }] });
  const r = res.find((x) => x.id === 'A0');
  const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  console.log(`${label.padEnd(62)} ${f(r.delta).padStart(6)}   (équipe ${f(r.parts.team)}, perf ${f(r.parts.perf)}, duel ${f(r.parts.duel)})`);
}

const domine = [{ poss: 30, pts: 42 }, { poss: 30, pts: 20 }];  // il marque 1,4 pt/poss, son vis-à-vis 0,67
const domineSubit = [{ poss: 30, pts: 20 }, { poss: 30, pts: 42 }];

console.log('Variation d\'Elo du joueur X (tous à 1500, sauf mention)\n');
scenario('1. Victoire, gros match, domine son vis-à-vis', { star: big, won: true, duel: domine });
scenario('2. Défaite, gros match, domine son vis-à-vis', { star: big, won: false, duel: domine });
scenario('3. Défaite, match moyen', { star: avg, won: false });
scenario('4. Défaite, mauvais match, se fait dominer', { star: bad, won: false, duel: domineSubit });
scenario('5. Victoire, mais mauvais match et se fait dominer', { star: bad, won: true, duel: domineSubit });
scenario('6. Victoire d\'une équipe à 1450 contre une équipe à 1600', { star: avg, won: true, teamRating: 1450, oppRating: 1600 });
scenario('7. Star à 2000 : victoire, mais match moyen (on attendait plus)', { star: avg, won: true, starRating: 2000 });
scenario('8. Victoire de 1 point (au lieu de 8), match moyen', { star: avg, won: true, margin: 1 });
