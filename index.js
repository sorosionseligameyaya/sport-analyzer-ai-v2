
const express = require('express');
const { Telegraf, session } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN manquant dans Render.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
bot.use(session());

app.get('/', (req, res) => {
  res.send('Sport Analyzer AI V2 fonctionne ⚽');
});

bot.start((ctx) => {
  ctx.reply(
    '⚽ Bienvenue sur Sport Analyzer AI V2 !\n\n' +
    'Je suis ton assistant d’analyse football.\n\n' +
    '📊 Commandes disponibles :\n' +
    '/foot - Comparaison de match\n' +
    '/forme - Analyse des résultats récents\n' +
    '/live - Mode live\n' +
    '/help - Assistance'
  );
});

bot.help((ctx) => {
  ctx.reply(
    '⚽ AIDE SPORT ANALYZER AI\n\n' +
    '/foot - Comparer deux équipes\n' +
    '/forme - Étudier la forme récente\n' +
    '/live - Informations sur les matchs en direct\n\n' +
    'Exemple :\n' +
    'Real Madrid vs Barcelona'
  );
});

bot.command('foot', (ctx) => {
  const match = ctx.message.text.replace('/foot', '').trim();

  if (match) {
    return analyserMatch(ctx, match);
  }

  ctx.session.mode = 'foot';

  return ctx.reply(
    '⚽ ANALYSE DE MATCH\n\n' +
    'Envoie les deux équipes sous cette forme :\n\n' +
    'Real Madrid vs Barcelona'
  );
});

function analyserMatch(ctx, match) {
  const equipes = match.split(/\s+vs\.?\s+|\s+-\s+/i);

  if (equipes.length !== 2 || !equipes[0].trim() || !equipes[1].trim()) {
    return ctx.reply(
      '❌ Format incorrect.\n\n' +
      'Écris le match ainsi :\n' +
      'Real Madrid vs Barcelona'
    );
  }

  const equipe1 = equipes[0].trim();
  const equipe2 = equipes[1].trim();

  ctx.session.mode = null;

  return ctx.reply(
    '⚽ ANALYSE DU MATCH\n\n' +
    '🏠 Équipe 1 : ' + equipe1 + '\n' +
    '✈️ Équipe 2 : ' + equipe2 + '\n\n' +
    '📊 ÉTUDE DU MATCH\n\n' +
    '1. Comparaison des équipes : à documenter.\n' +
    '2. Forme récente : statistiques non disponibles.\n' +
    '3. Buts marqués et encaissés : données non disponibles.\n' +
    '4. Confrontations directes : données non disponibles.\n' +
    '5. Analyse tactique : à approfondir.\n\n' +
    '⚠️ IMPORTANT : aucune base de données football externe n’est encore connectée. Je ne vais donc pas inventer de statistiques ni de pronostics.\n\n' +
    '✅ Match correctement identifié.'
  );
}

bot.command('forme', (ctx) => {
  ctx.session.mode = 'forme';

  ctx.reply(
    '📊 ANALYSE DE FORME\n\n' +
    'Envoie les cinq derniers résultats de ton équipe.\n\n' +
    'Exemple : V - V - N - D - V\n\n' +
    'V = Victoire | N = Nul | D = Défaite'
  );
});

bot.command('live', (ctx) => {
  ctx.reply(
    '🔴 MODE LIVE\n\n' +
    'Le module de données en direct n’est pas encore connecté.\n' +
    'Je ne peux pas afficher de scores en temps réel pour le moment.'
  );
});

bot.on('text', (ctx) => {
  const message = ctx.message.text.trim();

  if (message.startsWith('/')) return;

  if (ctx.session.mode === 'foot') {
    return analyserMatch(ctx, message);
  }

  if (ctx.session.mode === 'forme') {
    const resultats = message.toUpperCase().split(/[\s,-]+/).filter(Boolean);

    if (
      resultats.length !== 5 ||
      !resultats.every(r => ['V', 'N', 'D'].includes(r))
    ) {
      return ctx.reply(
        '❌ Format incorrect.\n\n' +
        'Envoie cinq résultats : V - V - N - D - V'
      );
    }

    const victoires = resultats.filter(r => r === 'V').length;
    const nuls = resultats.filter(r => r === 'N').length;
    const defaites = resultats.filter(r => r === 'D').length;

    ctx.session.mode = null;

    return ctx.reply(
      '📊 BILAN DES CINQ DERNIERS MATCHS\n\n' +
      '🟢 Victoires : ' + victoires + '\n' +
      '🟡 Nuls : ' + nuls + '\n' +
      '🔴 Défaites : ' + defaites + '\n\n' +
      '📈 Points obtenus : ' + (victoires * 3 + nuls) + '/15\n\n' +
      'Cette analyse repose uniquement sur les résultats que tu as fournis.'
    );
  }

  ctx.reply(
    '📩 Message reçu !\n\n' +
    'Pour utiliser le bot, sélectionne une commande :\n\n' +
    '/foot - Comparaison de match\n' +
    '/forme - Analyse des résultats récents\n' +
    '/live - Mode live\n' +
    '/help - Assistance'
  );
});

bot.catch((err) => {
  console.error('Erreur Telegram :', err);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Sport Analyzer AI V2 démarré.');
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
