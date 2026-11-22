
const express = require('express');
const { Telegraf, session } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = 'https://api.football-data.org/v4';

if (!BOT_TOKEN || !FOOTBALL_DATA_TOKEN) {
  throw new Error('BOT_TOKEN ou FOOTBALL_DATA_TOKEN manquant.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
bot.use(session({ defaultSession: () => ({ mode: null }) }));

app.get('/', (_req, res) => res.status(200).send('⚽ Sport Analyzer AI V4 fonctionne.'));

// API
async function apiGet(path) {
  const response = await fetch(API_BASE + path, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error('Limite API atteinte. Réessaie plus tard.');
    if (response.status === 403) throw new Error('Accès API refusé ou compétition non autorisée.');
    if (response.status === 404) throw new Error('Données introuvables.');
    throw new Error(`Erreur API football (${response.status}).`);
  }

  return response.json();
}

// Cache équipes : 10 minutes
let teamsCache = [];
let teamsCacheTime = 0;

async function getTeams() {
  if (!teamsCache.length || Date.now() - teamsCacheTime > 10 * 60 * 1000) {
    const data = await apiGet('/teams?limit=500');
    teamsCache = data.teams || [];
    teamsCacheTime = Date.now();
  }

  return teamsCache;
}

// Normalisation des noms
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Alias
const aliases = {
  barcelona: ['fc barcelona', 'barca', 'barça'],
  barca: ['fc barcelona', 'barcelona', 'barça'],
  'real madrid': ['real madrid cf'],
  'manchester city': ['man city'],
  'manchester united': ['man utd'],
  psg: ['paris saint germain', 'paris sg'],
  inter: ['inter milan', 'fc internazionale'],
  'ac milan': ['milan'],
  'atletico madrid': ['atletico', 'atlético madrid'],
  bayern: ['fc bayern munchen', 'bayern munich'],
  dortmund: ['borussia dortmund'],
  chelsea: ['chelsea fc'],
  arsenal: ['arsenal fc'],
  liverpool: ['liverpool fc'],
  tottenham: ['tottenham hotspur'],
  juventus: ['juve', 'juventus fc']
};

// Recherche équipe
async function getTeamByName(name) {
  const teams = await getTeams();
  const wanted = normalizeName(name);
  const aliasesSet = new Set([wanted]);

  for (const [key, values] of Object.entries(aliases)) {
    const keyNorm = normalizeName(key);
    const valuesNorm = values.map(normalizeName);

    if (keyNorm === wanted || valuesNorm.includes(wanted)) {
      aliasesSet.add(keyNorm);
      valuesNorm.forEach(v => aliasesSet.add(v));
    }
  }

  const names = t => [
    normalizeName(t.name),
    normalizeName(t.shortName),
    normalizeName(t.tla)
  ].filter(Boolean);

  let matches = teams.filter(t =>
    names(t).some(n => aliasesSet.has(n))
  );

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new Error(`Plusieurs équipes correspondent à « ${name} ». Précise le nom complet.`);
  }

  matches = teams.filter(t =>
    names(t).some(n =>
      [...aliasesSet].some(p =>
        p.length >= 5 && (n.includes(p) || p.includes(n))
      )
    )
  );

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new Error(`Recherche ambiguë pour « ${name} ». Précise le nom complet de l'équipe.`);
  }

  throw new Error(`Équipe « ${name} » introuvable dans les compétitions accessibles.`);
}

// 5 derniers matchs terminés
async function getLastMatches(teamId, limit = 5) {
  const data = await apiGet(`/teams/${teamId}/matches?status=FINISHED&limit=50`);

  return (data.matches || [])
    .filter(m =>
      m.status === 'FINISHED' &&
      Number.isFinite(m.score?.fullTime?.home) &&
      Number.isFinite(m.score?.fullTime?.away) &&
      (m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    )
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);
}

// Résultat du point de vue de l'équipe
function matchResultForTeam(match, teamId) {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;
  const hg = match.score?.fullTime?.home;
  const ag = match.score?.fullTime?.away;

  if (
    !Number.isFinite(hg) ||
    !Number.isFinite(ag) ||
    (homeId !== teamId && awayId !== teamId)
  ) return null;

  const isHome = homeId === teamId;
  const gf = isHome ? hg : ag;
  const ga = isHome ? ag : hg;

  return {
    result: gf > ga ? 'V' : gf === ga ? 'N' : 'D',
    goalsFor: gf,
    goalsAgainst: ga,
    opponent: isHome ? match.awayTeam?.name : match.homeTeam?.name,
    date: match.utcDate,
    home: isHome
  };
}

