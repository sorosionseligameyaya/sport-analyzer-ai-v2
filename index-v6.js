
'use strict';

const express = require('express');
const { Telegraf } = require('telegraf');
const fifaEngine = require('./fifa-engine');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const PULSESCORE_API_KEY = process.env.PULSESCORE_API_KEY;
const PULSESCORE_BASE = 'https://api.pulsescore.net/api/onexbet';

const API_BASE = 'https://api.football-data.org/v4';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN manquant dans Render.');

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.get('/', (_req, res) =>
  res.status(200).send('SPORT ANALYZER AI fonctionne.')
);

app.get('/health', (_req, res) =>
  res.status(200).json({
    ok: true,
    fifaEngine: true,
    pulseScoreConfigured: Boolean(PULSESCORE_API_KEY)
  })
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`Serveur démarré sur ${PORT}`)
);

/* =====================================================
   PULSESCORE — CONNEXION API 1XBET
===================================================== */

async function pulseRequest(path) {
  if (!PULSESCORE_API_KEY) {
    throw new Error('PULSESCORE_API_KEY absente sur Render.');
  }

  const response = await fetch(`${PULSESCORE_BASE}${path}`, {
    method: 'GET',
    headers: {
      'x-secret': PULSESCORE_API_KEY,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    signal: AbortSignal.timeout(20000)
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `PulseScore HTTP ${response.status}: ${body.slice(0, 180)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Réponse PulseScore non valide en JSON.');
  }
}

function extractEvents(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;

  return [];
}

function getEventName(event) {
  return [
    event?.home,
    event?.away,
    event?.league,
    event?.competition,
    event?.name,
    event?.sport
  ].filter(Boolean).join(' ');
}

function isPotentialVirtual(event) {
  const text = getEventName(event).toLowerCase();

  return /fc\s?25|fc\s?26|fc\s?24|efootball|e-football|fifa|rush|3x3|4x4|penalt|esport|cyber|virtual/.test(text);
}

function formatEvent(event) {
  const home = event.home || event.homeTeam || 'Équipe inconnue';
  const away = event.away || event.awayTeam || 'Équipe inconnue';
  const league = event.league || event.competition || 'Compétition inconnue';

  const score = event.score
    ? `${event.score.home ?? '?'}-${event.score.away ?? '?'}`
    : 'Score non disponible';

  return `${home} - ${away}\nCompétition : ${league}\nScore : ${score}`;
}

async function pulseDiagnostic() {
  const tests = [
    {
      name: 'Football avant-match',
      path: '/soccer/events?page=1&limit=30'
    },
    {
      name: 'Football en direct',
      path: '/live-events?sport=soccer&page=1&limit=30'
    },
    {
      name: 'Résultats terminés',
      path: '/results?sport=soccer&page=1&limit=30'
    },
    {
      name: 'E-sport avant-match',
      path: '/esports/events?page=1&limit=30'
    },
    {
      name: 'Sports avec résultats',
      path: '/results/sports'
    }
  ];

  const reports = [];
  const collections = {};

  for (const test of tests) {
    try {
      const data = await pulseRequest(test.path);
      const events = extractEvents(data);

      collections[test.name] = events;

      reports.push(
        `✅ ${test.name} : ${events.length} élément(s) reçu(s).`
      );

    } catch (error) {
      collections[test.name] = [];

      reports.push(
        `❌ ${test.name} : ${error.message}`
      );
    }
  }

  const prematch = collections['Football avant-match'] || [];
  const live = collections['Football en direct'] || [];
  const results = collections['Résultats terminés'] || [];
  const esports = collections['E-sport avant-match'] || [];

  const allEvents = [
    ...prematch,
    ...live,
    ...results,
    ...esports
  ];

  const virtualEvents = allEvents.filter(isPotentialVirtual);

  const uniqueVirtual = [
    ...new Map(
      virtualEvents.map(event => [
        String(event.eventId || event.id || getEventName(event)),
        event
      ])
    ).values()
  ];

  let output =
    '🎮 DIAGNOSTIC PULSESCORE — 1XBET\n\n' +
    reports.join('\n');

  output +=
    '\n\n📊 DÉTECTION DES MATCHS VIRTUELS\n' +
    `Événements examinés : ${allEvents.length}\n` +
    `Événements correspondant aux mots-clés virtuels : ${uniqueVirtual.length}\n`;

  if (uniqueVirtual.length) {
    output += '\n🎮 ÉVÉNEMENTS À VÉRIFIER :\n\n';

    output += uniqueVirtual
      .slice(0, 8)
      .map((event, index) =>
        `${index + 1}. ${formatEvent(event)}`
      )
      .join('\n\n');

  } else {
    output +=
      '\n⚠️ Aucun événement virtuel identifiable dans les résultats reçus.\n' +
      'Cela ne prouve pas que PulseScore ne les possède pas : ' +
      'ils peuvent être absents actuellement ou utiliser d’autres noms.';
  }

  output +=
    '\n\n⚠️ Ce diagnostic vérifie la connexion et les données reçues. ' +
    'Il ne constitue pas encore une analyse prédictive.';

  return output;
}

/* =====================================================
   FOOTBALL DATA
===================================================== */

const COMPETITIONS = [
  'PL', 'PD', 'BL1', 'SA', 'FL1',
  'CL', 'ELC', 'PPL', 'DED'
];

const cache = new Map();

async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN absent sur Render.');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    }
  });

  if (!response.ok) {
    throw new Error(`Football-data HTTP ${response.status}`);
  }

  return response.json();
}

async function getTeams() {
  const cached = cache.get('teams');

  if (cached && Date.now() - cached.time < 6 * 60 * 60 * 1000) {
    return cached.data;
  }

  const all = [];

  for (const code of COMPETITIONS) {
    try {
      const data = await footballData(`/competitions/${code}/teams`);
      all.push(...(data.teams || []));
    } catch (error) {
      console.warn(`Équipes ${code}: ${error.message}`);
    }
  }

  const unique = [...new Map(all.map(team => [team.id, team])).values()];

  if (unique.length) {
    cache.set('teams', {
      time: Date.now(),
      data: unique
    });
  }

  return unique;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTeam(name, teams) {
  const normalized = normalize(name);

  if (!normalized) return null;

  return teams.find(team =>
    normalize(team.name) === normalized ||
    normalize(team.shortName) === normalized ||
    normalize(team.tla) === normalized
  ) || teams.find(team =>
    normalize(team.name).includes(normalized) ||
    normalize(team.shortName || '').includes(normalized)
  );
}

async function getLastMatches(teamId) {
  const data = await footballData(
    `/teams/${teamId}/matches?status=FINISHED&limit=5`
  );

  return data.matches || [];
}

function calcStats(matches, teamId) {
  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let cleanSheets = 0;
  let over15 = 0;
  let over25 = 0;
  let btts = 0;

  for (const match of matches) {
    const home = match.homeTeam.id === teamId;

    const gf = home
      ? match.score.fullTime.home
      : match.score.fullTime.away;

    const ga = home
      ? match.score.fullTime.away
      : match.score.fullTime.home;

    if (gf == null || ga == null) continue;

    played++;
    goalsFor += gf;
    goalsAgainst += ga;

    if (ga === 0) cleanSheets++;
    if (gf + ga >= 2) over15++;
    if (gf + ga >= 3) over25++;
    if (gf > 0 && ga > 0) btts++;

    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    cleanSheets,
    over15,
    over25,
    btts,
    avgFor: played ? (goalsFor / played).toFixed(2) : '0.00',
    avgAgainst: played ? (goalsAgainst / played).toFixed(2) : '0.00'
  };
}

function statsText(name, stats) {
  return `📊 ${name} — 5 derniers matchs

Matchs analysés : ${stats.played}
Victoires : ${stats.wins}
Nuls : ${stats.draws}
Défaites : ${stats.losses}
Buts marqués : ${stats.goalsFor}
Buts encaissés : ${stats.goalsAgainst}
Moyenne buts marqués/match : ${stats.avgFor}
Moyenne buts encaissés/match : ${stats.avgAgainst}
Matchs avec +1,5 but : ${stats.over15}
Matchs avec +2,5 buts : ${stats.over25}
Matchs où les deux équipes marquent : ${stats.btts}
Clean sheets : ${stats.cleanSheets}`;
}

/* =====================================================
   OPENROUTER
===================================================== */

async function askAI(prompt) {
  if (!OPENROUTER_API_KEY) return null;

  try {
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'Tu es SPORT ANALYZER AI, analyste football. ' +
                'Analyse uniquement les données fournies. ' +
                'N’invente jamais de statistiques, résultats, probabilités ou cotes. ' +
                'Mentionne les limites des données. ' +
                'Réponds en français, clairement et professionnellement. ' +
                'Tes analyses ne garantissent aucun résultat.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 750
        })
      }
    );

    if (!response.ok) {
      console.error(
        'OpenRouter:',
        response.status,
        await response.text()
      );
      return null;
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content?.trim() || null;

  } catch (error) {
    console.error('Erreur IA:', error.message);
    return null;
  }
}

async function teamReport(name) {
  const teams = await getTeams();
  const team = findTeam(name, teams);

  if (!team) {
    return `Équipe introuvable : ${name}. Essaie son nom officiel.`;
  }

  const matches = await getLastMatches(team.id);
  const stats = calcStats(matches, team.id);

  if (!stats.played) {
    return `Pas de résultats récents disponibles pour ${team.name}.`;
  }

  const base = statsText(team.name, stats);

  const ai = await askAI(
    `Analyse la forme récente de ${team.name} à partir des statistiques suivantes. ` +
    `Décris forme, attaque, défense, tendances de buts et risques, sans créer de chiffres.\n\n${base}`
  );

  return ai
    ? `${base}\n\n🧠 ANALYSE IA\n${ai}`
    : `${base}\n\n🧠 Analyse IA indisponible. Vérifie OPENROUTER_API_KEY sur Render.`;
}

async function compareTeams(names) {
  const teams = await getTeams();

  const a = findTeam(names[0], teams);
  const b = findTeam(names[1], teams);

  if (!a || !b) {
    return `Je n'ai pas trouvé les deux équipes. Vérifie les noms.
Équipe 1 : ${names[0]}
Équipe 2 : ${names[1]}`;
  }

  const [matchesA, matchesB] = await Promise.all([
    getLastMatches(a.id),
    getLastMatches(b.id)
  ]);

  const statsA = calcStats(matchesA, a.id);
  const statsB = calcStats(matchesB, b.id);

  if (!statsA.played || !statsB.played) {
    return 'Données récentes insuffisantes pour comparer ces équipes.';
  }

  const base =
    `${statsText(a.name, statsA)}\n\n${statsText(b.name, statsB)}`;

  const ai = await askAI(
    `Compare les équipes en restant prudent et sans inventer. ` +
    `Évalue forme, attaque, défense, tendances de buts et facteurs de risque.\n\n${base}`
  );

  return ai
    ? `${base}\n\n🧠 COMPARAISON IA\n${ai}`
    : `${base}\n\nIA indisponible pour le moment.`;
}

/* =====================================================
   API-FOOTBALL
===================================================== */

async function apiFootball(path) {
  if (!API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY absente sur Render.');
  }

  const response = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY
    }
  });

  if (!response.ok) {
    throw new Error(`API-Football HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

function abidjanDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Abidjan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function dateOffset(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return abidjanDate(date);
}

/* MATCHS EN DIRECT */

async function liveMatches() {
  const data = await apiFootball('/fixtures?live=all');

  return data.filter(match =>
    ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(
      match.fixture?.status?.short
    )
  );
}

function liveText(matches) {
  if (!matches || !matches.length) {
    return '🔴 Aucun match en direct actuellement.';
  }

  return matches.slice(0, 30).map(match => {
    const home = match.teams?.home?.name || 'Équipe domicile';
    const away = match.teams?.away?.name || 'Équipe extérieure';

    const homeGoals = match.goals?.home ?? 0;
    const awayGoals = match.goals?.away ?? 0;

    const elapsed = match.fixture?.status?.elapsed;
    const status = match.fixture?.status?.short;

    const minute = elapsed != null
      ? `${elapsed}'`
      : status === 'HT'
        ? 'Mi-temps'
        : status;

    return `🔴 ${minute}
${home} ${homeGoals} - ${awayGoals} ${away}`;
  }).join('\n\n');
}

/* =====================================================
   MATCHS ET COTES
===================================================== */

function oddsFormat(number) {
  return Number(number).toFixed(2);
}

async function getFixturesForDate(date) {
  return apiFootball(`/fixtures?date=${date}`);
}

async function getOddsForFixture(fixtureId) {
  const data = await apiFootball(`/odds?fixture=${fixtureId}`);
  const found = [];

  for (const item of data) {
    for (const bookmaker of (item.bookmakers || [])) {
      for (const bet of (bookmaker.bets || [])) {
        for (const value of (bet.values || [])) {
          const market = normalize(bet.name);
          const choice = normalize(value.value);
          const odd = Number(value.odd);

          if (!Number.isFinite(odd) || odd < 1.2 || odd > 1.8) {
            continue;
          }

          if (
            (market.includes('goals over under') ||
             market.includes('total goals') ||
             market.includes('over under')) &&
            (choice === 'over 1 5' || choice === 'over 1 5 goals')
          ) {
            found.push({
              market: bet.name,
              value: value.value,
              odd,
              bookmaker: bookmaker.name
            });
          }

          if (
            (market.includes('both teams score') ||
             market.includes('both teams to score')) &&
            (choice === 'yes' || choice === 'both teams score yes')
          ) {
            found.push({
              market: bet.name,
              value: value.value,
              odd,
              bookmaker: bookmaker.name
            });
          }
        }
      }
    }
  }

  return found;
}

async function couponSearch() {
  if (!API_FOOTBALL_KEY) {
    return 'La clé API-Football est absente sur Render.';
  }

  const dates = [dateOffset(0), dateOffset(1)];
  const picks = [];
  const seen = new Set();

  for (const date of dates) {
    let fixtures = [];

    try {
      fixtures = await getFixturesForDate(date);
    } catch (error) {
      console.warn(`Fixtures ${date}:`, error.message);
      continue;
    }

    for (const fixture of fixtures) {
      if (picks.length >= 6) break;
      if (fixture.fixture?.status?.short !== 'NS') continue;
      if (seen.has(fixture.fixture.id)) continue;

      seen.add(fixture.fixture.id);

      try {
        const odds = await getOddsForFixture(fixture.fixture.id);
        const pick = odds[0];

        if (pick) {
          picks.push({
            home: fixture.teams.home.name,
            away: fixture.teams.away.name,
            date: fixture.fixture.date,
            ...pick
          });
        }

      } catch (error) {
        console.warn(
          `Cotes fixture ${fixture.fixture.id}:`,
          error.message
        );
      }
    }
  }

  if (!picks.length) {
    return 'Je n’ai trouvé aucune cote réelle correspondant aux filtres (1,20–1,80) dans les données accessibles. Aucune cote n’a été inventée.';
  }

  return `🎯 SÉLECTION DE MARCHÉS — COTES RÉELLES TROUVÉES

${picks.map((pick, index) =>
    `${index + 1}. ${pick.home} – ${pick.away}
Marché : ${pick.market} / ${pick.value}
Cote : ${oddsFormat(pick.odd)}
Bookmaker : ${pick.bookmaker}
`).join('\n')}

⚠️ Les cotes peuvent changer. Cette sélection n'est pas une garantie.`;
}

/* =====================================================
   AIDE
===================================================== */

function helpText() {
  return `🤖 SPORT ANALYZER AI

/forme Équipe — analyse détaillée d'une équipe
/foot Équipe 1 vs Équipe 2 — comparaison
/live — matchs en direct
/coupon — recherche de marchés et cotes réelles
/cotes — mêmes données de cotes disponibles
/fifa — diagnostic football virtuel 1xBet
/help — aide

Exemples :
/forme Real Madrid
/foot Arsenal vs Chelsea

Les statistiques dépendent des données disponibles.`;
}

function parseTwoTeams(text) {
  const cleaned = text
    .replace(/^\/(foot|compare)\s*/i, '')
    .trim();

  const parts = cleaned.split(/\s+(?:vs\.?|contre)\s+/i);

  return parts.length >= 2
    ? [parts[0].trim(), parts.slice(1).join(' ').trim()]
    : null;
}

/* =====================================================
   COMMANDES TELEGRAM
===================================================== */

bot.start(ctx =>
  ctx.reply(
    '👋 Bienvenue sur SPORT ANALYZER AI.\n\nUtilise /help pour voir les commandes.'
  )
);

bot.help(ctx => ctx.reply(helpText()));
bot.command('help', ctx => ctx.reply(helpText()));

bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(?:@\w+)?\s*/i, '')
    .trim();

  if (!name) {
    return ctx.reply('Utilise : /forme Real Madrid');
  }

  await ctx.reply(
    '🔎 Analyse des statistiques et préparation de l’analyse IA…'
  );

  try {
    await ctx.reply(await teamReport(name));
  } catch (error) {
    console.error(error);
    await ctx.reply(`Erreur pendant l'analyse : ${error.message}`);
  }
});

bot.command('foot', async ctx => {
  const names = parseTwoTeams(
    ctx.message.text.replace(/^\/foot(?:@\w+)?/i, '/foot')
  );

  if (!names) {
    return ctx.reply('Utilise : /foot Arsenal vs Chelsea');
  }

  await ctx.reply('⚔️ Comparaison des équipes en cours…');

  try {
    await ctx.reply(await compareTeams(names));
  } catch (error) {
    console.error(error);
    await ctx.reply(`Erreur de comparaison : ${error.message}`);
  }
});

bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des scores en direct…');

  try {
    await ctx.reply(liveText(await liveMatches()));
  } catch (error) {
    console.error(error);
    await ctx.reply(`Live indisponible : ${error.message}`);
  }
});

