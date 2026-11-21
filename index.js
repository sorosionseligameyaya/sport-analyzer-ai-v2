
const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN manquant.");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.get("/", (req, res) => {
  res.send("Sport Analyzer AI V2 fonctionne !");
});

bot.start(async (ctx) => {
  await ctx.reply(
    "⚽ Bienvenue sur Sport Analyzer AI V2 !\n\n" +
    "Je suis ton assistant d'analyse football.\n\n" +
    "📊 Je peux comparer deux équipes à partir des informations fournies.\n\n" +
    "Commandes disponibles :\n" +
    "/foot - Comparer deux équipes\n" +
    "/forme - Analyser les résultats récents\n" +
    "/live - Informations sur le live\n" +
    "/help - Aide"
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "📘 COMMANDES\n\n" +
    "/start - Démarrer le bot\n" +
    "/foot - Comparer deux équipes\n" +
    "/forme - Analyser les 5 derniers résultats\n" +
    "/live - Mode suivi en direct\n\n" +
    "Pour une comparaison, écris :\n" +
    "Paris vs Marseille\n\n" +
    "Pour une analyse de forme, envoie les 5 derniers résultats de l'équipe."
  );
});

bot.command("foot", async (ctx) => {
  await ctx.reply(
    "⚽ ANALYSE DE MATCH\n\n" +
    "Envoie le match sous cette forme :\n\n" +
    "Real Madrid vs Barcelona\n\n" +
    "Je pourrai ensuite t'aider à étudier les équipes, leurs statistiques et les informations disponibles."
  );
});

bot.command("forme", async (ctx) => {
  await ctx.reply(
    "📊 ANALYSE DE FORME\n\n" +
    "Envoie le nom de l'équipe avec ses 5 derniers résultats.\n\n" +
    "Exemple :\n" +
    "Real Madrid\n" +
    "V 2-0\n" +
    "V 3-1\n" +
    "N 1-1\n" +
    "D 0-2\n" +
    "V 2-1\n\n" +
    "V = Victoire\n" +
    "N = Nul\n" +
    "D = Défaite"
  );
});

bot.command("live", async (ctx) => {
  await ctx.reply(
    "🔴 MODE LIVE\n\n" +
    "Le module de données en direct n'est pas encore connecté.\n\n" +
    "Cette fonctionnalité sera activée lorsque nous aurons une source de scores en direct fiable."
  );
});

bot.on("text", async (ctx) => {
  const message = ctx.message.text;

  if (message.startsWith("/")) return;

  await ctx.reply(
    "📩 Message reçu !\n\n" +
    "Pour utiliser le bot, sélectionne une commande :\n\n" +
    "/foot - Comparaison de match\n" +
    "/forme - Analyse des résultats récents\n" +
    "/live - Mode live\n" +
    "/help - Assistance"
  );
});

bot.catch((err) => {
  console.error("Erreur Telegram :", err);
});

app.use(express.json());

app.listen(process.env.PORT || 3000, () => {
  console.log("Sport Analyzer AI V2 démarré.");
});

bot.launch()
  .then(() => console.log("Bot Telegram lancé."))
  .catch((err) => console.error("Erreur de lancement :", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
