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

app.get('/', (req, res) => {
  res.status(200).send('⚽ Sport Analyzer AI V2 - Moteur d’analyse actif.');
});

// =============================================
// API FOOTBALL
// =============================================

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
      throw new Error('Accès API refusé. Vérifie les compétitions autorisées.');
    }

    if (response.status === 404) {
      throw new Error('Données introuvables.');
    }

    throw new Error(`Erreur API football (${response.status}).`);
  }

  return response.json();
}

// =============================================
// CACHE DES ÉQUIPES
// =============================================

let teamsCache = [];
let teamsCacheTime = 0;

async function getTeams() {
  const cacheDuration = 10 * 60 * 1000;

  if (
    !teamsCache.length ||
    Date.now() - teamsCacheTime > cacheDuration
  ) {
    const data = await apiGet('/teams?limit=500');

    teamsCache = data.teams || [];
    teamsCacheTime = Date.now();
  }

  return teamsCache;
}

// =============================================
// NORMALISATION
// =============================================

function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const aliases = {
  'barcelona': ['fc barcelona', 'barca', 'barça'],
  'barca': ['fc barcelona', 'barcelona', 'barça'],
  'real madrid': ['real madrid cf'],
  'manchester city': ['man city'],
  'manchester united': ['man utd'],
  'psg': ['paris saint germain', 'paris sg'],
  'inter': ['inter milan', 'fc internazionale'],
  'ac milan': ['milan'],
  'atletico madrid': ['atletico', 'atlético madrid'],
  'bayern': ['fc bayern munchen', 'bayern munich'],
  'dortmund': ['borussia dortmund'],
  'chelsea': ['chelsea fc'],
  'arsenal': ['arsenal fc'],
  'liverpool': ['liverpool fc'],
  'tottenham': ['tottenham hotspur'],
  'juventus': ['juve', 'juventus fc']
};

// =============================================
// RECHERCHE D'ÉQUIPE
// =============================================

async function getTeamByName(name) {
  const teams = await getTeams();
  const wanted = normalizeName(name);

  const possibleNames = [wanted];

  for (const [key, values] of Object.entries(aliases)) {
    const normalizedKey = normalizeName(key);
    const normalizedValues = values.map(normalizeName);

    if (
      normalizedKey === wanted ||
      normalizedValues.includes(wanted)
    ) {
      possibleNames.push(normalizedKey, ...normalizedValues);
    }
  }

  const matchesName = team => {
    const names = [
      normalizeName(team.name),
      normalizeName(team.shortName),
      normalizeName(team.tla)
    ];

    return names.some(n => possibleNames.includes(n));
  };

  let team = teams.find(matchesName);

  if (!team) {
    team = teams.find(t => {
      const names = [
        normalizeName(t.name),
        normalizeName(t.shortName)
      ];

      return names.some(n =>
          possibleNames.some(p =>
            p.length >= 4 &&
            (n.includes(p) || p.includes(n))
          )
        );
    });
  }

  if (!team) {
    throw new Error(
      `Équipe "${name}" introuvable dans les compétitions accessibles.`
    );
  }

  return team;
}

// =============================================
// DERNIERS MATCHS
// =============================================

async function getLastMatches(teamId, limit = 5) {
  const data = await apiGet(
    `/teams/${teamId}/matches?status=FINISHED&limit=20`
  );

  return (data.matches || [])
    .filter(m =>
      m.status === 'FINISHED' &&
      m.score?.fullTime?.home !== null &&
      m.score?.fullTime?.away !== null &&
      m.score?.fullTime?.home !== undefined &&
      m.score?.fullTime?.away !== undefined
    )
    .sort((a, b) =>
      new Date(b.utcDate) - new Date(a.utcDate)
    )
    .slice(0, limit);
}

// =============================================
// RÉSULTAT D'UN MATCH POUR UNE ÉQUIPE
// =============================================

