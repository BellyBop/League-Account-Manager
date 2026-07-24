'use strict';

// Talks to the local League Client (the "LCU" API) to find out which account
// is currently signed in on this PC. This is local-machine state that Riot's
// public web API has no way to expose — unlike everything else in this app,
// it only works while the Riot/League Client is actually running here, and
// it needs no API key at all (it's a purely local connection).
//
// While running, League writes a "lockfile" into its install directory
// containing the local API's port and a one-time password, regenerated each
// launch: `LeagueClient:<pid>:<port>:<password>:<protocol>`.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { readInstallManifest } = require('./riotClient');
const { appendPhaseTrace } = require('./eogDebug');
const { rankValue } = require('./rank');

// A self-signed cert is normal for the local LCU API — this agent is only
// ever pointed at 127.0.0.1, never anything remote.
const localAgent = new https.Agent({ rejectUnauthorized: false });

function findLockfilePath() {
  const manifest = readInstallManifest();
  const leagueDir = manifest && manifest.associated_client && Object.keys(manifest.associated_client)[0];
  return leagueDir ? path.join(leagueDir, 'lockfile') : null;
}

function readLockfile() {
  const lockfilePath = findLockfilePath();
  if (!lockfilePath) return null;
  try {
    const contents = fs.readFileSync(lockfilePath, 'utf8');
    const [, , port, password, protocol] = contents.trim().split(':');
    if (!port || !password) return null;
    return { port, password, protocol: protocol || 'https' };
  } catch (e) {
    return null; // no lockfile — the client isn't running
  }
}