// Statistiques
function summarizeMatches(team, matches) {
  const rows = matches
    .map(m => matchResultForTeam(m, team.id))
    .filter(Boolean);

  const wins = rows.filter(r => r.result === 'V').length;
  const draws = rows.filter(r => r.result === 'N').length;
  const losses = rows.filter(r => r.result === 'D').length;

  const goalsFor = rows.reduce((s, r) => s + r.goalsFor, 0);
  const goalsAgainst = rows.reduce((s, r) => s + r.goalsAgainst, 0);

  const countResults = list => ({
    count: list.length,
    wins: list.filter(r => r.result === 'V').length,
    draws: list.filter(r => r.result === 'N').length,
    losses: list.filter(r => r.result === 'D').length,
    goalsFor: list.reduce((s, r) => s + r.goalsFor, 0),
    goalsAgainst: list.reduce((s, r) => s + r.goalsAgainst, 0)
  });

  return {
    rows,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points: wins * 3 + draws,
    count: rows.length,
    home: countResults(rows.filter(r => r.home)),
    away: countResults(rows.filter(r => !r.home))
  };
}

// Analyse avancée
function advancedAnalysis(stats) {
  const n = stats.count;
  if (!n) return null;

  const avgGoalsFor = stats.goalsFor / n;
  const avgGoalsAgainst = stats.goalsAgainst / n;

  const matchesScored = stats.rows.filter(r => r.goalsFor > 0).length;
  const cleanSheets = stats.rows.filter(r => r.goalsAgainst === 0).length;

  const scoringRate = matchesScored / n * 100;
  const cleanSheetRate = cleanSheets / n * 100;
  const pointsPerMatch = stats.points / n;
  const winRate = stats.wins / n * 100;

  const recent = stats.rows.slice(0, 3);

  const recentPoints = recent.reduce(
    (s, r) => s + (r.result === 'V' ? 3 : r.result === 'N' ? 1 : 0),
    0
  );

  const recentGoals = recent.reduce((s, r) => s + r.goalsFor, 0);
  const recentConceded = recent.reduce((s, r) => s + r.goalsAgainst, 0);

  const attackLevel = avgGoalsFor >= 2
    ? '🔥 Très performante'
    : avgGoalsFor >= 1.5
    ? '🟢 Performante'
    : avgGoalsFor >= 1
    ? '🟡 Moyenne'
    : '🔴 Faible';

  const defenseLevel = avgGoalsAgainst <= 0.6
    ? '🛡️ Très solide'
    : avgGoalsAgainst <= 1
    ? '🟢 Solide'
    : avgGoalsAgainst <= 1.5
    ? '🟡 Moyenne'
    : '🔴 Fragile';

  const formLevel = pointsPerMatch >= 2.4
    ? '🔥 Excellente dynamique'
    : pointsPerMatch >= 1.8
    ? '🟢 Bonne dynamique'
    : pointsPerMatch >= 1
    ? '🟡 Dynamique irrégulière'
    : '🔴 Dynamique difficile';

  const reliability = n >= 5
    ? 'Bonne (5 matchs)'
    : n >= 3
    ? 'Partielle (moins de 5 matchs)'
    : 'Faible (moins de 3 matchs)';

  return {
    avgGoalsFor,
    avgGoalsAgainst,
    matchesScored,
    cleanSheets,
    scoringRate,
    cleanSheetRate,
    pointsPerMatch,
    winRate,
    attackLevel,
    defenseLevel,
    formLevel,
    recentPoints,
    recentGoals,
    recentConceded,
    reliability
  };
}