function matchResultForTeam(match, teamId) {
  const homeId = match.homeTeam?.id;

  const homeGoals = match.score?.fullTime?.home;
  const awayGoals = match.score?.fullTime?.away;

  if (
    homeGoals === null ||
    awayGoals === null ||
    homeGoals === undefined ||
    awayGoals === undefined
  ) {
    return null;
  }

  const isHome = homeId === teamId;

  const goalsFor = isHome ? homeGoals : awayGoals;
  const goalsAgainst = isHome ? awayGoals : homeGoals;

  let result;

  if (goalsFor > goalsAgainst) {
    result = 'V';
  } else if (goalsFor === goalsAgainst) {
    result = 'N';
  } else {
    result = 'D';
  }

  return {
    result,
    goalsFor,
    goalsAgainst,
    opponent: isHome
      ? match.awayTeam?.name
      : match.homeTeam?.name,
    date: match.utcDate,
    home: isHome
  };
}

// =============================================
// STATISTIQUES
// =============================================

function summarizeMatches(team, matches) {
  const rows = matches
    .map(m => matchResultForTeam(m, team.id))
    .filter(Boolean);

  const wins = rows.filter(r => r.result === 'V').length;
  const draws = rows.filter(r => r.result === 'N').length;
  const losses = rows.filter(r => r.result === 'D').length;

  const goalsFor = rows.reduce(
    (total, r) => total + r.goalsFor,
    0
  );

  const goalsAgainst = rows.reduce(
    (total, r) => total + r.goalsAgainst,
    0
  );

  const homeRows = rows.filter(r => r.home);
  const awayRows = rows.filter(r => !r.home);

  const homeWins = homeRows.filter(r => r.result === 'V').length;
  const awayWins = awayRows.filter(r => r.result === 'V').length;

  return {
    rows,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points: wins * 3 + draws,
    count: rows.length,

    homeCount: homeRows.length,
    homeWins,
    homeGoalsFor: homeRows.reduce((t, r) => t + r.goalsFor, 0),
    homeGoalsAgainst: homeRows.reduce((t, r) => t + r.goalsAgainst, 0),

    awayCount: awayRows.length,
    awayWins,
    awayGoalsFor: awayRows.reduce((t, r) => t + r.goalsFor, 0),
    awayGoalsAgainst: awayRows.reduce((t, r) => t + r.goalsAgainst, 0)
  };
}

// =============================================
// MOTEUR D'ANALYSE AVANCÉ
// =============================================

function advancedAnalysis(stats) {
  const count = stats.count;

  if (!count) return null;

  const avgGoalsFor = stats.goalsFor / count;
  const avgGoalsAgainst = stats.goalsAgainst / count;

  const matchesScored = stats.rows.filter(
    r => r.goalsFor > 0
  ).length;

  const cleanSheets = stats.rows.filter(
    r => r.goalsAgainst === 0
  ).length;

  const matchesConceded = stats.rows.filter(
    r => r.goalsAgainst > 0
  ).length;

  const scoringRate = (matchesScored / count) * 100;
  const cleanSheetRate = (cleanSheets / count) * 100;

  const pointsPerMatch = stats.points / count;
  const winRate = (stats.wins / count) * 100;

  let attackLevel;

  if (avgGoalsFor >= 2) {
    attackLevel = '🔥 Très performante';
  } else if (avgGoalsFor >= 1.5) {
    attackLevel = '🟢 Performante';
  } else if (avgGoalsFor >= 1) {
    attackLevel = '🟡 Moyenne';
  } else {
    attackLevel = '🔴 Faible';
  }

  let defenseLevel;

  if (avgGoalsAgainst <= 0.6) {
    defenseLevel = '🛡️ Très solide';
  } else if (avgGoalsAgainst <= 1) {
    defenseLevel = '🟢 Solide';
  } else if (avgGoalsAgainst <= 1.5) {
    defenseLevel = '🟡 Moyenne';
  } else {
    defenseLevel = '🔴 Fragile';
  }

  let formLevel;

  if (pointsPerMatch >= 2.4) {
    formLevel = '🔥 Excellente dynamique';
  } else if (pointsPerMatch >= 1.8) {
    formLevel = '🟢 Bonne dynamique';
  } else if (pointsPerMatch >= 1) {
    formLevel = '🟡 Dynamique irrégulière';
  } else {
    formLevel = '🔴 Dynamique difficile';
  }

  return {
    avgGoalsFor,
    avgGoalsAgainst,
    matchesScored,
    matchesConceded,
    cleanSheets,
    scoringRate,
    cleanSheetRate,
    pointsPerMatch,
    winRate,
    attackLevel,
    defenseLevel,
    formLevel
  };
}

