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
  res.status(200).send('⚽ Sport Analyzer AI V2 fonctionne.');
});

// =============================
// API FOOTBALL
// =============================

async function apiGet(path) {
  const response = await fetch(API_BASE + path, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Limite de requêtes API atteinte. Réessaie dans quelques instants.');
    }

    if (response.status === 403) {
      throw new Error('Accès refusé par l’API. Vérifie les compétitions autorisées.');
    }

    if (response.status === 404) {
      throw new Error('Données introuvables.');
    }

    throw new Error(`Erreur API football (${response.status}).`);
  }

  return response.json();
}

// =============================
// CACHE DES ÉQUIPES
// =============================

let teamsCache = [];
let teamsCacheTime = 0;

async function getTeams() {
  const cacheDuration = 10 * 60 * 1000;

  if (!teamsCache.length || Date.now() - teamsCacheTime > cacheDuration) {
    const data = await apiGet('/teams?limit=500');

    teamsCache = data.teams || [];
    teamsCacheTime = Date.now();
  }

  return teamsCache;
}

// =============================
// NORMALISATION DES NOMS
// =============================

function normalizeName(name) {
  return name
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

// =============================
// RECHERCHE D'ÉQUIPE
// =============================

async function getTeamByName(name) {
  const teams = await getTeams();
  const wanted = normalizeName(name);

  const possibleNames = [
    wanted,
    ...(aliases[name.toLowerCase()] || []).map(normalizeName)
  ];

  // Recherche exacte
  let team = teams.find(t =>
    possibleNames.includes(normalizeName(t.name || '')) ||
    possibleNames.includes(normalizeName(t.shortName || '')) ||
    possibleNames.includes(normalizeName(t.tla || ''))
  );

  // Recherche approchée
  if (!team) {
    team = teams.find(t =>
      possibleNames.some(n =>
        normalizeName(t.name || '').includes(n) ||
        normalizeName(t.shortName || '').includes(n)
      )
    );
  }

  if (!team) {
    throw new Error(
      `Équipe "${name}" introuvable dans les équipes accessibles à l'API.`
    );
  }

  return team;
}

// =============================
// DERNIERS MATCHS
// =============================

async function getLastMatches(teamId, limit = 5) {
  const data = await apiGet(
    `/teams/${teamId}/matches?status=FINISHED&limit=20`
  );

  return (data.matches || [])
    .filter(m => m.status === 'FINISHED')
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, limit);
}

// =============================
// RÉSULTAT POUR UNE ÉQUIPE
// =============================

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
    date: match.utcDate
  };
}

// =============================
// STATISTIQUES
// =============================

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

  return {
    rows,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    points: wins * 3 + draws,
    count: rows.length
  };
}

// =============================
// AFFICHAGE DES STATISTIQUES
// =============================

function summaryText(team, stats) {
  const form = stats.rows.length
    ? stats.rows.map(r => r.result).join(' - ')
    : 'Données indisponibles';

  return (
    `📊 ${team.name}\n\n` +
    `📋 Matchs analysés : ${stats.count}\n` +
    `🟢 Victoires : ${stats.wins}\n` +
    `🟡 Nuls : ${stats.draws}\n` +
    `🔴 Défaites : ${stats.losses}\n` +
    `⚽ Buts marqués : ${stats.goalsFor}\n` +
    `🥅 Buts encaissés : ${stats.goalsAgainst}\n` +
    `🏆 Points obtenus : ${stats.points}\n\n` +
    `📈 Forme récente : ${form}`
  );
}

// =============================
// ANALYSE D'ÉQUIPE
// =============================

async function analyzeTeam(name) {
  const team = await getTeamByName(name);
  const matches = await getLastMatches(team.id, 5);
  const stats = summarizeMatches(team, matches);

  if (stats.count === 0) {
    throw new Error(
      `Aucun résultat récent disponible pour ${team.name}.`
    );
  }

  return { team, stats };
}

// =============================
// COMPARAISON
// =============================

async function analyzeMatch(ctx, matchText) {
  const parts = matchText.split(/\s+vs\.?\s+|\s+-\s+/i);

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

  await ctx.reply('⏳ Recherche des statistiques des deux équipes…');

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
      `ℹ️ Analyse basée sur les matchs disponibles dans la base.`
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

// =============================
// ACCUEIL
// =============================

bot.start(ctx => {
  ctx.session.mode = null;

  return ctx.reply(
    '⚽ BIENVENUE SUR SPORT ANALYZER AI V2\n\n' +
    'Je suis ton assistant d’analyse football.\n\n' +
    '📊 COMMANDES :\n\n' +
    '/foot - Comparaison de deux équipes\n' +
    '/forme - Forme récente d’une équipe\n' +
    '/live - Matchs en direct disponibles\n' +
    '/help - Assistance\n\n' +
    'Exemple :\n' +
    '/foot Real Madrid vs Barcelona'
  );
});

// =============================
// AIDE
// =============================

bot.help(ctx => {
  return ctx.reply(
    '⚽ SPORT ANALYZER AI V2\n\n' +
    '📊 /foot Real Madrid vs Barcelona\n' +
    'Comparer deux équipes.\n\n' +
    '📈 /forme Real Madrid\n' +
    'Analyser les derniers résultats.\n\n' +
    '🔴 /live\n' +
    'Consulter les matchs en direct disponibles.\n\n' +
    'Tu peux aussi utiliser une commande sans argument ' +
    'et envoyer ensuite le nom de l’équipe ou du match.'
  );
});

// =============================
// COMMANDE FOOT
// =============================

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

// =============================
// COMMANDE FORME
// =============================

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

  await ctx.reply('⏳ Analyse de la forme récente…');

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

// =============================
// COMMANDE LIVE
// =============================

bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des matchs en direct…');

  try {
    const data = await apiGet('/matches?status=LIVE');
    const matches = data.matches || [];

    if (!matches.length) {
      return ctx.reply(
        '🔴 Aucun match en direct disponible dans les données API actuellement.'
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

// =============================
// MESSAGES UTILISATEURS
// =============================

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
        return ctx.reply(summaryText(result.team, result.stats));
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

// =============================
// GESTION DES ERREURS
// =============================

bot.catch(err => {
  console.error('Erreur Telegram :', err);
});

// =============================
// SERVEUR RENDER
// =============================

app.listen(process.env.PORT || 3000, () => {
  console.log('Sport Analyzer AI V2 démarré.');
});

// =============================
// LANCEMENT DU BOT
// =============================

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