// Formatage des nombres
function formatNumber(value) {
  return Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Statistiques domicile / extérieur
function venueText(label, venue) {
  if (!venue.count) {
    return `${label}\nAucun match disponible sur la période.\n`;
  }

  return `${label}
Matchs : ${venue.count}
Victoires : ${venue.wins} | Nuls : ${venue.draws} | Défaites : ${venue.losses}
Buts marqués : ${venue.goalsFor} (${formatNumber(venue.goalsFor / venue.count)}/match)
Buts encaissés : ${venue.goalsAgainst} (${formatNumber(venue.goalsAgainst / venue.count)}/match)
`;
}

// Résumé équipe
function summaryText(team, stats) {
  const a = advancedAnalysis(stats);

  if (!a) return `📊 ${team.name}\n\nStatistiques indisponibles.`;

  const form = stats.rows.map(r => r.result).join(' - ') || 'Indisponible';

  const homeAway =
    venueText('🏠 À DOMICILE', stats.home) +
    '\n' +
    venueText('✈️ À L’EXTÉRIEUR', stats.away);

  return `📊 ${team.name}

📋 MATCHS ANALYSÉS : ${stats.count}
🟢 Victoires : ${stats.wins}
🟡 Nuls : ${stats.draws}
🔴 Défaites : ${stats.losses}
🏆 Points : ${stats.points}
📈 Points/match : ${formatNumber(a.pointsPerMatch)}
📊 Taux de victoire : ${formatNumber(a.winRate)} %

⚽ ATTAQUE
Buts marqués : ${stats.goalsFor}
Moyenne : ${formatNumber(a.avgGoalsFor)}/match
Matchs avec but : ${a.matchesScored}/${stats.count}
Efficacité : ${formatNumber(a.scoringRate)} %
Niveau : ${a.attackLevel}

🛡️ DÉFENSE
Buts encaissés : ${stats.goalsAgainst}
Moyenne encaissée : ${formatNumber(a.avgGoalsAgainst)}/match
Matchs sans encaisser : ${a.cleanSheets}/${stats.count}
Taux clean sheet : ${formatNumber(a.cleanSheetRate)} %
Niveau : ${a.defenseLevel}

📈 FORME RÉCENTE
${form}
${a.formLevel}

${homeAway}
🔎 3 DERNIERS MATCHS
Points : ${a.recentPoints}/9
Buts marqués : ${a.recentGoals}
Buts encaissés : ${a.recentConceded}

🔐 FIABILITÉ DES DONNÉES
${a.reliability}`;
}

// Comparaison des équipes
function compareTeams(a, b) {
  const A = advancedAnalysis(a.stats);
  const B = advancedAnalysis(b.stats);

  if (!A || !B) {
    return '⚠️ Comparaison insuffisante : données manquantes.';
  }

  const obs = [];

  obs.push(
    A.pointsPerMatch > B.pointsPerMatch
      ? `📈 ${a.team.name} a la meilleure dynamique.`
      : B.pointsPerMatch > A.pointsPerMatch
      ? `📈 ${b.team.name} a la meilleure dynamique.`
      : '📊 Dynamique similaire.'
  );

  obs.push(
    A.avgGoalsFor > B.avgGoalsFor
      ? `⚽ ${a.team.name} a la meilleure moyenne offensive.`
      : B.avgGoalsFor > A.avgGoalsFor
      ? `⚽ ${b.team.name} a la meilleure moyenne offensive.`
      : '⚽ Moyennes offensives identiques.'
  );

  obs.push(
    A.avgGoalsAgainst < B.avgGoalsAgainst
      ? `🛡️ ${a.team.name} a la défense la plus solide.`
      : B.avgGoalsAgainst < A.avgGoalsAgainst
      ? `🛡️ ${b.team.name} a la défense la plus solide.`
      : '🛡️ Défenses similaires.'
  );

  obs.push(
    A.scoringRate > B.scoringRate
      ? `🔥 ${a.team.name} marque plus régulièrement.`
      : B.scoringRate > A.scoringRate
      ? `🔥 ${b.team.name} marque plus régulièrement.`
      : '🔥 Régularité offensive similaire.'
  );

  const diff = Math.abs(A.pointsPerMatch - B.pointsPerMatch);

  const conclusion = diff < 0.2
    ? '⚖️ Statistiques proches : aucun avantage net.'
    : A.pointsPerMatch > B.pointsPerMatch
    ? `📌 ${a.team.name} présente les meilleurs résultats sur la période.`
    : `📌 ${b.team.name} présente les meilleurs résultats sur la période.`;

  return `🧠 ANALYSE AUTOMATIQUE

${obs.join('\n\n')}

${conclusion}

ℹ️ Analyse statistique des ${A.count} derniers matchs de chaque équipe. Elle ne prédit ni ne garantit un résultat futur.`;
}

// Analyse équipe
async function analyzeTeam(name) {
  const team = await getTeamByName(name);
  const matches = await getLastMatches(team.id, 5);
  const stats = summarizeMatches(team, matches);

  if (!stats.count) {
    throw new Error(`Aucun résultat récent disponible pour ${team.name}.`);
  }

  return { team, stats };
}

// Envoi messages longs
async function sendLongMessage(ctx, text) {
  const limit = 3900;

  if (text.length <= limit) return ctx.reply(text);

  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);

    if (cut < limit * 0.6) cut = limit;

    await ctx.reply(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) return ctx.reply(remaining);
}