// =============================================
// FORMATAGE
// =============================================

function formatNumber(value) {
  return Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function summaryText(team, stats) {
  const advanced = advancedAnalysis(stats);

  const form = stats.rows.length
    ? stats.rows.map(r => r.result).join(' - ')
    : 'Données indisponibles';

  if (!advanced) {
    return `📊 ${team.name}\n\nStatistiques indisponibles.`;
  }

  return (
    `📊 ${team.name}\n\n` +

    `📋 MATCHS ANALYSÉS : ${stats.count}\n` +
    `🟢 Victoires : ${stats.wins}\n` +
    `🟡 Nuls : ${stats.draws}\n` +
    `🔴 Défaites : ${stats.losses}\n` +
    `🏆 Points : ${stats.points}/${stats.count * 3}\n` +
    `📈 Points par match : ${formatNumber(advanced.pointsPerMatch)}\n` +
    `📊 Taux de victoire : ${formatNumber(advanced.winRate)} %\n\n` +

    `⚽ ATTAQUE\n` +
    `Buts marqués : ${stats.goalsFor}\n` +
    `Moyenne : ${formatNumber(advanced.avgGoalsFor)} / match\n` +
    `Matchs avec but : ${advanced.matchesScored}/${stats.count}\n` +
    `Efficacité : ${formatNumber(advanced.scoringRate)} %\n` +
    `Niveau : ${advanced.attackLevel}\n\n` +

    `🛡️ DÉFENSE\n` +
    `Buts encaissés : ${stats.goalsAgainst}\n` +
    `Moyenne encaissée : ${formatNumber(advanced.avgGoalsAgainst)} / match\n` +
    `Matchs sans encaisser : ${advanced.cleanSheets}/${stats.count}\n` +
    `Taux de clean sheet : ${formatNumber(advanced.cleanSheetRate)} %\n` +
    `Niveau : ${advanced.defenseLevel}\n\n` +

    `📈 FORME\n` +
    `${form}\n` +
    `${advanced.formLevel}`
  );
}

// =============================================
// CONCLUSION AUTOMATIQUE
// =============================================

function compareTeams(a, b) {
  const A = advancedAnalysis(a.stats);
  const B = advancedAnalysis(b.stats);

  if (!A || !B) {
    return '⚠️ Comparaison insuffisante : données manquantes.';
  }

  const observations = [];

  // Forme générale
  if (A.pointsPerMatch > B.pointsPerMatch) {
    observations.push(
      `📈 ${a.team.name} possède une meilleure dynamique de résultats.`
    );
  } else if (B.pointsPerMatch > A.pointsPerMatch) {
    observations.push(
      `📈 ${b.team.name} possède une meilleure dynamique de résultats.`
    );
  } else {
    observations.push(
      '📊 Les deux équipes ont une dynamique de résultats similaire.'
    );
  }

  // Attaque
  if (A.avgGoalsFor > B.avgGoalsFor) {
    observations.push(
      `⚽ ${a.team.name} affiche une meilleure moyenne offensive.`
    );
  } else if (B.avgGoalsFor > A.avgGoalsFor) {
    observations.push(
      `⚽ ${b.team.name} affiche une meilleure moyenne offensive.`
    );
  } else {
    observations.push(
      '⚽ Les moyennes offensives sont identiques.'
    );
  }

  // Défense
  if (A.avgGoalsAgainst < B.avgGoalsAgainst) {
    observations.push(
      `🛡️ ${a.team.name} présente une meilleure solidité défensive.`
    );
  } else if (B.avgGoalsAgainst < A.avgGoalsAgainst) {
    observations.push(
      `🛡️ ${b.team.name} présente une meilleure solidité défensive.`
    );
  } else {
    observations.push(
      '🛡️ Les performances défensives sont similaires.'
    );
  }

  // Régularité offensive
  if (A.scoringRate > B.scoringRate) {
    observations.push(
      `🔥 ${a.team.name} a marqué plus régulièrement.`
    );
  } else if (B.scoringRate > A.scoringRate) {
    observations.push(
      `🔥 ${b.team.name} a marqué plus régulièrement.`
    );
  }

  // Conclusion basée sur les points par match
  let conclusion;

  const difference = Math.abs(
    A.pointsPerMatch - B.pointsPerMatch
  );

  if (difference < 0.2) {
    conclusion =
      '⚖️ Les statistiques sont très proches. ' +
      'La comparaison ne permet pas de dégager une différence nette.';
  } else if (A.pointsPerMatch > B.pointsPerMatch) {
    conclusion =
      `📌 Sur la période étudiée, ${a.team.name} présente ` +
      'les meilleurs résultats globaux.';
  } else {
    conclusion =
      `📌 Sur la période étudiée, ${b.team.name} présente ` +
      'les meilleurs résultats globaux.';
  }

  return (
    `🧠 ANALYSE AUTOMATIQUE\n\n` +
    observations.join('\n\n') +
    `\n\n${conclusion}\n\n` +
    `ℹ️ Cette analyse repose uniquement sur les ${a.stats.count} ` +
    `derniers matchs disponibles de chaque équipe. ` +
    `Elle ne constitue pas une certitude sur un futur match.`
  );
}

// =============================================
// ANALYSE D'ÉQUIPE
// =============================================

async function analyzeTeam(name) {
  const team = await getTeamByName(name);
  const matches = await getLastMatches(team.id, 5);
  const stats = summarizeMatches(team, matches);

  if (!stats.count) {
    throw new Error(
      `Aucun résultat récent disponible pour ${team.name}.`
    );
  }

  return { team, stats };
}

// =============================================
// COMPARAISON DE MATCH
// =============================================

async function analyzeMatch(ctx, matchText) {
  const parts = matchText.split(
    /\s+vs\.?\s+|\s+-\s+|\s+contre\s+/i
  );

  if (
    parts.length !== 2 ||
    !parts[0].trim() ||
    !parts[1].trim()
  ) {
    return ctx.reply(
      '❌ Format incorrect.\n\n' +
      'Exemple :\n' +
      'Real Madrid vs Barcelona'
    );
  }

  await ctx.reply('⏳ Analyse statistique des deux équipes…');

  try {
    const [a, b] = await Promise.all([
      analyzeTeam(parts[0].trim()),
      analyzeTeam(parts[1].trim())
    ]);

    ctx.session.mode = null;

    return ctx.reply(
      `⚽ COMPARAISON DES ÉQUIPES\n\n` +
      `${summaryText(a.team, a.stats)}\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `${summaryText(b.team, b.stats)}\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `${compareTeams(a, b)}`
    );

  } catch (err) {
    console.error('Erreur comparaison :', err.message);
    ctx.session.mode = null;

    return ctx.reply(
      '⚠️ Analyse impossible.\n\n' +
      err.message
    );
  }
}

// =============================================
// ACCUEIL
// =============================================

bot.start(ctx => {
  ctx.session.mode = null;

  return ctx.reply(
    '⚽ BIENVENUE SUR SPORT ANALYZER AI V2\n\n' +
    '🤖 Ton assistant d’analyse football.\n\n' +
    '📊 COMMANDES :\n\n' +
    '/foot - Comparaison de deux équipes\n' +
    '/forme - Analyse détaillée d’une équipe\n' +
    '/live - Matchs en direct\n' +
    '/help - Assistance\n\n' +
    'Exemple :\n' +
    '/foot Real Madrid vs Barcelona'
  );
});

// =============================================
// AIDE
// =============================================

bot.help(ctx => {
  return ctx.reply(
    '⚽ SPORT ANALYZER AI V2\n\n' +
    '📊 /foot Real Madrid vs Barcelona\n' +
    'Comparaison statistique et conclusion automatique.\n\n' +
    '📈 /forme Real Madrid\n' +
    'Analyse détaillée de la forme récente.\n\n' +
    '🔴 /live\n' +
    'Consulter les matchs en direct.\n\n' +
    'Tu peux également envoyer une commande sans argument ' +
    'et répondre ensuite à la question du bot.'
  );
});

// =============================================
// COMMANDE FOOT
// =============================================

bot.command('foot', ctx => {
  const match = ctx.message.text
    .replace(/^\/foot(?:@\w+)?\s*/i, '')
    .trim();

  if (match) {
    return analyzeMatch(ctx, match);
  }

  ctx.session.mode = 'foot';

  return ctx.reply(
    '⚽ ANALYSE DE MATCH\n\n' +
    'Envoie les deux équipes sous cette forme :\n\n' +
    'Real Madrid vs Barcelona'
  );
});

// =============================================
// COMMANDE FORME
// =============================================

bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(?:@\w+)?\s*/i, '')
    .trim();

  if (!name) {
    ctx.session.mode = 'forme';

    return ctx.reply(
      '📊 ANALYSE DE FORME\n\n' +
      'Envoie le nom de l’équipe.\n\n' +
      'Exemple : Real Madrid'
    );
  }

  ctx.session.mode = null;

  await ctx.reply('⏳ Analyse détaillée de la forme…');

  try {
    const result = await analyzeTeam(name);

    return ctx.reply(
      summaryText(result.team, result.stats)
    );

  } catch (err) {
    console.error('Erreur forme :', err.message);

    return ctx.reply(
      '⚠️ Données indisponibles.\n\n' +
      err.message
    );
  }
});

