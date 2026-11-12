// Condense les fiches brutes Euroleague (data/raw/<saison>/*.json, ~10 Mo par saison)
// en un fichier compact par saison : data/history/<saison>.json (~1 Mo), versionné dans Git.
// Usage : node compact.js E2026                 (saisons à condenser, depuis data/raw)
//         node compact.js --raw <dossier> E2000 E2001 ...
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';

const args = process.argv.slice(2);
let rawDir = 'data/raw';
if (args[0] === '--raw') { rawDir = args[1]; args.splice(0, 2); }
const seasons = args;
if (!seasons.length) { console.error('Indiquer au moins une saison, ex. node compact.js E2026'); process.exit(1); }

const titleName = (raw) => {
  const [last, first] = raw.split(',').map((s) => s.trim());
  const cap = (s) => (s ?? '').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
  return first ? `${cap(first)} ${cap(last)}` : cap(last);
};

await mkdir('data/history', { recursive: true });
for (const season of seasons) {
  const list = JSON.parse(await readFile(`${rawDir}/${season}/games.json`, 'utf8'));
  const people = {};
  const games = [];
  let missing = 0;
  for (const g of list) {
    const f = `${rawDir}/${season}/${g.code}.json`;
    if (!(await access(f).then(() => true, () => false))) { missing++; continue; }
    const raw = JSON.parse(await readFile(f, 'utf8'));
    if (!raw?.local?.players || !raw?.road?.players) { missing++; continue; }
    const team = (side, meta, home) => ({
      code: meta.code, name: meta.name, score: meta.score, home,
      players: side.players.filter((p) => p.stats.timePlayed > 0).map(({ player: pl, stats: s }) => {
        // Fiche du joueur, une fois par saison (le club peut changer en cours de saison : on garde le dernier).
        people[pl.person.code] = {
          name: titleName(pl.person.name), position: pl.positionName, heightCm: pl.person.height || null,
          weightKg: pl.person.weight || null, country: pl.person.country?.name, birthDate: pl.person.birthDate?.slice(0, 10),
          club: pl.club?.abbreviatedName, clubCode: pl.club?.code,
        };
        return { id: pl.person.code, sec: s.timePlayed, pts: s.points, fgm: s.fieldGoalsMadeTotal, fga: s.fieldGoalsAttemptedTotal,
          fg3m: s.fieldGoalsMade3, fg3a: s.fieldGoalsAttempted3, ftm: s.freeThrowsMade, fta: s.freeThrowsAttempted,
          oreb: s.offensiveRebounds, reb: s.totalRebounds, ast: s.assistances, stl: s.steals, tov: s.turnovers,
          blk: s.blocksFavour, pf: s.foulsCommited, pm: s.plusMinus, pir: s.valuation, club: pl.club?.abbreviatedName };
      }),
    });
    games.push({ code: g.code, date: g.date, round: g.round, gameday: g.gameday,
      teams: [team(raw.local, g.home, true), team(raw.road, g.away, false)] });
  }
  games.sort((a, b) => (a.date < b.date ? -1 : 1));
  await writeFile(`data/history/${season}.json`, JSON.stringify({ season, games, people }));
  console.log(`${season} : ${games.length} matchs condensés${missing ? `, ${missing} fiches absentes` : ''}`);
}