function lcuGet(lockfile, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: lockfile.port,
        path: endpoint,
        method: 'GET',
        agent: localAgent,
        timeout: 3000,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`riot:${lockfile.password}`).toString('base64'),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`LCU ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('LCU request timed out')));
    req.end();
  });
}

// Tracks gameflow-phase across polls so callers can detect two things:
// "a game just started" (the moment to snapshot pre-game ranked stats —
// see preGameRankedSnapshot below) and "a game that was in progress just
// ended" (used both to trigger one automatic refresh of the active
// account's card, and to trigger the post-game stats capture below).
// Deliberately NOT keyed on a literal "EndOfGame" phase string — a real
// captured phase trace showed this client version going straight from
// InProgress to "PreEndOfGame" to "Lobby" at a 15s poll interval, without
// ever landing exactly on "EndOfGame". Watching for that name specifically
// meant the capture silently never fired. Leaving InProgress is the one
// transition confirmed reliable at this poll granularity. Resets when the
// client isn't running, so stale state from a closed client can't fire a
// false positive against a later session.
let lastGameflowPhase = null;

async function pollGameflowTransition(lockfile) {
  let phase = null;
  try {
    const result = await lcuGet(lockfile, '/lol-gameflow/v1/gameflow-phase');
    if (typeof result === 'string') phase = result;
  } catch (e) {
    // Non-fatal — just means we can't tell right now.
  }
  appendPhaseTrace(phase);
  const previous = lastGameflowPhase;
  lastGameflowPhase = phase;
  return {
    phase,
    gameJustStarted: previous !== 'InProgress' && phase === 'InProgress',
    gameJustEnded: previous === 'InProgress' && phase !== 'InProgress' && phase != null,
  };
}

// The post-game stats block isn't available the instant a game ends — it
// turns out NOT to carry a ranked LP field at all (confirmed by inspecting
// a real captured block: it has combat stats, XP/IP rewards, and skin
// unlocks, but nothing resembling LP or a ranked-tier change). Real
// per-game LP instead comes from diffing current-ranked-stats before/after
// the game — see computeRankedLpDelta. This is kept for the debug snapshot
// only. Retries with a real gap, since this is captured right as the game
// leaves InProgress (see the note above pollGameflowTransition) — earlier
// than the data is guaranteed to be ready.
async function getEndOfGameStats(lockfile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      return await lcuGet(lockfile, '/lol-end-of-game/v1/eog-stats-block');
    } catch (e) {
      // Not populated yet (or this game had no ranked stats) — retry.
    }
  }
  return null;
}

// Solo/Duo entry from the LCU's own ranked-stats endpoint — this is what
// actually updates the instant a ranked game finishes (it's what draws the
// client's own "Victory! +18 LP" screen), unlike eog-stats-block.
async function getRankedSoloEntry(lockfile) {
  try {
    const stats = await lcuGet(lockfile, '/lol-ranked/v1/current-ranked-stats');
    const entry = stats && stats.queueMap && stats.queueMap.RANKED_SOLO_5x5;
    if (!entry) return null;
    return {
      tier: entry.tier,
      division: entry.division,
      leaguePoints: entry.leaguePoints,
      wins: entry.wins,
      losses: entry.losses,
    };
  } catch (e) {
    return null;
  }
}

// Captured the moment a game starts (see pollGameflowTransition's
// gameJustStarted), consumed the moment that same game ends. One-shot by
// design: if the app wasn't running when the game started, there's no
// baseline to diff against, so no delta gets reported for it — rather than
// comparing against some older, unrelated snapshot.
let preGameRankedSnapshot = null;

// Diffs ranked-stats before vs. after a completed ranked Solo/Duo game to
// get a real per-game LP change — Riot's public API has no such field, and
// (as of this client version) neither does eog-stats-block, so this is the
// only source that actually has it locally.
async function computeRankedLpDelta(lockfile, eogStats) {
  const pre = preGameRankedSnapshot;
  preGameRankedSnapshot = null;
  if (!pre) return null;
  if (!eogStats || eogStats.queueType !== 'RANKED_SOLO_5x5' || !eogStats.ranked) return null;

  // current-ranked-stats can lag the post-game screen by several seconds —
  // if the win/loss count hasn't moved yet, it's probably just not updated,
  // so retry with a real gap before concluding it genuinely didn't count
  // (a remake). The win/loss counter and the LP field don't always land in
  // the same read, either: a loss can show up before its LP hit does, which
  // reads as a real, non-remake game with tier/division/LP all identical to
  // pre — a combination that doesn't happen for a genuine result. Keep
  // retrying through that too, or it gets reported as a false "0 LP".
  let post = await getRankedSoloEntry(lockfile);
  for (let attempt = 0; attempt < 3; attempt++) {
    const recordMoved = post && post.wins + post.losses > pre.wins + pre.losses;
    const lpLooksStale =
      recordMoved &&
      post.tier === pre.tier &&
      post.division === pre.division &&
      post.leaguePoints === pre.leaguePoints;
    if (recordMoved && !lpLooksStale) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    post = await getRankedSoloEntry(lockfile);
  }
  if (!post) return null;

  if (post.wins + post.losses <= pre.wins + pre.losses) {
    // Ranked in queue-select, but didn't actually count — a remake.
    return { remake: true, promoted: false, demoted: false, lpChange: null, pre, post };
  }

  const sameRank = pre.tier === post.tier && pre.division === post.division;
  const preValue = rankValue({ tier: pre.tier, rank: pre.division, lp: pre.leaguePoints });
  const postValue = rankValue({ tier: post.tier, rank: post.division, lp: post.leaguePoints });
  const rankImproved = !sameRank && preValue != null && postValue != null && postValue > preValue;
  const rankWorsened = !sameRank && preValue != null && postValue != null && postValue < preValue;

  return {
    remake: false,
    promoted: rankImproved,
    demoted: rankWorsened,
    // A raw LP subtraction only means anything within the same tier/division
    // — crossing a promotion/demotion boundary resets the LP counter, so a
    // number there would be misleading rather than just imprecise.
    lpChange: sameRank ? post.leaguePoints - pre.leaguePoints : null,
    pre,
    post,
  };
}

/**
 * @returns {Promise<object>} { signedIn: false } if the client isn't running
 *   or nobody's logged in yet, else { signedIn: true, puuid, gameName,
 *   tagLine, summonerLevel, profileIconId }. Always includes `gameJustEnded`
 *   (true for exactly one poll right after an in-progress game ends),
 *   `eogStats` (the raw post-game stats block, debug-only — see
 *   getEndOfGameStats), and `lpDelta` (the real ranked LP change for that
 *   game, only on the poll where a game just ended and a pre-game snapshot
 *   existed to diff against — null otherwise).
 */
async function getCurrentSummoner() {
  const lockfile = readLockfile();
  if (!lockfile) {
    lastGameflowPhase = null;
    preGameRankedSnapshot = null;
    return { signedIn: false, gameJustEnded: false, eogStats: null, lpDelta: null };
  }

  const { gameJustStarted, gameJustEnded } = await pollGameflowTransition(lockfile);

  if (gameJustStarted) {
    preGameRankedSnapshot = await getRankedSoloEntry(lockfile);
  }

  const eogStats = gameJustEnded ? await getEndOfGameStats(lockfile) : null;
  const lpDelta = gameJustEnded ? await computeRankedLpDelta(lockfile, eogStats) : null;

  try {
    const summoner = await lcuGet(lockfile, '/lol-summoner/v1/current-summoner');
    if (!summoner || !summoner.puuid) return { signedIn: false, gameJustEnded, eogStats, lpDelta };
    return {
      signedIn: true,
      puuid: summoner.puuid,
      gameName: summoner.gameName || summoner.displayName || '',
      tagLine: summoner.tagLine || '',
      summonerLevel: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      gameJustEnded,
      eogStats,
      lpDelta,
    };
  } catch (e) {
    // Client running but not signed in yet (still at the login screen), or
    // this LCU endpoint's shape changed — either way, just report "unknown."
    return { signedIn: false, gameJustEnded, eogStats, lpDelta };
  }
}

module.exports = { getCurrentSummoner };
