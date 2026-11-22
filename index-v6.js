
'use strict';

const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const API_BASE = 'https://api.football-data.org/v4';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN manquant dans les variables Render.');
}

if (typeof fetch !== 'function') {
  throw new Error('Node.js 18 ou supérieur est nécessaire.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

app.get('/', (_req, res) => {
  res.status(200).send('SPORT ANALYZER AI fonctionne.');
});

// ======================================
// OUTILS COMMUNS
// ======================================

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sendLongMessage(ctx, message) {
  const maxLength = 3900;

  for (let i = 0; i < message.length; i += maxLength) {
    await ctx.reply(message.slice(i, i + maxLength));
  }
}

function getAbidjanDate(date) {
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

// ======================================
// API FOOTBALL-DATA
// ======================================

async function apiGet(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error(
      'FOOTBALL_DATA_TOKEN absent dans les variables Render.'
    );
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  const body = await response.text();

  if (!response.ok) {
    console.error(
      'ERREUR FOOTBALL-DATA:',
      response.status,
      body
    );

    throw new Error(
      `Football-data (${response.status}) : ${body.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Réponse invalide reçue de Football-data.');
  }
}

// ======================================
// RECHERCHE DES ÉQUIPES
// ======================================

let teamsCache = [];
let teamsCacheTime = 0;

const COMPETITIONS = [
  'PL',
  'PD',
  'BL1',
  'SA',
  'FL1',
  'CL',
  'ELC',
  'PPL',
  'DED'
];

async function getTeams() {
  const cacheValid =
    teamsCache.length > 0 &&
    Date.now() - teamsCacheTime < 30 * 60 * 1000;

  if (cacheValid) {
    return teamsCache;
  }

  const foundTeams = new Map();
  const errors = [];

  for (const code of COMPETITIONS) {
    try {
      const data = await apiGet(
        `/competitions/${code}/teams`
      );

      for (const team of data.teams || []) {
        if (team.id) {
          foundTeams.set(team.id, team);
        }
      }
    } catch (error) {
      errors.push(`${code}: ${error.message}`);
      console.log(`Compétition ${code} indisponible.`);
    }
  }

  teamsCache = Array.from(foundTeams.values());
  teamsCacheTime = Date.now();

  if (!teamsCache.length) {
    throw new Error(
      'Aucune équipe récupérée. Vérifie ton accès Football-data et les compétitions autorisées.'
    );
  }

  return teamsCache;
}

const aliases = {
  'real madrid': ['real madrid cf'],
  'barcelona': ['fc barcelona', 'barca'],
  'atletico madrid': ['atletico de madrid'],
  'manchester united': ['man utd', 'man united'],
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
  const target = normalize(name);

  if (!target) return null;

  let found = teams.find(team =>
    normalize(team.name) === target ||
    normalize(team.shortName) === target ||
    normalize(team.tla) === target
  );

  if (found) return found;

  for (const [mainName, variations] of Object.entries(aliases)) {
    const names = [mainName, ...variations].map(normalize);

    if (names.includes(target)) {
      found = teams.find(team =>
        names.includes(normalize(team.name)) ||
        names.includes(normalize(team.shortName))
      );

      if (found) return found;
    }
  }

  return teams.find(team => {
    const teamName = normalize(team.name);
    return teamName.includes(target) ||
      target.includes(teamName);
  }) || null;
}

// ======================================
// DERNIERS MATCHS
// ======================================

async function getLastMatches(teamId) {
  const data = await apiGet(
    `/teams/${teamId}/matches?status=FINISHED&limit=20`
  );

  return (data.matches || [])
    .filter(match =>
      match.status === 'FINISHED' &&
      Number.isFinite(match.score?.fullTime?.home) &&
      Number.isFinite(match.score?.fullTime?.away)
    )
    .sort((a, b) =>
      new Date(b.utcDate) - new Date(a.utcDate)
    )
    .slice(0, 5);
}

function matchResultForTeam(match, teamId) {
  const isHome = match.homeTeam.id === teamId;

  const goalsFor = isHome
    ? match.score.fullTime.home
    : match.score.fullTime.away;

  const goalsAgainst = isHome
    ? match.score.fullTime.away
    : match.score.fullTime.home;

  let result = 'N';
  let points = 1;

  if (goalsFor > goalsAgainst) {
    result = 'V';
    points = 3;
  } else if (goalsFor < goalsAgainst) {
    result = 'D';
    points = 0;
  }

  return {
    result,
    points,
    goalsFor,
    goalsAgainst
  };
}

function calculateStats(matches, teamId) {
  const rows = matches.map(match =>
    matchResultForTeam(match, teamId)
  );

  const count = rows.length;

  const wins = rows.filter(r => r.result === 'V').length;
  const draws = rows.filter(r => r.result === 'N').length;
  const losses = rows.filter(r => r.result === 'D').length;

  const goalsFor = rows.reduce(
    (sum, r) => sum + r.goalsFor, 0
  );

  const goalsAgainst = rows.reduce(
    (sum, r) => sum + r.goalsAgainst, 0
  );

  const points = rows.reduce(
    (sum, r) => sum + r.points, 0
  );

  const avgGoalsFor = count ? goalsFor / count : 0;
  const avgGoalsAgainst = count ? goalsAgainst / count : 0;

  const scoringRate = count
    ? rows.filter(r => r.goalsFor > 0).length / count * 100
    : 0;

  const cleanSheets = rows.filter(
    r => r.goalsAgainst === 0
  ).length;

  const attackScore = Math.min(
    100,
    avgGoalsFor / 3 * 70 + scoringRate * 0.30
  );

  const defenseScore = Math.max(
    0,
    Math.min(100, 100 - avgGoalsAgainst * 25)
  );

  const formScore = count ? points / (count * 3) * 100 : 0;

  const performanceScore = Math.round(
    formScore * 0.40 +
    attackScore * 0.30 +
    defenseScore * 0.30
  );

  return {
    rows,
    count,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    avgGoalsFor,
    avgGoalsAgainst,
    scoringRate,
    cleanSheets,
    attackScore,
    defenseScore,
    formScore,
    performanceScore
  };
}

function formatStats(name, stats) {
  const form = stats.rows
    .map(row => row.result)
    .join(' - ');

  return `
⚽ ANALYSE DE ${name.toUpperCase()}

📋 Matchs analysés : ${stats.count}

🟢 Victoires : ${stats.wins}
🟡 Nuls : ${stats.draws}
🔴 Défaites : ${stats.losses}

⚽ Buts marqués : ${stats.goalsFor}
🥅 Buts encaissés : ${stats.goalsAgainst}

📊 Moyenne de buts marqués : ${stats.avgGoalsFor.toFixed(2)}
📊 Moyenne de buts encaissés : ${stats.avgGoalsAgainst.toFixed(2)}

🎯 Matchs avec au moins un but marqué : ${stats.scoringRate.toFixed(0)}%
🧤 Matchs sans encaisser : ${stats.cleanSheets}

📈 Forme récente :
${form || 'Indisponible'}

⚔️ Attaque : ${stats.attackScore.toFixed(0)}/100
🛡️ Défense : ${stats.defenseScore.toFixed(0)}/100
⭐ Performance : ${stats.performanceScore}/100

ℹ️ Ces indicateurs ne sont pas des probabilités de victoire.
`;
}

// ======================================
// COMMANDE FORME
// ======================================

async function analyzeTeam(name) {
  const teams = await getTeams();
  const team = findTeamByName(name, teams);

  if (!team) {
    return `Équipe introuvable : ${name}`;
  }

  const matches = await getLastMatches(team.id);
  const stats = calculateStats(matches, team.id);

  if (!stats.count) {
    return `Pas assez de résultats disponibles pour ${team.name}.`;
  }

  return formatStats(team.name, stats);
}

// ======================================
// COMPARAISON DES ÉQUIPES
// ======================================

async function compareTeams(nameA, nameB) {
  const teams = await getTeams();

  const teamA = findTeamByName(nameA, teams);
  const teamB = findTeamByName(nameB, teams);

  if (!teamA) return `Équipe introuvable : ${nameA}`;
  if (!teamB) return `Équipe introuvable : ${nameB}`;

  if (teamA.id === teamB.id) {
    return 'Choisis deux équipes différentes.';
  }

  const [matchesA, matchesB] = await Promise.all([
    getLastMatches(teamA.id),
    getLastMatches(teamB.id)
  ]);

  const A = calculateStats(matchesA, teamA.id);
  const B = calculateStats(matchesB, teamB.id);

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
Matchs : ${A.count}
Victoires : ${A.wins}
Nuls : ${A.draws}
Défaites : ${A.losses}
Buts marqués : ${A.goalsFor}
Buts encaissés : ${A.goalsAgainst}
Moyenne buts marqués : ${A.avgGoalsFor.toFixed(2)}
Performance : ${A.performanceScore}/100

━━━━━━━━━━━━━━━━

📊 ${teamB.name}
Matchs : ${B.count}
Victoires : ${B.wins}
Nuls : ${B.draws}
Défaites : ${B.losses}
Buts marqués : ${B.goalsFor}
Buts encaissés : ${B.goalsAgainst}
Moyenne buts marqués : ${B.avgGoalsFor.toFixed(2)}
Performance : ${B.performanceScore}/100

🏆 Avantage statistique : ${advantage}

ℹ️ Comparaison des cinq derniers matchs disponibles.
`;
}

// ======================================
// MATCHS EN DIRECT
// ======================================

async function getLiveMatches() {
  const data = await apiGet('/matches?status=IN_PLAY');
  return data.matches || [];
}

async function showLiveMatches(ctx) {
  const matches = await getLiveMatches();

  if (!matches.length) {
    return ctx.reply('🔴 Aucun match en direct disponible.');
  }

  let message = '🔴 MATCHS EN DIRECT\n\n';

  for (const match of matches) {
    const home = match.homeTeam?.name || 'Équipe domicile';
    const away = match.awayTeam?.name || 'Équipe extérieure';

    const score = match.score?.fullTime;

    const scoreText =
      Number.isFinite(score?.home) &&
      Number.isFinite(score?.away)
        ? `${score.home} - ${score.away}`
        : 'Score indisponible';

    message += `⚽ ${home} - ${away}\n`;
    message += `📊 Score : ${scoreText}\n`;
    message += `⏱️ Statut : ${match.status}\n\n`;
  }

  return sendLongMessage(ctx, message);
}

// ======================================
// API-FOOTBALL : MATCHS ET COTES
// ======================================

async function apiFootballGet(path, params = {}) {
  if (!API_FOOTBALL_KEY) {
    throw new Error('Clé API-Football absente dans Render.');
  }

  const query = new URLSearchParams(params).toString();
  const url = `${API_FOOTBALL_BASE}${path}?${query}`;

  const response = await fetch(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`API-Football (${response.status}) : ${body.slice(0, 200)}`);
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Réponse API-Football invalide.');
  }

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

// ======================================
// ANALYSE DES COTES
// ======================================

function findSelection(oddsData) {
  const candidates = [];

  for (const bookmaker of oddsData[0]?.bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      const market = normalize(bet.name);

      for (const item of bet.values || []) {
        const odd = Number(item.odd);
        const value = normalize(item.value);

        if (!Number.isFinite(odd) || odd < 1.20 || odd > 1.80) {
          continue;
        }

        let selection = null;

        if (
          (market.includes('over under') ||
           market.includes('total goals')) &&
          (value.includes('over 1.5') || value.includes('over 1 5'))
        ) {
          selection = 'Plus de 1,5 buts';
        }

        if (
          (market.includes('both teams to score') ||
           market === 'btts') &&
          value === 'yes'
        ) {
          selection = 'Les deux équipes marquent : Oui';
        }

        if (
          market.includes('match winner') &&
          ['home', 'draw', 'away'].includes(value)
        ) {
          selection = `Résultat : ${item.value}`;
        }

        if (selection) {
          candidates.push({
            selection,
            odd,
            bookmaker: bookmaker.name || 'Non précisé'
          });
        }
      }
    }
  }

  candidates.sort((a, b) => a.odd - b.odd);
  return candidates[0] || null;
}

// ======================================
// GÉNÉRATION DU COUPON
// ======================================

async function buildCoupon() {
  if (!API_FOOTBALL_KEY) {
    return '❌ La clé API-Football est absente.';
  }

  const today = getAbidjanDate(new Date());

  const tomorrow = getAbidjanDate(
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
    return 'ℹ️ Aucun match à venir trouvé aujourd’hui ou demain.';
  }

  const selections = [];

  for (const match of upcoming) {
    try {
      const odds = await apiFootballGet('/odds', {
        fixture: String(match.fixture.id)
      });

      const pick = findSelection(odds);

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
    return `⚠️ Pas assez de cotes disponibles.

Matchs examinés : ${upcoming.length}
Sélections trouvées : ${selections.length}

Aucune cote n'a été inventée.
Vérifie l'accès à ton compte API-Football.`;
  }

  const chosen = selections
    .sort((a, b) => a.odd - b.odd)
    .slice(0, 3);

  const combinedOdd = chosen.reduce(
    (total, item) => total * item.odd,
    1
  );

  let message = '🎟️ SPORT ANALYZER AI — COUPON\n\n';

  chosen.forEach((item, index) => {
    const date = new Date(item.date).toLocaleString('fr-FR', {
      timeZone: 'Africa/Abidjan',
      dateStyle: 'short',
      timeStyle: 'short'
    });

    message += `${index + 1}. ⚽ ${item.home} - ${item.away}\n`;
    message += `🎯 ${item.selection}\n`;
    message += `📈 Cote : ${item.odd.toFixed(2)}\n`;
    message += `🏦 Source : ${item.bookmaker}\n`;
    message += `🕒 ${date}\n\n`;
  });

  message += '━━━━━━━━━━━━━━━━\n';
  message += `🔢 Cote combinée indicative : ${combinedOdd.toFixed(2)}\n\n`;
  message += '⚠️ Les cotes peuvent changer.\n';
  message += '⚠️ Vérifie les sélections avant toute utilisation.\n';
  message += 'ℹ️ Aucun résultat n’est garanti.';

  return message;
}

// ======================================
// COMMANDES TELEGRAM
// ======================================

bot.start(ctx => {
  return ctx.reply(`
👋 BIENVENUE SUR SPORT ANALYZER AI !

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
Consulter les cotes.

/fifa
Informations sur le football virtuel.

/help
Afficher le guide.
`);
});

bot.help(ctx => {
  return ctx.reply(`
📚 GUIDE SPORT ANALYZER AI

/forme Real Madrid
/foot Real Madrid vs Barcelona
/live
/coupon
/cotes
/fifa

Les données dépendent des API connectées.
`);
});

bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(@\w+)?/i, '')
    .trim();

  if (!name) {
    return ctx.reply('Utilisation : /forme Real Madrid');
  }

  await ctx.reply('⏳ Analyse de l’équipe en cours...');

  try {
    const result = await analyzeTeam(name);
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

  const parts = input.split(/\s+(?:vs\.?|contre)\s+/i);

  if (
    parts.length !== 2 ||
    !parts[0].trim() ||
    !parts[1].trim()
  ) {
    return ctx.reply(
      'Utilisation : /foot Real Madrid vs Barcelona'
    );
  }

  await ctx.reply('⏳ Comparaison des équipes en cours...');

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
    await showLiveMatches(ctx);
  } catch (error) {
    console.error('Erreur live :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

bot.command('coupon', async ctx => {
  await ctx.reply('⏳ Recherche des matchs et des cotes...');

  try {
    const result = await buildCoupon();
    await sendLongMessage(ctx, result);
  } catch (error) {
    console.error('Erreur coupon :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

bot.command('cotes', async ctx => {
  await ctx.reply('⏳ Recherche des cotes disponibles...');

  try {
    const result = await buildCoupon();
    await sendLongMessage(ctx, result);
  } catch (error) {
    console.error('Erreur cotes :', error);
    await ctx.reply(`❌ ${error.message}`);
  }
});

bot.command('fifa', ctx => {
  return ctx.reply(`
🎮 ANALYSE FIFA / E-FOOTBALL

Cette fonction n'est pas encore connectée à une source de matchs virtuels.

Je ne vais pas inventer de matchs, de résultats ou de cotes.

Une API spécialisée sera nécessaire pour activer cette fonction.
`);
});

// ======================================
// ERREURS TELEGRAM
// ======================================

bot.catch((error, ctx) => {
  console.error('Erreur Telegram :', error);

  return ctx.reply(
    'Une erreur est survenue. Réessaie dans quelques instants.'
  ).catch(console.error);
});

// ======================================
// DÉMARRAGE
// ======================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur actif sur le port ${PORT}`);
});

bot.launch()
  .then(() => {
    console.log('SPORT ANALYZER AI démarré.');
  })
  .catch(error => {
    console.error('Erreur démarrage Telegram :', error);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

async function askAI(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  try {
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || 'openrouter/free',
          messages: [
            {
              role: 'system',
              content: 'Tu es un analyste football. Analyse uniquement les données reçues. N invente aucune statistique. Réponds en français et explique les tendances, les forces, les faiblesses et les risques.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3,
          max_tokens: 500
        })
      }
    );

    if (!response.ok) {
      console.error('Erreur OpenRouter:', response.status);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;

  } catch (error) {
    console.error('Erreur IA:', error.message);
    return null;
  }
}
// ======================================
// CERVEAU IA - OPENROUTER
// ======================================

async function askAI(prompt) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    console.error('Clé OPENROUTER_API_KEY absente.');
    return null;
  }

  try {
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || 'openrouter/free',
          messages: [
            {
              role: 'system',
              content: `Tu es SPORT ANALYZER AI, un analyste expert du football.

Tu analyses uniquement les données qui te sont fournies.

Tu dois :
- Analyser la forme récente.
- Examiner les performances offensives.
- Examiner les faiblesses défensives.
- Identifier les tendances de buts.
- Détecter les signaux contradictoires.
- Évaluer les risques d'analyse.
- Distinguer les faits des hypothèses.

Tu ne dois jamais inventer de statistiques, de résultats, de blessures, de compositions ou de probabilités.

Si les données sont insuffisantes, dis-le clairement.

Réponds en français, de manière claire, structurée et professionnelle.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 700
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erreur OpenRouter:', response.status, errorText);
      return null;
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content || null;

  } catch (error) {
    console.error('Erreur cerveau IA:', error.message);
    return null;
  }
}
// ======================================
// CERVEAU IA - OPENROUTER
// ======================================
async function askAI(prompt) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    console.error('Clé OPENROUTER_API_KEY absente.');
    return null;
  }

  try {
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_MODEL || 'openrouter/free',
          messages: [
            {
              role: 'system',
              content: `Tu es SPORT ANALYZER AI, un analyste expert du football.
Tu analyses uniquement les données qui te sont fournies.
Tu étudies la forme récente, l'attaque, la défense, les buts,
les tendances, les contradictions et les risques.
Tu n'inventes jamais de statistiques, résultats, blessures,
compositions, probabilités ou informations.
Si les données sont insuffisantes, tu le dis clairement.
Tu réponds en français, de manière structurée et professionnelle.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 700
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erreur OpenRouter:', response.status, errorText);
      return null;
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content || null;

  } catch (error) {
    console.error('Erreur cerveau IA:', error.message);
    return null;
  }
}
