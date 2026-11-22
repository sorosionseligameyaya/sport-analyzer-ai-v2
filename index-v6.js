
const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const API_BASE = 'https://api.football-data.org/v4';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

if (!BOT_TOKEN || !FOOTBALL_DATA_TOKEN) {
  throw new Error('BOT_TOKEN ou FOOTBALL_DATA_TOKEN manquant.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

app.get('/', (_req, res) => {
  res.status(200).send('Sport Analyzer AI V6 fonctionne.');
});

// =====================================
// API FOOTBALL-DATA
// =====================================


async function apiGet(path) {
  const response = await fetch(API_BASE + path, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  const details = await response.text();

  if (!response.ok) {
    console.error(
      'ERREUR FOOTBALL-DATA :',
      response.status,
      details
    );

    throw new Error(
      `Erreur API football (${response.status}) : ${details.slice(0, 300)}`
    );
  }

  return JSON.parse(details);
}

  const response = await fetch(API_BASE + path, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
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
// API-FOOTBALL : MATCHS ET COTES
// =====================================

async function apiFootballGet(path, params = {}) {
  if (!API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY absente dans Render.');
  }

  const query = new URLSearchParams(params).toString();
  const url = `${API_FOOTBALL_BASE}${path}?${query}`;

  const response = await fetch(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });

  if (!response.ok) {
    throw new Error(`Erreur API-Football (${response.status}).`);
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

function abidjanDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Abidjan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findAvailableSelection(oddsData) {
  const candidates = [];

  for (const bookmaker of oddsData[0]?.bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      const market = normalizeText(bet.name);

      for (const item of bet.values || []) {
        const odd = Number(item.odd);
        const value = String(item.value || '');
        const normalized = normalizeText(value);

        if (!Number.isFinite(odd) || odd < 1.20 || odd > 1.80) {
          continue;
        }

        let selection = null;

        if (
          market.includes('over/under') ||
          market.includes('total goals') ||
          market.includes('goals over')
        ) {
          if (
            normalized.includes('over 1.5') ||
            normalized.includes('over 1,5')
          ) {
            selection = 'Plus de 1,5 buts';
          }
        }

        if (
          market.includes('both teams to score') ||
          market.includes('both teams score') ||
          market === 'btts'
        ) {
          if (normalized === 'yes') {
            selection = 'Les deux équipes marquent : Oui';
          }
        }

        if (
          market.includes('match winner') ||
          market === '1x2'
        ) {
          if (['home', 'draw', 'away', '1', 'x', '2'].includes(normalized)) {
            selection = `Résultat : ${value}`;
          }
        }

        if (selection) {
          candidates.push({
            selection,
            odd,
            bookmaker: bookmaker.name || 'Non précisé',
            market: bet.name || 'Non précisé'
          });
        }
      }
    }
  }

  candidates.sort((a, b) => a.odd - b.odd);
  return candidates[0] || null;
}

// =====================================
// GÉNÉRATION DU COUPON
// =====================================

async function buildCoupon() {
  if (!API_FOOTBALL_KEY) {
    return '❌ Clé API-Football absente. Vérifie API_FOOTBALL_KEY dans Render.';
  }

  const today = abidjanDate(new Date());
  const tomorrow = abidjanDate(
    new Date(Date.now() + 24 * 60 * 60 * 1000)
  );

  const fixtures = await apiFootballGet('/fixtures', {
    from: today,
    to: tomorrow,
    timezone: 'Africa/Abidjan'
  });

  const upcoming = fixtures
    .filter(match =>
      ['NS', 'TBD'].includes(match.fixture?.status?.short)
    )
    .filter(match =>
      match.fixture?.id &&
      match.teams?.home?.name &&
      match.teams?.away?.name
    )
    .sort((a, b) =>
      new Date(a.fixture.date) - new Date(b.fixture.date)
    )
    .slice(0, 8);

  if (!upcoming.length) {
    return 'ℹ️ Aucun match à venir trouvé pour aujourd’hui et demain.';
  }

  const selections = [];

  for (const match of upcoming) {
    try {
      const oddsData = await apiFootballGet('/odds', {
        fixture: String(match.fixture.id)
      });

      const pick = findAvailableSelection(oddsData);

      if (pick) {
        selections.push({
          home: match.teams.home.name,
          away: match.teams.away.name,
          date: match.fixture.date,
          ...pick
        });
      }
    } catch (error) {
      console.error('Cotes indisponibles :', error.message);
    }
  }

  if (selections.length < 2) {
    return `⚠️ Pas assez de cotes disponibles pour créer un coupon fiable.

Matchs examinés : ${upcoming.length}
Sélections avec cotes : ${selections.length}

Aucune cote n'a été inventée. Réessaie plus tard.`;
  }

  const chosen = selections
    .sort((a, b) => a.odd - b.odd)
    .slice(0, 3);

  const combinedOdd = chosen.reduce(
    (total, item) => total * item.odd,
    1
  );

  let message = '🎟️ SPORT ANALYZER AI — COUPON V6\n\n';

  chosen.forEach((item, index) => {
    const matchDate = new Date(item.date).toLocaleString('fr-FR', {
      timeZone: 'Africa/Abidjan',
      dateStyle: 'short',
      timeStyle: 'short'
    });

    message += `${index + 1}. ⚽ ${item.home} - ${item.away}\n`;
    message += `🎯 ${item.selection}\n`;
    message += `📈 Cote : ${item.odd.toFixed(2)}\n`;
    message += `🏦 Source : ${item.bookmaker}\n`;
    message += `🕒 ${matchDate}\n\n`;
  });

  message += '━━━━━━━━━━━━━━━━\n';
  message += `🔢 Cote combinée indicative : ${combinedOdd.toFixed(2)}\n\n`;
  message += '⚠️ Les cotes peuvent changer avant le coup d’envoi.\n';
  message += '⚠️ Vérifie chaque sélection chez ton bookmaker.\n';
  message += 'ℹ️ Une cote ne garantit jamais un résultat.';

  return message;
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
    const main = normalizeName(mainName);
    const normalizedVariations = variations.map(normalizeName);

    if (
      target === main ||
      normalizedVariations.includes(target)
    ) {
      found = candidates.find(item =>
        item.name === main ||
        item.shortName === main ||
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
      match.score?.fullTime &&
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

  let points = 1;
  let result = 'N';

  if (goalsFor > goalsAgainst) {
    points = 3;
    result = 'V';
  } else if (goalsFor < goalsAgainst) {
    points = 0;
    result = 'D';
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

  if (n >= 5) reliability = 'Bonne';
  else if (n >= 3) reliability = 'Moyenne';

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
// FORMATAGE DE L'ANALYSE
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

ℹ️ Ces scores sont des indicateurs statistiques, pas des probabilités.
`;
}

// =====================================
// ANALYSE D'UNE ÉQUIPE
// =====================================

async function analyzeTeam(teamName) {
  const teams = await getTeams();
  const team = findTeamByName(teamName, teams);

  if (!team) {
    return `❌ Équipe introuvable : ${teamName}`;
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
    return 'Données insuffisantes pour comparer ces équipes.';
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
Stabilité : ${B.consistency.toFixed(0)}/100
Performance : ${B.performanceScore}/100

━━━━━━━━━━━━━━━━

🏆 AVANTAGE STATISTIQUE : ${advantage}

ℹ️ Comparaison basée sur les cinq derniers matchs disponibles.
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
    return ctx.reply('🔴 Aucun match en direct disponible actuellement.');
  }

  let message = '🔴 MATCHS EN DIRECT\n\n';

  for (const match of matches) {
    const home = match.homeTeam?.name || 'Équipe domicile';
    const away = match.awayTeam?.name || 'Équipe extérieure';

    const scoreData =
      match.score?.fullTime ||
      match.score?.regularTime;

    const score =
      Number.isFinite(scoreData?.home) &&
      Number.isFinite(scoreData?.away)
        ? `${scoreData.home} - ${scoreData.away}`
        : 'Score indisponible';

    message += `⚽ ${home} - ${away}\n`;
    message += `📊 Score : ${score}\n`;
    message += `⏱️ Statut : ${match.status}\n\n`;
  }

  await sendLongMessage(ctx, message);
}

// =====================================
// COMMANDES TELEGRAM
// =====================================

bot.start(ctx => {
  return ctx.reply(`
👋 Bienvenue sur SPORT ANALYZER AI V6 !

⚽ Ton assistant d'analyse du football.

📌 COMMANDES :

/forme Real Madrid
Analyser une équipe.

/foot Real Madrid vs Barcelona
Comparer deux équipes.

/live
Voir les matchs en direct.

/coupon
Générer un coupon avec les cotes disponibles.

/cotes
Consulter les sélections et cotes disponibles.

/fifa
Informations sur les matchs virtuels.

/help
Afficher le guide.

🚀 VERSION V6
Analyse statistique et recherche de cotes.
`);
});

bot.help(ctx => {
  return ctx.reply(`
📚 GUIDE SPORT ANALYZER AI V6

1. Analyse d'équipe :
/forme Real Madrid

2. Comparaison :
/foot Real Madrid vs Barcelona

3. Matchs en direct :
/live

4. Coupon :
/coupon

5. Cotes :
/cotes

6. Football virtuel :
/fifa

ℹ️ Les résultats dépendent des données fournies par les API.
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
      '❌ Format incorrect.\nExemple : /foot Real Madrid vs Barcelona'
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
// COMMANDE COUPON
// =====================================

bot.command('coupon', async ctx => {
  await ctx.reply('⏳ Recherche des matchs et des cotes disponibles...');

  try {
    const message = await buildCoupon();
    await sendLongMessage(ctx, message);
  } catch (error) {
    console.error('Erreur coupon :', error);
    await ctx.reply(`❌ Impossible de générer le coupon : ${error.message}`);
  }
});

bot.command('cotes', async ctx => {
  await ctx.reply('⏳ Recherche des cotes disponibles...');

  try {
    const message = await buildCoupon();
    await sendLongMessage(ctx, message);
  } catch (error) {
    console.error('Erreur cotes :', error);
    await ctx.reply(`❌ Erreur : ${error.message}`);
  }
});

// =====================================
// COMMANDE FIFA / VIRTUEL
// =====================================

bot.command('fifa', ctx => {
  return ctx.reply(`
🎮 ANALYSE FIFA / E-FOOTBALL

Cette fonction n'est pas encore connectée à une source de résultats virtuels.

Je ne vais pas inventer des matchs, des scores ou des cotes.

Une API spécialisée dans les compétitions virtuelles sera nécessaire.
`);
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
    console.log('Sport Analyzer AI V6 démarré.');
  })
  .catch(error => {
    console.error('Erreur démarrage Telegram :', error);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
