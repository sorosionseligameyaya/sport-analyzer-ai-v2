
'use strict';

const express = require('express');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const API_BASE = 'https://api.football-data.org/v4';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN manquant dans Render.');

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.get('/', (_req, res) => res.status(200).send('SPORT ANALYZER AI fonctionne.'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur ${PORT}`));

const COMPETITIONS = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL', 'ELC', 'PPL', 'DED'];
const cache = new Map();

async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN absent sur Render.');
  }

  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
  });

  if (!r.ok) throw new Error(`Football-data HTTP ${r.status}`);
  return r.json();
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
    } catch (e) {
      console.warn(`Équipes ${code}: ${e.message}`);
    }
  }

  const unique = [...new Map(all.map(t => [t.id, t])).values()];

  if (unique.length) {
    cache.set('teams', { time: Date.now(), data: unique });
  }

  return unique;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTeam(name, teams) {
  const n = normalize(name);

  if (!n) return null;

  return teams.find(t =>
    normalize(t.name) === n ||
    normalize(t.shortName) === n ||
    normalize(t.tla) === n
  ) || teams.find(t =>
    normalize(t.name).includes(n) ||
    normalize(t.shortName || '').includes(n)
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

  for (const m of matches) {
    const home = m.homeTeam.id === teamId;

    const gf = home
      ? m.score.fullTime.home
      : m.score.fullTime.away;

    const ga = home
      ? m.score.fullTime.away
      : m.score.fullTime.home;

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

function statsText(name, s) {
  return `📊 ${name} — 5 derniers matchs

Matchs analysés : ${s.played}
Victoires : ${s.wins}
Nuls : ${s.draws}
Défaites : ${s.losses}
Buts marqués : ${s.goalsFor}
Buts encaissés : ${s.goalsAgainst}
Moyenne buts marqués/match : ${s.avgFor}
Moyenne buts encaissés/match : ${s.avgAgainst}
Matchs avec +1,5 but : ${s.over15}
Matchs avec +2,5 buts : ${s.over25}
Matchs où les deux équipes marquent : ${s.btts}
Clean sheets : ${s.cleanSheets}`;
}

async function askAI(prompt) {
  if (!OPENROUTER_API_KEY) return null;

  try {
    const r = await fetch(
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
              content: `Tu es SPORT ANALYZER AI, analyste football.
Analyse uniquement les données fournies.
N'invente jamais de statistiques, résultats, probabilités ou cotes.
Mentionne les limites des données.
Réponds en français, de façon claire et professionnelle.
Tes analyses ne garantissent aucun résultat.`
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

    if (!r.ok) {
      console.error('OpenRouter:', r.status, await r.text());
      return null;
    }

    const data = await r.json();

    return data.choices?.[0]?.message?.content?.trim() || null;

  } catch (e) {
    console.error('Erreur IA:', e.message);
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
  const s = calcStats(matches, team.id);

  if (!s.played) {
    return `Pas de résultats récents disponibles pour ${team.name}.`;
  }

  const base = statsText(team.name, s);

  const ai = await askAI(
    `Analyse la forme récente de ${team.name} à partir des statistiques suivantes. Décris forme, attaque, défense, tendances de buts et risques, sans créer de chiffres.

${base}`
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

  const [ma, mb] = await Promise.all([
    getLastMatches(a.id),
    getLastMatches(b.id)
  ]);

  const sa = calcStats(ma, a.id);
  const sb = calcStats(mb, b.id);

  if (!sa.played || !sb.played) {
    return 'Données récentes insuffisantes pour comparer ces équipes.';
  }

  const base = `${statsText(a.name, sa)}

${statsText(b.name, sb)}`;

  const ai = await askAI(
    `Compare les équipes en restant prudent et sans inventer. Évalue forme, attaque, défense, tendances de buts et facteurs de risque. Ne donne pas de certitude.

${base}`
  );

  return ai
    ? `${base}\n\n🧠 COMPARAISON IA\n${ai}`
    : `${base}\n\nIA indisponible pour le moment.`;
}

async function apiFootball(path) {
  if (!API_FOOTBALL_KEY) {
    throw new Error('API_FOOTBALL_KEY absente sur Render.');
  }

  const r = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });

  if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);

  const data = await r.json();

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
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return abidjanDate(d);
}

/* =========================
   MATCHS EN DIRECT
========================= */

async function liveMatches() {
  const data = await apiFootball('/fixtures?live=all');

  return data.filter(m =>
    ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(
      m.fixture?.status?.short
    )
  );
}

function liveText(matches) {
  if (!matches || !matches.length) {
    return '🔴 Aucun match en direct actuellement.';
  }

  return matches.slice(0, 30).map(m => {
    const home = m.teams?.home?.name || 'Équipe domicile';
    const away = m.teams?.away?.name || 'Équipe extérieure';

    const homeGoals = m.goals?.home ?? 0;
    const awayGoals = m.goals?.away ?? 0;

    const elapsed = m.fixture?.status?.elapsed;
    const status = m.fixture?.status?.short;

    const minute = elapsed != null
      ? `${elapsed}'`
      : status === 'HT'
        ? 'Mi-temps'
        : status;

    return `🔴 ${minute}
${home} ${homeGoals} - ${awayGoals} ${away}`;
  }).join('\n\n');
}

/* =========================
   MATCHS ET COTES
========================= */

