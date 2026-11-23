'use strict';

const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const PULSESCORE_API_KEY = process.env.PULSESCORE_API_KEY;

const API_BASE = 'https://api.football-data.org/v4';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const PULSESCORE_BASE = 'https://api.pulsescore.net/api/onexbet';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN manquant dans Render.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.status(200).send('SPORT ANALYZER AI fonctionne.');
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    openRouterConfigured: Boolean(OPENROUTER_API_KEY),
    pulseScoreConfigured: Boolean(PULSESCORE_API_KEY),
    apiFootballConfigured: Boolean(API_FOOTBALL_KEY)
  });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

/* OUTILS GÉNÉRAUX */

const cache = new Map();

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTeams(value) {
  const parts = value.split(/\s+(?:vs\.?|contre)\s+/i);
  if (parts.length < 2) return null;

  return [
    parts[0].trim(),
    parts.slice(1).join(' ').trim()
  ];
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

/* FOOTBALL-DATA */

async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN absent dans Render.');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_TOKEN
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Football-data HTTP ${response.status}`);
  }

  return response.json();
}

const COMPETITIONS = [
  'PL', 'PD', 'BL1', 'SA', 'FL1',
  'CL', 'ELC', 'PPL', 'DED'
];

async function getTeams() {
  const cached = cache.get('teams');

  if (cached && Date.now() - cached.time < 21600000) {
    return cached.data;
  }

  const allTeams = [];

  for (const competition of COMPETITIONS) {
    try {
      const data = await footballData(
        `/competitions/${competition}/teams`
      );

      allTeams.push(...(data.teams || []));
    } catch (error) {
      console.warn(
        `Compétition ${competition}: ${error.message}`
      );
    }
  }

  const unique = [
    ...new Map(
      allTeams.map(team => [team.id, team])
    ).values()
  ];

  if (unique.length) {
    cache.set('teams', {
      time: Date.now(),
      data: unique
    });
  }

  return unique;
}

function findTeam(name, teams) {
  const search = normalize(name);

  if (!search) return null;

  return teams.find(team =>
    normalize(team.name) === search ||
    normalize(team.shortName) === search ||
    normalize(team.tla) === search
  ) || teams.find(team =>
    normalize(team.name).includes(search) ||
    normalize(team.shortName || '').includes(search)
  ) || null;
}

async function getLastMatches(teamId) {
  const data = await footballData(
    `/teams/${teamId}/matches?status=FINISHED&limit=5`
  );

  return data.matches || [];
}

/* STATISTIQUES */

function calcStats(matches, teamId) {
  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let over15 = 0;
  let over25 = 0;
  let btts = 0;
  let cleanSheets = 0;

  for (const match of matches) {
    const isHome = match.homeTeam.id === teamId;

    const gf = isHome
      ? match.score.fullTime.home
      : match.score.fullTime.away;

    const ga = isHome
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
    over15,
    over25,
    btts,
    cleanSheets,
    avgFor: played
      ? (goalsFor / played).toFixed(2)
      : '0.00',
    avgAgainst: played
      ? (goalsAgainst / played).toFixed(2)
      : '0.00'
  };
}

function statsText(name, stats) {
  return `📊 ${name} — 5 DERNIERS MATCHS

Matchs analysés : ${stats.played}
Victoires : ${stats.wins}
Nuls : ${stats.draws}
Défaites : ${stats.losses}

Buts marqués : ${stats.goalsFor}
Buts encaissés : ${stats.goalsAgainst}

Moyenne buts marqués : ${stats.avgFor}
Moyenne buts encaissés : ${stats.avgAgainst}

Matchs avec +1,5 but : ${stats.over15}/5
Matchs avec +2,5 buts : ${stats.over25}/5
Les deux équipes marquent : ${stats.btts}/5
Matchs sans encaisser : ${stats.cleanSheets}/5`;
}

/* INTELLIGENCE ARTIFICIELLE */

async function askAI(prompt) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

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
              content: `Tu es SPORT ANALYZER AI, un analyste professionnel du football.

Tu dois :
- Analyser les statistiques réelles fournies.
- Étudier la forme récente des équipes.
- Examiner les buts marqués et encaissés.
- Analyser les tendances de +1,5 et +2,5 buts.
- Examiner la possibilité que les deux équipes marquent.
- Signaler les risques et les données manquantes.
- Ne jamais inventer de statistiques, de résultats ou de cotes.
- Ne jamais présenter une estimation comme une certitude.
- Répondre en français simple et professionnel.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 1000
        }),
        signal: AbortSignal.timeout(30000)
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

