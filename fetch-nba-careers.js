// Récupère depuis Wikidata (données ouvertes, licence CC0) la liste des joueurs passés par la NBA,
// avec leur date de naissance et leurs années dans des franchises NBA.
// Sert à donner un Elo d'arrivée plus élevé aux joueurs qui débarquent de NBA.
// Usage : node fetch-nba-careers.js   → écrit data/nba-careers.json
import { writeFile, mkdir } from 'node:fs/promises';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'EloBasketPrototype/0.1 (prototype de classement basket)';

async function sparql(query) {
  const r = await fetch(`${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Wikidata HTTP ${r.status} : ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).results.bindings;
}

// Joueurs ayant une fiche Basketball-Reference NBA (P2685), donc au moins un match NBA.
const players = await sparql(`
SELECT ?p ?label ?dob WHERE {
  ?p wdt:P2685 ?bref .
  OPTIONAL { ?p wdt:P569 ?dob }
  ?p rdfs:label ?label . FILTER(LANG(?label) = "en")
}`);

// Leurs passages dans des équipes dont la ligue est la NBA (Q155223), avec dates quand elles existent.
const stints = await sparql(`
SELECT ?p ?start ?end WHERE {
  ?p wdt:P2685 ?bref .
  ?p p:P54 ?st . ?st ps:P54 ?team .
  ?team wdt:P118 wd:Q155223 .
  OPTIONAL { ?st pq:P580 ?start }
  OPTIONAL { ?st pq:P582 ?end }
}`);

const byId = new Map();
for (const b of players) {
  const id = b.p.value.split('/').pop();
  byId.set(id, { id, name: b.label.value, dob: b.dob?.value.slice(0, 10) ?? null, stints: [] });
}
for (const b of stints) {
  const p = byId.get(b.p.value.split('/').pop());
  if (p) p.stints.push({ start: b.start?.value.slice(0, 4) ?? null, end: b.end?.value.slice(0, 4) ?? null });
}
await mkdir('data', { recursive: true });
await writeFile('data/nba-careers.json', JSON.stringify([...byId.values()]));
const withDates = [...byId.values()].filter((p) => p.stints.some((s) => s.start)).length;
console.log(`${byId.size} joueurs NBA, ${[...byId.values()].filter((p) => p.dob).length} avec date de naissance, ${withDates} avec des années en NBA`);