function oddsFormat(n) {
  return Number(n).toFixed(2);
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

          if (!Number.isFinite(odd) || odd < 1.2 || odd > 1.8) continue;

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
    } catch (e) {
      console.warn(`Fixtures ${date}:`, e.message);
      continue;
    }

    for (const f of fixtures) {
      if (picks.length >= 6) break;
      if (f.fixture?.status?.short !== 'NS') continue;
      if (seen.has(f.fixture.id)) continue;

      seen.add(f.fixture.id);

      try {
        const odds = await getOddsForFixture(f.fixture.id);
        const pick = odds[0];

        if (pick) {
          picks.push({
            home: f.teams.home.name,
            away: f.teams.away.name,
            date: f.fixture.date,
            ...pick
          });
        }

      } catch (e) {
        console.warn(`Cotes fixture ${f.fixture.id}:`, e.message);
      }
    }
  }

  if (!picks.length) {
    return 'Je n’ai trouvé aucune cote réelle correspondant aux filtres (1,20–1,80) dans les données accessibles. Aucune cote n’a été inventée.';
  }

  return `🎯 SÉLECTION DE MARCHÉS — COTES RÉELLES TROUVÉES

${picks.map((p, i) =>
    `${i + 1}. ${p.home} – ${p.away}
Marché : ${p.market} / ${p.value}
Cote : ${oddsFormat(p.odd)}
Bookmaker : ${p.bookmaker}
`).join('\n')}

⚠️ Les cotes peuvent changer. Cette sélection n'est pas une garantie.`;
}

/* =========================
   AIDE
========================= */

function helpText() {
  return `🤖 SPORT ANALYZER AI

/forme Équipe — analyse détaillée d'une équipe
/foot Équipe 1 vs Équipe 2 — comparaison
/live — matchs en direct
/coupon — recherche de marchés et cotes réelles
/cotes — mêmes données de cotes disponibles
/fifa — football virtuel
/help — aide

Exemples :
/forme Real Madrid
/foot Arsenal vs Chelsea

Les statistiques dépendent des données disponibles.`;
}

function parseTwoTeams(text) {
  const cleaned = text.replace(/^\/(foot|compare)\s*/i, '').trim();
  const parts = cleaned.split(/\s+(?:vs\.?|contre)\s+/i);

  return parts.length >= 2
    ? [parts[0].trim(), parts.slice(1).join(' ').trim()]
    : null;
}

/* =========================
   COMMANDES TELEGRAM
========================= */

bot.start(ctx =>
  ctx.reply('👋 Bienvenue sur SPORT ANALYZER AI.\n\nUtilise /help pour voir les commandes.')
);

bot.help(ctx => ctx.reply(helpText()));
bot.command('help', ctx => ctx.reply(helpText()));

bot.command('forme', async ctx => {
  const name = ctx.message.text
    .replace(/^\/forme(?:@\w+)?\s*/i, '')
    .trim();

  if (!name) return ctx.reply('Utilise : /forme Real Madrid');

  await ctx.reply('🔎 Analyse des statistiques et préparation de l’analyse IA…');

  try {
    await ctx.reply(await teamReport(name));
  } catch (e) {
    console.error(e);
    await ctx.reply(`Erreur pendant l'analyse : ${e.message}`);
  }
});

bot.command('foot', async ctx => {
  const names = parseTwoTeams(
    ctx.message.text.replace(/^\/foot(?:@\w+)?/i, '/foot')
  );

  if (!names) return ctx.reply('Utilise : /foot Arsenal vs Chelsea');

  await ctx.reply('⚔️ Comparaison des équipes en cours…');

  try {
    await ctx.reply(await compareTeams(names));
  } catch (e) {
    console.error(e);
    await ctx.reply(`Erreur de comparaison : ${e.message}`);
  }
});

bot.command('live', async ctx => {
  await ctx.reply('🔴 Recherche des scores en direct…');

  try {
    await ctx.reply(liveText(await liveMatches()));
  } catch (e) {
    console.error(e);
    await ctx.reply(`Live indisponible : ${e.message}`);
  }
});

bot.command('coupon', async ctx => {
  await ctx.reply('🔎 Recherche des matchs et des cotes réelles. Cela peut prendre un moment…');

  try {
    await ctx.reply(await couponSearch());
  } catch (e) {
    console.error(e);
    await ctx.reply(`Recherche indisponible : ${e.message}`);
  }
});

bot.command('cotes', async ctx => {
  await ctx.reply('📊 Vérification des cotes disponibles…');

  try {
    await ctx.reply(await couponSearch());
  } catch (e) {
    console.error(e);
    await ctx.reply(`Cotes indisponibles : ${e.message}`);
  }
});

bot.command('fifa', ctx =>
  ctx.reply('🎮 MODULE FOOTBALL VIRTUEL\n\nLe module FIFA/eFootball est encore en préparation. Les données de matchs virtuels ne sont pas connectées, donc je ne fournirai pas de faux scores ou de fausses cotes.')
);

bot.on('text', ctx =>
  ctx.reply('Commande non reconnue. Utilise /help pour voir les commandes.')
);

bot.catch((err, ctx) => {
  console.error('Erreur bot:', err);

  if (ctx) {
    ctx.reply('Une erreur est survenue. Réessaie plus tard.').catch(() => {});
  }
});

bot.launch()
  .then(() => console.log('SPORT ANALYZER AI bot lancé'))
  .catch(e => console.error('Échec lancement bot:', e));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
      
