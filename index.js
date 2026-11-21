
const express = require('express');
const { Telegraf, session } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = 'https://api.football-data.org/v4';

if (!BOT_TOKEN || !FOOTBALL_DATA_TOKEN) {
  throw new Error('BOT_TOKEN ou FOOTBALL_DATA_TOKEN manquant dans Render.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
bot.use(session({ defaultSession: () => ({}) }));

app.get('/', (req, res) => {
  res.send('Sport Analyzer AI V2 fonctionne ⚽');
});

// Connexion à l'API football-data.org
async function apiGet(path) {
  const response = await fetch(API_BASE + path, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  if (!response.ok) {
    throw new Error(`Erreur API : ${response.status}`);
  }

  return response.json();
}

// Recherche d'équipe avec mise en cache
let teamsCache = null;
let teamsCacheTime = 0;

async function getTeamByName(name) {
  if (!teamsCache || Date.now() - teamsCacheTime > 600000) {
    teamsCache = await apiGet('/teams?limit=100');
    teamsCacheTime = Date.now();
  }

  const teams = teamsCache.teams || [];
  const wanted = name.trim().toLowerCase();

  let team = teams.find(
    t => (t.name || '').toLowerCase() === wanted
  );

  if (!team) {
    team = teams.find(
      t =>
        (t.shortName || '').toLowerCase() === wanted ||
        (t.tla || '').toLowerCase() === wanted
    );
  }

  if (!team) {
    throw new Error(`Équipe introuvable : ${name}. Essaie son nom officiel.`);
  }

  return team;
}

// Récupération des derniers matchs
async function getLastMatches(teamId, limit = 5) {
  const data = await apiGet(
    `/teams/${teamId}/matches?status=FINISHED&limit=${limit}`
  );

  return (data.matches || []).slice(-limit).reverse();
}

// Calcul des résultats
function matchResultForTeam(match, teamId) {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;

  const home = match.score?.fullTime?.home;
  const away = match.score?.fullTime?.away;

  if (home == null || away == null) return null;

  const isHome = homeId === teamId;

  const goalsFor = isHome ? home : away;
  const goalsAgainst = isHome ? away : home;

  const result =
    goalsFor > goalsAgainst ? 'V' :
    goalsFor === goalsAgainst ? 'N' : 'D';

  return {
    result,
    goalsFor,
    goalsAgainst,
    opponent: isHome ? match.awayTeam.name : match.homeTeam.name
  };
}

// Statistiques sur les 5 matchs
function summarizeMatches(team, matches) {
  const rows = matches
    .map(m => matchResultForTeam(m, team.id))
    .filter(Boolean);

  const wins = rows.filter(r => r.result === 'V').length;
  const draws = rows.filter(r => r.result === 'N').length;
  const losses = rows.filter(r => r.result === 'D').length;

  const goalsFor = rows.reduce((s, r) => s + r.goalsFor, 0);
  const goalsAgainst = rows.reduce((s, r) => s + r.goalsAgainst, 0);

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

// Présentation des statistiques
function summaryText(team, stats) {
  const form = stats.rows.map(r => r.result).join(' - ') || 'N/D';

  return (
    `📊 ${team.name}\n\n` +
    `Matchs analysés : ${stats.count}\n` +
    `🟢 Victoires : ${stats.wins}\n` +
    `🟡 Nuls : ${stats.draws}\n` +
    `🔴 Défaites : ${stats.losses}\n` +
    `⚽ Buts marqués : ${stats.goalsFor}\n` +
    `🥅 Buts encaissés : ${stats.goalsAgainst}\n` +
    `📈 Points : ${stats.points}/${stats.count * 3}\n\n` +
    `Forme récente : ${form}`
  );
}

async function analyzeTeam(name) {
  const team = await getTeamByName(name);
  const matches = await getLastMatches(team.id, 5);

  return {
    team,
    stats: summarizeMatches(team, matches)
  };
}

// Comparaison de deux équipes
async function analyzeMatch(ctx, matchText) {
  const parts = matchText.split(/\s+vs\.?\s+|\s+-\s+/i);

  if (
    parts.length !== 2 ||
    !parts[0].trim() ||
    !parts[1].trim()
  ) {
    return ctx.reply(
      '❌ Format incorrect.\n\nExemple :\nReal Madrid vs Barcelona'
    );
  }

  await ctx.reply('⏳ Récupération des statistiques…');

  try {
    const [a, b] = await Promise.all([
      analyzeTeam(parts[0].trim()),
      analyzeTeam(parts[1].trim())
    ]);

    ctx.session.mode = null;

    return ctx.reply(
      `⚽ COMPARAISON\n\n` +
      `${summaryText(a.team, a.stats)}\n\n` +
      `────────────\n\n` +
      `${summaryText(b.team, b.stats)}\n\n` +
      `ℹ️ Analyse basée sur les données disponibles de football-data.org.`
    );

  } catch (err) {
    console.error('Erreur analyse :', err.message);
    ctx.session.mode = null;

    return ctx.reply(
      '⚠️ Impossible de récupérer les statistiques.\n\n' +
      err.message
    );
  }
}

// Accueil
bot.start((ctx) => {
  ctx.reply(
    '⚽ Bienvenue sur Sport Analyzer AI V2 !\n\n' +
    'Je suis ton assistant d’analyse football.\n\n' +
    '📊 Commandes disponibles :\n\n' +
    '/foot - Comparaison de match\n' +
    '/forme - Forme récente\n' +
    '/live - Matchs en direct\n' +
    '/help - Assistance\n\n' +
    'Exemple :\n' +
    '/foot Real Madrid vs Barcelona'
  );
});

// Aide
bot.help((ctx) => {
  ctx.reply(
    '⚽ SPORT ANALYZER AI V2\n\n' +
    '/foot Real Madrid vs Barcelona\n' +
    'Comparer deux équipes.\n\n' +
    '/forme Real Madrid\n' +
    'Analyser la forme récente.\n\n' +
    '/live\n' +
    'Voir les matchs en direct disponibles.'
  );
});

// Commande FOOT
bot.command('foot', (ctx) => {
  const match = ctx.message.text.replace(/^\/foot\s*/i, '').trim();

  if (match) {
    return analyzeMatch(ctx, match);
  }

  ctx.session.mode = 'foot';

  return ctx.reply(
    '⚽ ANALYSE DE MATCH\n\n' +
    'Envoie les deux équipes ainsi :\n\n' +
    'Real Madrid vs Barcelona'
  );
});

// Commande FORME
bot.command('forme', async (ctx) => {
  const name = ctx.message.text.replace(/^\/forme\s*/i, '').trim();

  if (!name) {
    ctx.session.mode = 'forme';

    return ctx.reply(
      '📊 ANALYSE DE FORME\n\n' +
      'Envoie le nom de ton équipe.\n\n' +
      'Exemple : Real Madrid'
    );
  }

  ctx.session.mode = null;
  await ctx.reply('⏳ Analyse des derniers matchs…');

  try {
    const result = await analyzeTeam(name);
    return ctx.reply(summaryText(result.team, result.stats));

  } catch (err) {
    console.error('Erreur forme :', err.message);
    return ctx.reply('⚠️ Données indisponibles.\n' + err.message);
  }
});

// Commande LIVE
bot.command('live', async (ctx) => {
  await ctx.reply('🔴 Recherche des matchs en direct…');

  try {
    const data = await apiGet('/matches?status=LIVE');
    const matches = data.matches || [];

    if (!matches.length) {
      return ctx.reply(
        'Aucun match en direct n’est retourné par l’API actuellement.'
      );
    }

    const lines = matches.slice(0, 15).map(m => {
      const home = m.score?.fullTime?.home;
      const away = m.score?.fullTime?.away;

      const score =
        home == null || away == null
          ? '—'
          : `${home} - ${away}`;

      return (
        `🔴 ${m.homeTeam.name} ${score} ${m.awayTeam.name}\n` +
        `⏱ ${m.status || 'En cours'}`
      );
    });

    return ctx.reply(
      '🔴 MATCHS EN DIRECT\n\n' + lines.join('\n\n')
    );

  } catch (err) {
    console.error('Erreur Live :', err.message);

    return ctx.reply(
      '⚠️ Les données live ne sont pas disponibles pour le moment.'
    );
  }
});

// Messages reçus
bot.on('text', (ctx) => {
  const message = ctx.message.text.trim();

  if (message.startsWith('/')) return;

  if (ctx.session.mode === 'foot') {
    return analyzeMatch(ctx, message);
  }

  if (ctx.session.mode === 'forme') {
    ctx.session.mode = null;

    return ctx.reply(
      '⏳ Recherche de ' + message + '…'
    ).then(() => analyzeTeam(message)).then(result => {
      return ctx.reply(summaryText(result.team, result.stats));
    }).catch(err => {
      console.error(err.message);
      return ctx.reply('⚠️ Données indisponibles.\n' + err.message);
    });
  }

  return ctx.reply(
    '📩 Utilise une commande :\n\n' +
    '/foot - Comparaison\n' +
    '/forme - Forme récente\n' +
    '/live - Matchs en direct\n' +
    '/help - Assistance'
  );
});

// Gestion des erreurs
bot.catch((err) => {
  console.error('Erreur Telegram :', err);
});

// Démarrage du serveur
app.listen(process.env.PORT || 3000, () => {
  console.log('Sport Analyzer AI V2 démarré.');
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
