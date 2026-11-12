// Télécharge les matchs joués et les fiches de stats de l'Euroleague (API publique officielle).
// Usage : node fetch-euroleague.js E2025 E2026
// Les fichiers déjà téléchargés sont gardés : relancer le script ne récupère que les nouveaux matchs.
import { mkdir, writeFile, access } from 'node:fs/promises';

const seasons = process.argv.slice(2).length ? process.argv.slice(2) : ['E2025', 'E2026'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => access(f).then(() => true, () => false);
const tag = (xml, t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1];

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i >= tries) throw new Error(`${url} : ${e.message}`);
      await sleep(1500 * i);
    }
  }
}

for (const season of seasons) {
  const dir = `data/raw/${season}`;
  await mkdir(dir, { recursive: true });
  const xml = await get(`https://api-live.euroleague.net/v1/results?seasonCode=${season}`);
  const games = [...xml.matchAll(/<game>([\s\S]*?)<\/game>/g)].map((m) => m[1])
    .filter((g) => tag(g, 'played') === 'true')
    .map((g) => ({
      season, code: Number(tag(g, 'gamenumber')), round: tag(g, 'round'), gameday: Number(tag(g, 'gameday')),
      date: new Date(`${tag(g, 'date')} ${tag(g, 'time')} UTC`).toISOString(),
      home: { code: tag(g, 'homecode'), name: tag(g, 'hometeam'), score: Number(tag(g, 'homescore')) },
      away: { code: tag(g, 'awaycode'), name: tag(g, 'awayteam'), score: Number(tag(g, 'awayscore')) },
    }));
  await writeFile(`${dir}/games.json`, JSON.stringify(games, null, 1));

  // Calendrier des matchs à venir (heures officielles, heure de Paris), pour les pronostics.
  try {
    const sx = await get(`https://api-live.euroleague.net/v1/schedules?seasonCode=${season}`);
    const upcoming = [...sx.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1])
      .filter((g) => tag(g, 'played') === 'false')
      .map((g) => {
        const d = new Date(`${tag(g, 'date')} 12:00 UTC`);
        return { code: Number(tag(g, 'game')), round: tag(g, 'round'), gameday: Number(tag(g, 'gameday')),
          date: d.toISOString().slice(0, 10), time: tag(g, 'startime'), confirmed: tag(g, 'confirmedtime') === 'true',
          arena: tag(g, 'arenaname'),
          home: { code: tag(g, 'homecode'), name: tag(g, 'hometeam') }, away: { code: tag(g, 'awaycode'), name: tag(g, 'awayteam') } };
      })
      .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
    await writeFile(`${dir}/schedule.json`, JSON.stringify(upcoming, null, 1));
    console.log(`${season} : ${upcoming.length} matchs à venir au calendrier`);
  } catch (e) { console.error(`Calendrier ${season} indisponible : ${e.message}`); }

  let fetched = 0, failed = 0;
  const todo = [];
  for (const g of games) if (!(await exists(`${dir}/${g.code}.json`))) todo.push(g);
  // 3 téléchargements à la fois, avec une pause : on reste poli avec le serveur.
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (g) => {
      try {
        const body = await get(`https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/${season}/games/${g.code}/stats`);
        await writeFile(`${dir}/${g.code}.json`, body); fetched++;
      } catch (e) { failed++; console.error(e.message); }
    }));
    await sleep(300);
  }
  console.log(`${season} : ${games.length} matchs joués, ${fetched} téléchargés, ${games.length - todo.length} déjà là, ${failed} en échec`);
}
