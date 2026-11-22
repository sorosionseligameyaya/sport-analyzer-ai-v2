'use strict';

/*
 * SPORT ANALYZER AI — FIFA virtual football analysis engine
 *
 * This module deliberately does NOT fetch 1xBet data.
 * It accepts normalized match data from a future, verified provider.
 * It never creates odds, scores, fixtures or historical results.
 */

const MIN_HISTORY = 5;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function classifyStatus(status) {
  const s = normalizeText(status);
  if (['live', '1h', '2h', 'ht', 'et', 'inplay', 'in play'].includes(s)) return 'LIVE';
  if (['finished', 'ft', 'ended', 'full time'].includes(s)) return 'FINISHED';
  if (['scheduled', 'not started', 'ns', 'prematch', 'pre match'].includes(s)) return 'PREMATCH';
  return 'UNKNOWN';
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const home = raw.home || raw.homeTeam || raw.team1;
  const away = raw.away || raw.awayTeam || raw.team2;
  if (!home || !away) return null;

  const scoreHome = raw.score && Number.isFinite(Number(raw.score.home))
    ? Number(raw.score.home) : null;
  const scoreAway = raw.score && Number.isFinite(Number(raw.score.away))
    ? Number(raw.score.away) : null;

  return {
    id: raw.id == null ? null : String(raw.id),
    competition: raw.competition || raw.league || 'Non renseignée',
    format: raw.format || raw.gameMode || 'Non renseigné',
    home: String(home),
    away: String(away),
    status: classifyStatus(raw.status || raw.state),
    minute: Number.isFinite(Number(raw.minute)) ? Number(raw.minute) : null,
    score: scoreHome !== null && scoreAway !== null
      ? { home: scoreHome, away: scoreAway } : null,
    kickoff: raw.kickoff || raw.date || null,
    odds: Array.isArray(raw.odds) ? raw.odds.filter(isValidOdd) : [],
    source: raw.source || null,
    capturedAt: raw.capturedAt || new Date().toISOString()
  };
}

function isValidOdd(item) {
  return item &&
    typeof item.market === 'string' &&
    typeof item.selection === 'string' &&
    Number.isFinite(Number(item.odd)) &&
    Number(item.odd) > 1;
}

function summarizeHistory(results, teamName) {
  const target = normalizeText(teamName);
  const rows = (Array.isArray(results) ? results : []).filter(m => {
    if (!m || !m.score || !Number.isFinite(m.score.home) || !Number.isFinite(m.score.away)) return false;
    return normalizeText(m.home) === target || normalizeText(m.away) === target;
  }).slice(0, 20);

  let gf = 0, ga = 0, wins = 0, draws = 0, losses = 0;
  let over15 = 0, over25 = 0, btts = 0;

  for (const m of rows) {
    const isHome = normalizeText(m.home) === target;
    const scored = isHome ? m.score.home : m.score.away;
    const conceded = isHome ? m.score.away : m.score.home;

    gf += scored;
    ga += conceded;
    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;

    if (m.score.home + m.score.away >= 2) over15++;
    if (m.score.home + m.score.away >= 3) over25++;
    if (m.score.home > 0 && m.score.away > 0) btts++;
  }

  return {
    team: teamName,
    matches: rows.length,
    goalsFor: gf,
    goalsAgainst: ga,
    avgFor: rows.length ? gf / rows.length : null,
    avgAgainst: rows.length ? ga / rows.length : null,
    wins, draws, losses,
    over15Rate: rows.length ? over15 / rows.length : null,
    over25Rate: rows.length ? over25 / rows.length : null,
    bttsRate: rows.length ? btts / rows.length : null,
    sufficient: rows.length >= MIN_HISTORY
  };
}

function poisson(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda < 0) return 0;
  let factorial = 1;
  for (let i = 2; i <= goals; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function buildScoreMatrix(lambdaHome, lambdaAway, maxGoals = 8) {
  const matrix = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      matrix.push({ home: h, away: a, probability: poisson(lambdaHome, h) * poisson(lambdaAway, a) });
    }
  }
  return matrix;
}