/* ANALYSE D'UNE ÉQUIPE */

async function teamReport(name) {
  const teams = await getTeams();
  const team = findTeam(name, teams);

  if (!team) {
    return `❌ Équipe introuvable : ${name}

Vérifie l'orthographe ou utilise le nom officiel.`;
  }

  const matches = await getLastMatches(team.id);
  const stats = calcStats(matches, team.id);

  if (!stats.played) {
    return `Pas de résultats récents disponibles pour ${team.name}.`;
  }

  const base = statsText(team.name, stats);

  const ai = await askAI(
    `Analyse la forme récente de ${team.name}.

Étudie :
1. La forme générale.
2. La puissance offensive.
3. La solidité défensive.
4. La tendance de +1,5 but.
5. La tendance de +2,5 buts.
6. La possibilité que les deux équipes marquent.
7. Les risques.

Voici les statistiques :

${base}

N'invente aucun chiffre.`
  );

  return ai
    ? `${base}

🧠 ANALYSE IA

${ai}`
    : `${base}

⚠️ Analyse IA indisponible.`;
}

/* COMPARAISON DE DEUX ÉQUIPES */

async function compareTeams(names) {
  const teams = await getTeams();

  const teamA = findTeam(names[0], teams);
  const teamB = findTeam(names[1], teams);

  if (!teamA || !teamB) {
    return `❌ Équipes non trouvées.

Équipe 1 : ${names[0]}
Équipe 2 : ${names[1]}`;
  }

  const [matchesA, matchesB] = await Promise.all([
    getLastMatches(teamA.id),
    getLastMatches(teamB.id)
  ]);

  const statsA = calcStats(matchesA, teamA.id);
  const statsB = calcStats(matchesB, teamB.id);

  if (!statsA.played || !statsB.played) {
    return 'Données insuffisantes pour comparer les deux équipes.';
  }

  const base = `${statsText(teamA.name, statsA)}

${statsText(teamB.name, statsB)}`;

  const ai = await askAI(
    `Compare ces deux équipes.

Étudie particulièrement :
- La forme récente.
- L'attaque.
- La défense.
- Les tendances de buts.
- Le marché +1,5 but.
- Le marché +2,5 buts.
- Les deux équipes marquent.
- Les risques et les incertitudes.

Données :

${base}

Ne fabrique aucune statistique.`
  );

  return ai
    ? `${base}

⚔️ COMPARAISON IA

${ai}`
    : `${base}

⚠️ Comparaison IA indisponible.`;
}

/* MATCHS EN DIRECT — ESPN */

