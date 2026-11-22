
const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = 'https://api.football-data.org/v4';

if (!BOT_TOKEN || !FOOTBALL_DATA_TOKEN) {
  throw new Error('BOT_TOKEN ou FOOTBALL_DATA_TOKEN manquant.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

app.get('/', (_req, res) => {
  res.status(200).send('Sport Analyzer AI V5 fonctionne.');
});

// =====================================
// API FOOTBALL
// =====================================

async function apiGet(path) {
  const response = await fetch(API_BASE + path, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Limite API atteinte. Réessaie plus tard.');
    }
    if (response.status === 403) {
      throw new Error('Accès API refusé ou compétition non autorisée.');
    }
    if (response.status === 404) {
      throw new Error('Données introuvables.');
    }

    throw new Error(`Erreur API football (${response.status}).`);
  }

  return response.json();
}

// =====================================
// CACHE DES ÉQUIPES
// =====================================

let teamsCache = [];
let teamsCacheTime = 0;

async function getTeams() {
  if (
    !teamsCache.length ||
    Date.now() - teamsCacheTime > 10 * 60 * 1000
  ) {
    const data = await apiGet('/teams?limit=500');
    teamsCache = data.teams || [];
    teamsCacheTime = Date.now();
  }

  return teamsCache;
}

// =====================================
// RECHERCHE DES ÉQUIPES
// =====================================

function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const aliases = {
  'real madrid': ['real madrid cf'],
  'barcelona': ['fc barcelona', 'barca'],
  'atletico madrid': ['atletico de madrid'],
  'manchester united': ['man united', 'man utd'],
  'manchester city': ['man city'],
  'paris saint germain': ['psg', 'paris sg'],
  'bayern munich': ['fc bayern munchen'],
  'inter milan': ['inter'],
  'ac milan': ['milan'],
  'borussia dortmund': ['dortmund', 'bvb'],
  'tottenham': ['tottenham hotspur'],
  'arsenal': ['arsenal fc'],
  'chelsea': ['chelsea fc'],
  'liverpool': ['liverpool fc']
};

function findTeamByName(name, teams) {
  const target = normalizeName(name);

  if (!target) return null;

  const candidates = teams.map(team => ({
    team,
    name: normalizeName(team.name),
    shortName: normalizeName(team.shortName),
    tla: normalizeName(team.tla)
  }));

  let found = candidates.find(item =>
    item.name === target ||
    item.shortName === target ||
    item.tla === target
  );

  if (found) return found.team;

  for (const [mainName, variations] of Object.entries(aliases)) {
    const normalizedMain = normalizeName(mainName);
    const normalizedVariations = variations.map(normalizeName);

    if (
      target === normalizedMain ||
      normalizedVariations.includes(target)
    ) {
      found = candidates.find(item =>
        item.name === normalizedMain ||
        item.shortName === normalizedMain ||
        normalizedVariations.includes(item.name) ||
        normalizedVariations.includes(item.shortName)
      );

      if (found) return found.team;
    }
  }

  found = candidates.find(item =>
    item.name.includes(target) ||
    target.includes(item.name)
  );

  return found ? found.team : null;
}

// =====================================
// DERNIERS MATCHS
// =====================================

async function getLastMatches(teamId) {
  const data = await apiGet(
    `/teams/${teamId}/matches?status=FINISHED&limit=20`
  );

  return (data.matches || [])
    .filter(match =>
      match.status === 'FINISHED' &&
      match.score &&
      match.score.fullTime &&
      Number.isFinite(match.score.fullTime.home) &&
      Number.isFinite(match.score.fullTime.away)
    )
    .sort((a, b) =>
      new Date(b.utcDate) - new Date(a.utcDate)
    )
    .slice(0, 5);
}

// =====================================
// RÉSULTAT D'UN MATCH
// =====================================

function matchResultForTeam(match, teamId) {
  const home = match.homeTeam.id === teamId;

  const goalsFor = home
    ? match.score.fullTime.home
    : match.score.fullTime.away;

  const goalsAgainst = home
    ? match.score.fullTime.away
    : match.score.fullTime.home;

  let points = 0;
  let result = 'N';

  if (goalsFor > goalsAgainst) {
    points = 3;
    result = 'V';
  } else if (goalsFor < goalsAgainst) {
    points = 0;
    result = 'D';
  } else {
    points = 1;
    result = 'N';
  }

  return {
    goalsFor,
    goalsAgainst,
    points,
    result,
    opponent: home ? match.awayTeam.name : match.homeTeam.name,
    date: match.utcDate
  };
}

// =====================================
// RÉSUMÉ DES MATCHS
// =====================================

function summarizeMatches(matches, teamId) {
  const rows = matches.map(match =>
    matchResultForTeam(match, teamId)
  );

  const wins = rows.filter(row => row.result === 'V').length;
  const draws = rows.filter(row => row.result === 'N').length;
  const losses = rows.filter(row => row.result === 'D').length;

  const goalsFor = rows.reduce(
    (sum, row) => sum + row.goalsFor, 0
  );

  const goalsAgainst = rows.reduce(
    (sum, row) => sum + row.goalsAgainst, 0
  );

  const points = rows.reduce(
    (sum, row) => sum + row.points, 0
  );

  return {
    rows,
    count: rows.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points,
    avgGoalsFor: rows.length ? goalsFor / rows.length : 0,
    avgGoalsAgainst: rows.length ? goalsAgainst / rows.length : 0,
    scoringRate: rows.length
      ? rows.filter(row => row.goalsFor > 0).length / rows.length * 100
      : 0,
    cleanSheets: rows.filter(row => row.goalsAgainst === 0).length
  };
}

// =====================================
// ANALYSE AVANCÉE V5
// =====================================

function advancedAnalysis(stats) {
  const n = stats.count;

  if (!n) {
    return {
      ...stats,
      weightedPoints: 0,
      weightedGoals: 0,
      weightedConceded: 0,
      consistency: 0,
      formScore: 0,
      attackScore: 0,
      defenseScore: 0,
      performanceScore: 0,
      reliability: 'Données insuffisantes'
    };
  }

  const weights = [3, 2, 1, 1, 1].slice(0, n);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const weightedPoints = stats.rows.reduce(
    (sum, row, index) =>
      sum + row.points * weights[index],
    0
  ) / totalWeight;

  const weightedGoals = stats.rows.reduce(
    (sum, row, index) =>
      sum + row.goalsFor * weights[index],
    0
  ) / totalWeight;

  const weightedConceded = stats.rows.reduce(
    (sum, row, index) =>
      sum + row.goalsAgainst * weights[index],
    0
  ) / totalWeight;

  const pointValues = stats.rows.map(row => row.points);
  const averagePoints = pointValues.reduce((a, b) => a + b, 0) / n;

  const variance = pointValues.reduce(
    (sum, value) =>
      sum + Math.pow(value - averagePoints, 2),
    0
  ) / n;

  const standardDeviation = Math.sqrt(variance);

  const consistency = Math.max(
    0,
    Math.min(100, 100 - (standardDeviation / 1.5) * 100)
  );

  const formScore = (weightedPoints / 3) * 100;

  const attackScore = Math.min(
    100,
    (stats.avgGoalsFor / 3) * 70 +
    (stats.scoringRate * 0.30)
  );

  const defenseScore = Math.max(
    0,
    Math.min(100, 100 - stats.avgGoalsAgainst * 25)
  );

  const performanceScore = Math.round(
    formScore * 0.35 +
    attackScore * 0.25 +
    defenseScore * 0.25 +
    consistency * 0.15
  );

  let reliability = 'Faible';

  if (n >= 5) {
    reliability = 'Bonne';
  } else if (n >= 3) {
    reliability = 'Moyenne';
  }

  return {
    ...stats,
    weightedPoints,
    weightedGoals,
    weightedConceded,
    consistency,
    formScore,
    attackScore,
    defenseScore,
    performanceScore,
    reliability
  };
}

// =====================================
// FORMATAGE
// =====================================

function summaryText(teamName, stats) {
  const form = stats.rows.map(row => row.result).join(' - ');

  return `
⚽ ANALYSE DE ${teamName.toUpperCase()}

📋 MATCHS ANALYSÉS : ${stats.count}

🟢 Victoires : ${stats.wins}
🟡 Nuls : ${stats.draws}
🔴 Défaites : ${stats.losses}

⚽ Buts marqués : ${stats.goalsFor}
🥅 Buts encaissés : ${stats.goalsAgainst}

📊 Moyenne buts marqués : ${stats.avgGoalsFor.toFixed(2)}
📊 Moyenne buts encaissés : ${stats.avgGoalsAgainst.toFixed(2)}

🎯 Matchs avec au moins un but marqué : ${stats.scoringRate.toFixed(0)}%
🧤 Matchs sans encaisser : ${stats.cleanSheets}

📈 FORME RÉCENTE
${form || 'Aucun résultat disponible'}

🔥 INDICATEURS V5

⭐ Performance : ${stats.performanceScore}/100
⚔️ Attaque : ${stats.attackScore.toFixed(0)}/100
🛡️ Défense : ${stats.defenseScore.toFixed(0)}/100
📊 Stabilité des résultats : ${stats.consistency.toFixed(0)}/100

🎯 Points pondérés par match : ${stats.weightedPoints.toFixed(2)}

🔎 Fiabilité des données : ${stats.reliability}

ℹ️ Ces scores sont des indicateurs statistiques, pas des probabilités de résultat.
`;
}

// =====================================
// ANALYSE D'UNE ÉQUIPE
// =====================================

async function analyzeTeam(teamName) {
  const teams = await getTeams();
  const team = findTeamByName(teamName, teams);

  if (!team) {
    return `❌ Équipe introuvable : ${teamName}

Vérifie l'orthographe ou essaie le nom officiel.`;
  }

  const matches = await getLastMatches(team.id);
  const stats = advancedAnalysis(
    summarizeMatches(matches, team.id)
  );

  if (!stats.count) {
    return `Aucun match terminé trouvé pour ${team.name}.`;
  }

  return summaryText(team.name, stats);
}

// =====================================
// COMPARAISON DE DEUX ÉQUIPES
// =====================================

async function compareTeams(teamAName, teamBName) {
  const teams = await getTeams();

  const teamA = findTeamByName(teamAName, teams);
  const teamB = findTeamByName(teamBName, teams);

  if (!teamA) return `❌ Équipe introuvable : ${teamAName}`;
  if (!teamB) return `❌ Équipe introuvable : ${teamBName}`;

  if (teamA.id === teamB.id) {
    return '❌ Choisis deux équipes différentes.';
  }

  const [matchesA, matchesB] = await Promise.all([
    getLastMatches(teamA.id),
    getLastMatches(teamB.id)
  ]);

  const A = advancedAnalysis(
    summarizeMatches(matchesA, teamA.id)
  );

  const B = advancedAnalysis(
    summarizeMatches(matchesB, teamB.id)
  );

  if (!A.count || !B.count) {
    return 'Données insuffisantes pour comparer ces deux équipes.';
  }

  let advantage = 'Équilibre statistique';

  if (A.performanceScore > B.performanceScore) {
    advantage = teamA.name;
  } else if (B.performanceScore > A.performanceScore) {
    advantage = teamB.name;
  }

  return `
⚽ COMPARAISON DES ÉQUIPES

📊 ${teamA.name}
Matchs analysés : ${A.count}
Victoires : ${A.wins}
Nuls : ${A.draws}
Défaites : ${A.losses}
Buts marqués : ${A.goalsFor}
Buts encaissés : ${A.goalsAgainst}
Moyenne de buts marqués : ${A.avgGoalsFor.toFixed(2)}
Attaque : ${A.attackScore.toFixed(0)}/100
Défense : ${A.defenseScore.toFixed(0)}/100
Forme pondérée : ${A.weightedPoints.toFixed(2)} points/match
Stabilité : ${A.consistency.toFixed(0)}/100
Performance : ${A.performanceScore}/100

━━━━━━━━━━━━━━━━

📊 ${teamB.name}
Matchs analysés : ${B.count}
Victoires : ${B.wins}
Nuls : ${B.draws}
Défaites : ${B.losses}
Buts marqués : ${B.goalsFor}
Buts encaissés : ${B.goalsAgainst}
Moyenne de buts marqués : ${B.avgGoalsFor.toFixed(2)}
Attaque : ${B.attackScore.toFixed(0)}/100
Défense : ${B.defenseScore.toFixed(0)}/100
Forme pondérée : ${B.weightedPoints.toFixed(2)} points/match
Stabilité : ${B.consistency.toFixed(0)}/100
Performance : ${B.performanceScore}/100

━━━━━━━━━━━━━━━━

🏆 AVANTAGE STATISTIQUE : ${advantage}

ℹ️ Comparaison basée sur les cinq derniers matchs disponibles.
Les scores ne sont pas des probabilités de victoire.
`;
}

// =====================================
// ENVOI DES LONGS MESSAGES
// =====================================

async function sendLongMessage(ctx, message) {
  const maxLength = 3900;

  for (let i = 0; i < message.length; i += maxLength) {
    await ctx.reply(message.slice(i, i + maxLength));
  }
}

// =====================================
// MATCHS EN DIRECT
// =====================================

async function getLiveMatches() {
  const data = await apiGet('/matches?status=IN_PLAY');
  return data.matches || [];
}

async function sendLiveMatches(ctx) {
  const matches = await getLiveMatches();

  if (!matches.length) {
    return ctx.reply(
      '🔴 Aucun match en direct disponible actuellement.'
    );
  }

  let message = '🔴 MATCHS EN DIRECT\n\n';

  for (const match of matches) {
    const home = match.homeTeam.name;
    const away = match.awayTeam.name;

    const score = match.score &&
      match.score.regularTime &&
      Number.isFinite(match.score.regularTime.home) &&
      Number.isFinite(match.score.regularTime.away)
      ? `${match.score.regularTime.home} - ${match.score.regularTime.away}`
      : 'Score indisponible';

    const minute = match.minute
      ? `${match.minute} min`
      : match.status;

    message += `
⚽ ${home} - ${away}
📊 Score : ${score}
⏱️ ${minute}

`;
  }

  await sendLongMessage(ctx, message);
}

// =====================================
// COMMANDES TELEGRAM
// =====================================

bot.start(ctx => {
  return ctx.reply(`
👋 Bienvenue sur SPORT ANALYZER AI V5 !

⚽ Ton assistant d'analyse statistique du football.

📌 COMMANDES :

/forme Real Madrid
Analyser une équipe.

/foot Real Madrid vs Barcelona
Comparer deux équipes.

/live
Voir les matchs en direct.

/help
Afficher l'aide.

📊 V5 : forme pondérée, attaque, défense, stabilité et performance.
`);
});

bot.help(ctx => {
  return ctx.reply(`
📚 GUIDE SPORT ANALYZER AI V5

1️⃣ Analyse d'une équipe :

/forme Real Madrid

2️⃣ Comparaison de deux équipes :

/foot Real Madrid vs Barcelona

3️⃣ Matchs en direct :

/live

ℹ️ Les analyses reposent sur les données disponibles via l'API football.
`);
});

bot.command('forme', async ctx => {
  const teamName = ctx.message.text
    .replace(/^\/forme(@\w+)?/i, '')
    .trim();

  if (!teamName) {
    return ctx.reply('Utilisation : /forme Real Madrid');
  }

  await ctx.reply('⏳ Analyse statistique de l’équipe...');

  try {
    const result = await analyzeTeam(teamName);
    await sendLongMessage(ctx, result);
  } catch (error) {
    console.error('Erreur forme :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

bot.command('foot', async ctx => {
  const input = ctx.message.text
    .replace(/^\/foot(@\w+)?/i, '')
    .trim();

  if (!input) {
    return ctx.reply('Utilisation : /foot Real Madrid vs Barcelona');
  }

  const parts = input.split(/\s+(?:vs\.?|contre)\s+/i);

  if (
    parts.length !== 2 ||
    !parts[0].trim() ||
    !parts[1].trim()
  ) {
    return ctx.reply(
      '❌ Format incorrect.\n\nExemple : /foot Real Madrid vs Barcelona'
    );
  }

  await ctx.reply('⏳ Analyse statistique des deux équipes...');

  try {
    const result = await compareTeams(
      parts[0].trim(),
      parts[1].trim()
    );

    await sendLongMessage(ctx, result);
  } catch (error) {
    console.error('Erreur comparaison :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des matchs en direct...');

  try {
    await sendLiveMatches(ctx);
  } catch (error) {
    console.error('Erreur live :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

// =====================================
// GESTION DES ERREURS
// =====================================

bot.catch((error, ctx) => {
  console.error('Erreur Telegram :', error);

  return ctx.reply(
    'Une erreur est survenue. Réessaie dans quelques instants.'
  ).catch(console.error);
});

// =====================================
// DÉMARRAGE DU SERVEUR
// =====================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur actif sur le port ${PORT}`);
});

bot.launch()
  .then(() => {
    console.log('Sport Analyzer AI V5 démarré.');
  })
  .catch(error => {
    console.error('Erreur démarrage Telegram :', error);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
