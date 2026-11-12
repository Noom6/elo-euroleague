// Mise à jour complète : télécharge la saison en cours, la condense, puis recalcule l'Elo.
// C'est ce que lance la tâche automatique GitHub chaque nuit. Usage : node update.js
import { execFileSync } from 'node:child_process';

// La saison Euroleague commence en septembre-octobre : à partir de septembre on est dans la saison « année en cours ».
const now = new Date();
const year = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const season = `E${year}`;

const run = (...args) => execFileSync(process.execPath, args, { stdio: 'inherit' });
console.log(`Saison en cours : ${season}`);
run('fetch-euroleague.js', season);
run('compact.js', season);
run('build-euroleague.js');