async function liveMatches() {
  const url =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard';

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`ESPN HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.events || [])
    .filter(event =>
      event.status?.type?.state === 'in'
    )
    .map(event => {
      const competitors =
        event.competitions?.[0]?.competitors || [];

      const home = competitors.find(
        team => team.homeAway === 'home'
      );

      const away = competitors.find(
        team => team.homeAway === 'away'
      );

      return {
        home: home?.team?.displayName || 'Domicile',
        away: away?.team?.displayName || 'Extérieur',
        homeGoals: Number(home?.score || 0),
        awayGoals: Number(away?.score || 0),
        status:
          event.status?.type?.shortDetail || 'EN DIRECT'
      };
    });
}

function liveText(matches) {
  if (!matches.length) {
    return '🔴 Aucun match en direct actuellement.';
  }

  return `🔴 MATCHS EN DIRECT

${matches.map(match =>
  `${match.status}

${match.home} ${match.homeGoals} - ${match.awayGoals} ${match.away}`
).join('\n\n')}`;
}

/* API FOOTBALL — MATCHS ET COTES */

async function apiFootball(path) {
  if (!API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY absente dans Render.');
  }

  const response = await fetch(
    `${API_FOOTBALL_BASE}${path}`,
    {
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  if (!response.ok) {
    throw new Error(`API-Football HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

async function getFixturesForDate(date) {
  return apiFootball(`/fixtures?date=${date}`);
}

async function getOddsForFixture(fixtureId) {
  const data = await apiFootball(
    `/odds?fixture=${fixtureId}`
  );

  const found = [];

  for (const item of data) {
    for (const bookmaker of item.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        for (const value of bet.values || []) {
          const market = normalize(bet.name);
          const choice = normalize(value.value);
          const odd = Number(value.odd);

          if (!Number.isFinite(odd)) continue;

          if (odd < 1.20 || odd > 1.80) continue;

          const isOver15 =
            market.includes('goals over under') ||
            market.includes('total goals') ||
            market.includes('over under');

          const isBothTeams =
            market.includes('both teams score') ||
            market.includes('both teams to score');

          if (
            isOver15 &&
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
            isBothTeams &&
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

/* RECHERCHE DES MARCHÉS ET DES COTES */

async function couponSearch() {
  if (!API_FOOTBALL_KEY) {
    return `⚠️ API-Football n'est pas configurée.

Je ne peux pas afficher de cotes réelles sans accès à une source de cotes fonctionnelle.

Aucune cote ne sera inventée.`;
  }

  const dates = [
    dateOffset(0),
    dateOffset(1)
  ];

  const picks = [];
  const seen = new Set();

  for (const date of dates) {
    let fixtures = [];

    try {
      fixtures = await getFixturesForDate(date);
    } catch (error) {
      console.error(
        `Erreur matchs ${date}:`,
        error.message
      );

      continue;
    }

    for (const fixture of fixtures) {
      if (picks.length >= 6) break;

      if (fixture.fixture?.status?.short !== 'NS') {
        continue;
      }

      const fixtureId = fixture.fixture.id;

      if (seen.has(fixtureId)) continue;

      seen.add(fixtureId);

      try {
        const odds = await getOddsForFixture(fixtureId);

        if (!odds.length) continue;

        const pick = odds[0];

        picks.push({
          home: fixture.teams.home.name,
          away: fixture.teams.away.name,
          date: fixture.fixture.date,
          market: pick.market,
          value: pick.value,
          odd: pick.odd,
          bookmaker: pick.bookmaker
        });

      } catch (error) {
        console.error(
          `Erreur cotes ${fixtureId}:`,
          error.message
        );
      }
    }
  }

  if (!picks.length) {
    return `⚠️ Aucune cote réelle correspondant aux critères n'a été trouvée.

Filtres :
- Cotes entre 1,20 et 1,80.
- Marchés +1,5 but et les deux équipes marquent.
- Matchs à venir.

Aucune cote n'a été inventée.

Vérifie l'accès API-Football dans Render.`;
  }

  return `🎯 MARCHÉS ET COTES RÉELLES DISPONIBLES

${picks.map((pick, index) =>
  `${index + 1}. ${pick.home} - ${pick.away}

Marché : ${pick.market}
Choix : ${pick.value}
Cote : ${pick.odd.toFixed(2)}
Bookmaker : ${pick.bookmaker}
Date : ${pick.date}`
).join('\n\n')}

⚠️ Les cotes peuvent changer. Vérifie-les avant toute utilisation.`;
}

/* PULSESCORE — DIAGNOSTIC VIRTUEL */

async function pulseRequest(path) {
  if (!PULSESCORE_API_KEY) {
    throw new Error('PULSESCORE_API_KEY absente dans Render.');
  }

  const response = await fetch(
    `${PULSESCORE_BASE}${path}`,
    {
      method: 'GET',
      headers: {
        'x-secret': PULSESCORE_API_KEY,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `PulseScore HTTP ${response.status}: ${body.slice(0, 180)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Réponse PulseScore non valide.');
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
  return /fc\s?25|fc\s?26|fc\s?24|efootball|e-football|fifa|rush|3x3|4x4|penalt|esport|cyber|virtual/i.test(
    getEventName(event)
  );
}

function formatEvent(event) {
  const home =
    event.home ||
    event.homeTeam ||
    'Équipe inconnue';

  const away =
    event.away ||
    event.awayTeam ||
    'Équipe inconnue';

  const league =
    event.league ||
    event.competition ||
    'Compétition inconnue';

  const score = event.score
    ? `${event.score.home ?? '?'}-${event.score.away ?? '?'}`
    : 'Score non disponible';

  return `${home} - ${away}
Compétition : ${league}
Score : ${score}`;
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
      const events = extractEvents(
        await pulseRequest(test.path)
      );

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

  const allEvents = [
    ...(collections['Football avant-match'] || []),
    ...(collections['Football en direct'] || []),
    ...(collections['Résultats terminés'] || []),
    ...(collections['E-sport avant-match'] || [])
  ];

  const virtualEvents = allEvents.filter(
    isPotentialVirtual
  );

  const uniqueVirtual = [
    ...new Map(
      virtualEvents.map(event => [
        String(
          event.eventId ||
          event.id ||
          getEventName(event)
        ),
        event
      ])
    ).values()
  ];

  let output =
    '🎮 DIAGNOSTIC PULSESCORE — 1XBET\n\n' +
    reports.join('\n');

  output += `

📊 DÉTECTION DES MATCHS VIRTUELS

Événements examinés : ${allEvents.length}
Événements correspondant aux mots-clés virtuels : ${uniqueVirtual.length}`;

  if (uniqueVirtual.length) {
    output += '\n\n🎮 ÉVÉNEMENTS À VÉRIFIER :\n\n';

    output += uniqueVirtual
      .slice(0, 8)
      .map((event, index) =>
        `${index + 1}. ${formatEvent(event)}`
      )
      .join('\n\n');

  } else {
    output += `

⚠️ Aucun événement virtuel identifiable dans les résultats reçus.

Cela ne prouve pas que PulseScore ne les possède pas.`;
  }

  output += `

⚠️ Ce diagnostic vérifie la connexion et les données reçues. Il ne constitue pas encore une analyse prédictive.`;

  return output;
}

/* AIDE */

function helpText() {
  return `🤖 SPORT ANALYZER AI

COMMANDES DISPONIBLES

/forme Équipe
Analyse détaillée d'une équipe.

/foot Équipe 1 vs Équipe 2
Comparaison de deux équipes.

/live
Affiche les matchs en direct.

/coupon
Recherche des marchés et cotes réelles.

/cotes
Recherche des cotes disponibles.

/fifa
Diagnostic des données virtuelles 1XBET.

/help
Affiche cette aide.

EXEMPLES

/forme Real Madrid

/foot Arsenal vs Chelsea

Les analyses utilisent les données accessibles. Aucune cote ou statistique n'est inventée.`;
}

/* COMMANDES TELEGRAM */

bot.start(async ctx => {
  await ctx.reply(
    `👋 BIENVENUE SUR SPORT ANALYZER AI !

Ton assistant d'analyse football est prêt.

Utilise /help pour découvrir les commandes.`
  );
});

bot.help(async ctx => {
  await ctx.reply(helpText());
});

bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(?:@\w+)?\s*/i, '')
    .trim();

  if (!name) {
    return ctx.reply(
      