// Analyse de deux équipes
async function analyzeMatch(ctx, matchText) {
  const parts = matchText.split(/\s+vs\.?\s+|\s+-\s+|\s+contre\s+/i);

  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return ctx.reply('❌ Format incorrect.\n\nExemple :\nReal Madrid vs Barcelona');
  }

  await ctx.reply('⏳ Analyse statistique des deux équipes…');

  try {
    const [a, b] = await Promise.all([
      analyzeTeam(parts[0].trim()),
      analyzeTeam(parts[1].trim())
    ]);

    ctx.session.mode = null;

    const full = `⚽ COMPARAISON DES ÉQUIPES

${summaryText(a.team, a.stats)}

━━━━━━━━━━━━━━

${summaryText(b.team, b.stats)}

━━━━━━━━━━━━━━

${compareTeams(a, b)}`;

    return sendLongMessage(ctx, full);
  } catch (err) {
    console.error('Erreur comparaison :', err.message);
    ctx.session.mode = null;

    return ctx.reply('⚠️ Analyse impossible.\n\n' + err.message);
  }
}

// START
bot.start(ctx => {
  ctx.session.mode = null;

  return ctx.reply(`⚽ BIENVENUE SUR SPORT ANALYZER AI V4

🤖 Assistant d’analyse football.

📊 COMMANDES :

/foot - Comparaison de deux équipes
/forme - Analyse détaillée d’une équipe
/live - Matchs en direct
/help - Assistance

Exemple :
/foot Real Madrid vs Barcelona`);
});

// HELP
bot.help(ctx => ctx.reply(`⚽ SPORT ANALYZER AI V4

/foot Real Madrid vs Barcelona
Comparaison complète.

/forme Real Madrid
Analyse détaillée.

/live
Matchs en direct.

Envoie une commande sans argument pour être guidé.`));

// FOOT
bot.command('foot', ctx => {
  const match = ctx.message.text
    .replace(/^\/foot(?:@\w+)?\s*/i, '')
    .trim();

  if (match) return analyzeMatch(ctx, match);

  ctx.session.mode = 'foot';

  return ctx.reply(`⚽ ANALYSE DE MATCH

Envoie les deux équipes sous cette forme :

Real Madrid vs Barcelona`);
});

// FORME
bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(?:@\w+)?\s*/i, '')
    .trim();

  if (!name) {
    ctx.session.mode = 'forme';

    return ctx.reply(`📊 ANALYSE DE FORME

Envoie le nom de l’équipe.

Exemple : Real Madrid`);
  }

  ctx.session.mode = null;
  await ctx.reply('⏳ Analyse détaillée de la forme…');

  try {
    const result = await analyzeTeam(name);
    return sendLongMessage(ctx, summaryText(result.team, result.stats));
  } catch (err) {
    console.error('Erreur forme :', err.message);

    return ctx.reply('⚠️ Données indisponibles.\n\n' + err.message);
  }
});

// LIVE : score actuel uniquement, sans score final en fallback
bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des matchs en direct…');

  try {
    const data = await apiGet('/matches?status=LIVE');
    const matches = data.matches || [];

    if (!matches.length) {
      return ctx.reply('🔴 Aucun match en direct disponible actuellement.');
    }

    const lines = matches.slice(0, 20).map(m => {
      const home = m.score?.regularTime?.home;
      const away = m.score?.regularTime?.away;

      const score = Number.isFinite(home) && Number.isFinite(away)
        ? `${home} - ${away}`
        : 'Score non disponible';

      return `🔴 ${m.homeTeam?.name || 'Domicile'} ${score} ${m.awayTeam?.name || 'Extérieur'}
⏱ Statut : ${m.status || 'En cours'}`;
    });

    return sendLongMessage(ctx, '🔴 MATCHS EN DIRECT\n\n' + lines.join('\n\n'));
  } catch (err) {
    console.error('Erreur live :', err.message);

    return ctx.reply('⚠️ Impossible de récupérer les matchs en direct.\n\n' + err.message);
  }
});

// Messages texte
bot.on('text', ctx => {
  const message = ctx.message.text.trim();

  if (message.startsWith('/')) return;

  if (ctx.session.mode === 'foot') {
    return analyzeMatch(ctx, message);
  }

  if (ctx.session.mode === 'forme') {
    ctx.session.mode = null;

    return ctx.reply(`⏳ Recherche de ${message}…`)
      .then(() => analyzeTeam(message))
      .then(result => sendLongMessage(ctx, summaryText(result.team, result.stats)))
      .catch(err => {
        console.error('Erreur analyse :', err.message);

        return ctx.reply('⚠️ Analyse impossible.\n\n' + err.message);
      });
  }

  return ctx.reply(`📩 Utilise une commande :

/foot - Comparaison de match
/forme - Forme récente
/live - Matchs en direct
/help - Assistance`);
});

// Erreurs
bot.catch(err => console.error('Erreur Telegram :', err));

// Serveur
app.listen(process.env.PORT || 3000, () => {
  console.log('Sport Analyzer AI V4 démarré.');
});

// Lancement bot
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