function analyzeMatch(matchInput, history) {
  const match = normalizeMatch(matchInput);
  if (!match) {
    return { ok: false, reason: 'Match invalide : équipes domicile et extérieur manquantes.' };
  }

  const homeHistory = summarizeHistory(history, match.home);
  const awayHistory = summarizeHistory(history, match.away);

  if (!homeHistory.sufficient || !awayHistory.sufficient) {
    return {
      ok: false,
      match,
      reason: `Historique insuffisant : au moins ${MIN_HISTORY} résultats terminés par équipe sont nécessaires.`,
      dataNeeded: {
        home: `${homeHistory.matches}/${MIN_HISTORY}`,
        away: `${awayHistory.matches}/${MIN_HISTORY}`
      }
    };
  }

  // Simple baseline from each team's observed scoring/conceding averages.
  // It is not calibrated for a specific virtual provider or game mode.
  const lambdaHome = Math.max(0.05, (homeHistory.avgFor + awayHistory.avgAgainst) / 2);
  const lambdaAway = Math.max(0.05, (awayHistory.avgFor + homeHistory.avgAgainst) / 2);
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway);

  let homeWin = 0, draw = 0, awayWin = 0, over15 = 0, over25 = 0, over35 = 0, btts = 0;
  for (const cell of matrix) {
    const p = cell.probability;
    if (cell.home > cell.away) homeWin += p;
    else if (cell.home === cell.away) draw += p;
    else awayWin += p;

    const total = cell.home + cell.away;
    if (total >= 2) over15 += p;
    if (total >= 3) over25 += p;
    if (total >= 4) over35 += p;
    if (cell.home > 0 && cell.away > 0) btts += p;
  }

  const topScores = [...matrix]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5)
    .map(x => ({ score: `${x.home}-${x.away}`, probability: roundPct(x.probability) }));

  return {
    ok: true,
    match,
    method: 'Baseline Poisson à partir des historiques fournis',
    warning: 'Estimation expérimentale non calibrée pour ce jeu virtuel. Elle ne garantit aucun résultat.',
    sample: { home: homeHistory.matches, away: awayHistory.matches },
    expectedGoals: { home: round2(lambdaHome), away: round2(lambdaAway) },
    probabilities: {
      homeWin: roundPct(homeWin),
      draw: roundPct(draw),
      awayWin: roundPct(awayWin),
      over15: roundPct(over15),
      over25: roundPct(over25),
      over35: roundPct(over35),
      btts: roundPct(btts)
    },
    topScores,
    actualOdds: match.odds
  };
}

function roundPct(value) {
  return Math.round(value * 10000) / 100;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatAnalysis(result) {
  if (!result || !result.ok) {
    return `⚠️ Analyse impossible\n${result && result.reason ? result.reason : 'Données invalides.'}`;
  }

  const p = result.probabilities;
  const odds = result.actualOdds.length
    ? result.actualOdds.map(o => `${o.market} — ${o.selection}: ${o.odd}`).join('\n')
    : 'Aucune cote réelle fournie par la source.';

  return [
    `🎮 ${result.match.competition} | ${result.match.format}`,
    `${result.match.home} – ${result.match.away}`,
    `Statut : ${result.match.status}`,
    '',
    `📊 Probabilités expérimentales`,
    `1 : ${p.homeWin}% | N : ${p.draw}% | 2 : ${p.awayWin}%`,
    `+1,5 but : ${p.over15}%`,
    `+2,5 buts : ${p.over25}%`,
    `+3,5 buts : ${p.over35}%`,
    `BTTS : ${p.btts}%`,
    '',
    `⚽ Buts attendus : ${result.expectedGoals.home} – ${result.expectedGoals.away}`,
    `Scores les plus probables : ${result.topScores.map(s => `${s.score} (${s.probability}%)`).join(', ')}`,
    '',
    `💹 Cotes réellement reçues`,
    odds,
    '',
    `⚠️ ${result.warning}`
  ].join('\n');
}

module.exports = {
  normalizeText,
  classifyStatus,
  normalizeMatch,
  summarizeHistory,
  analyzeMatch,
  formatAnalysis
};