// =============================================
// COMMANDE LIVE
// =============================================

bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des matchs en direct…');

  try {
    const data = await apiGet('/matches?status=LIVE');
    const matches = data.matches || [];

    if (!matches.length) {
      return ctx.reply(
        '🔴 Aucun match en direct disponible actuellement.'
      );
    }

    const lines = matches.slice(0, 20).map(m => {
      const home = m.score?.fullTime?.home;
      const away = m.score?.fullTime?.away;

      const score =
        home !== null && home !== undefined &&
        away !== null && away !== undefined
          ? `${home} - ${away}`
          : 'Score non disponible';

      return (
        `🔴 ${m.homeTeam.name} ${score} ${m.awayTeam.name}\n` +
        `⏱ Statut : ${m.status || 'En cours'}`
      );
    });

    return ctx.reply(
      '🔴 MATCHS EN DIRECT\n\n' +
      lines.join('\n\n')
    );

  } catch (err) {
    console.error('Erreur live :', err.message);

    return ctx.reply(
      '⚠️ Impossible de récupérer les matchs en direct.\n\n' +
      err.message
    );
  }
});

// =============================================
// MESSAGES UTILISATEURS
// =============================================

bot.on('text', ctx => {
  const message = ctx.message.text.trim();

  if (message.startsWith('/')) {
    return;
  }

  if (ctx.session.mode === 'foot') {
    return analyzeMatch(ctx, message);
  }

  if (ctx.session.mode === 'forme') {
    ctx.session.mode = null;

    return ctx.reply(
      `⏳ Recherche de ${message}…`
    ).then(() => analyzeTeam(message))
      .then(result => {
        return ctx.reply(
          summaryText(result.team, result.stats)
        );
      })
      .catch(err => {
        console.error('Erreur analyse :', err.message);

        return ctx.reply(
          '⚠️ Analyse impossible.\n\n' +
          err.message
        );
      });
  }

  return ctx.reply(
    '📩 Utilise une commande :\n\n' +
    '/foot - Comparaison de match\n' +
    '/forme - Forme récente\n' +
    '/live - Matchs en direct\n' +
    '/help - Assistance'
  );
});

// =============================================
// GESTION DES ERREURS
// =============================================

bot.catch(err => {
  console.error('Erreur Telegram :', err);
});

// =============================================
// SERVEUR RENDER
// =============================================

app.listen(process.env.PORT || 3000, () => {
  console.log('Sport Analyzer AI V2 démarré.');
});

// =============================================
// LANCEMENT DU BOT
// =============================================

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