bot.command('coupon', async ctx => {
  await ctx.reply(
    '🔎 Recherche des matchs et des cotes réelles. Cela peut prendre un moment…'
  );

  try {
    await ctx.reply(await couponSearch());
  } catch (error) {
    console.error(error);
    await ctx.reply(`Recherche indisponible : ${error.message}`);
  }
});

bot.command('cotes', async ctx => {
  await ctx.reply('📊 Vérification des cotes disponibles…');

  try {
    await ctx.reply(await couponSearch());
  } catch (error) {
    console.error(error);
    await ctx.reply(`Cotes indisponibles : ${error.message}`);
  }
});

bot.command('fifa', async ctx => {
  const statusCheck = fifaEngine.classifyStatus('NS');

  const sample = fifaEngine.normalizeMatch({
    home: 'Équipe A',
    away: 'Équipe B',
    status: 'NS'
  });

  if (!sample || statusCheck !== 'PREMATCH') {
    return ctx.reply(
      '⚠️ Le moteur FIFA n’a pas pu être initialisé.'
    );
  }

  await ctx.reply(
    '🎮 Diagnostic PulseScore en cours…\n' +
    'Vérification des matchs, résultats et événements e-sport.'
  );

  try {
    const report = await pulseDiagnostic();

    await ctx.reply(report, {
      disable_web_page_preview: true
    });

  } catch (error) {
    console.error('Erreur diagnostic FIFA:', error);

    await ctx.reply(
      `⚠️ Diagnostic FIFA impossible : ${error.message}`
    );
  }
});

/* =====================================================
   MESSAGES ET ERREURS
===================================================== */

bot.on('text', ctx =>
  ctx.reply(
    'Commande non reconnue. Utilise /help pour voir les commandes.'
  )
);

bot.catch((error, ctx) => {
  console.error('Erreur bot:', error);

  if (ctx) {
    ctx.reply(
      'Une erreur est survenue. Réessaie plus tard.'
    ).catch(() => {});
  }
});

/* =====================================================
   DÉMARRAGE
===================================================== */

bot.launch()
  .then(() => console.log('SPORT ANALYZER AI bot lancé'))
  .catch(error =>
    console.error('Échec lancement bot:', error)
  );

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
