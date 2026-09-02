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
const { readInstallManifest, localApiRequest } = require('./riotClient');
const { appendPhaseTrace } = require('./eogDebug');
const { rankValue } = require('./rank');

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

async function lcuGet(lockfile, endpoint) {
  const { status, body } = await localApiRequest(lockfile, 'GET', endpoint);
  if (status < 200 || status >= 300) throw new Error(`LCU ${status}`);
  return JSON.parse(body);
}

function pickNumber(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

// Same as lcuGet but never throws and logs the raw status + a snippet of the
// body — the wallet/champions LCU endpoints have moved around between client
// versions, so when one doesn't return what we expect the `[lcu]` lines in the
// terminal (npm start) are what tell us which path this client actually uses.
async function lcuTry(lockfile, endpoint) {
  try {
    const { status, body } = await localApiRequest(lockfile, 'GET', endpoint);
    if (status < 200 || status >= 300) {
      console.log(`[lcu] GET ${endpoint} -> ${status} ${String(body).slice(0, 200)}`);
      return null;
    }
    return JSON.parse(body);
  } catch (e) {
    console.log(`[lcu] GET ${endpoint} -> error ${e.message}`);
    return null;
  }
}

// Blue Essence / Riot Points / champions-owned for the signed-in account.
// None of this is exposed by Riot's public web API — the only source is the
// local League Client, so (like the active-account widget and per-game LP)
// it's only available for whoever's currently logged in on this PC. Cached
// briefly and keyed by puuid so switching accounts doesn't briefly show the
// previous account's numbers.
// Once we have a full capture there's nothing to chase — champions/skins/BE
// only move when you buy something — so re-read it only occasionally.
const INVENTORY_TTL_MS = 5 * 60 * 1000;
// While a capture is still incomplete (right after signing in, the LCU brings
// /lol-summoner up first and /lol-champions, /lol-inventory, /lol-champions
// skins several seconds to tens of seconds later) retry fast, then escalate the
// gap so a client that genuinely never exposes these settles down instead of
// re-issuing ~7 requests forever.
const INVENTORY_RETRY_BASE_MS = 8 * 1000;
const INVENTORY_RETRY_MAX_MS = 5 * 60 * 1000;
let inventoryCache = { puuid: null, at: 0, value: null, attempts: 0 };

// "Complete enough to stop the fast retry": we have the champion list — the
// slowest, flakiest endpoint to warm up after a sign-in. The wallet responds
// promptly when it responds at all, so a missing BE/RP here just means that
// client doesn't expose it; don't keep hammering all ~4 wallet endpoints on a
// tight loop waiting for a number that isn't coming.
function inventoryComplete(v) {
  return Boolean(v && Array.isArray(v.ownedChampionIds) && v.ownedChampionIds.length);
}

// Keep the richer of an existing capture and a fresh (possibly still-warming)
// one for the same account — a poll that momentarily lost the champion list
// must not wipe a capture that already had it.
function mergeInventory(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const pick = (n, p) => (n != null ? n : p);
  const pickList = (n, p) => (Array.isArray(n) && n.length ? n : p);
  return {
    blueEssence: pick(next.blueEssence, prev.blueEssence),
    riotPoints: pick(next.riotPoints, prev.riotPoints),
    ownedChampionIds: pickList(next.ownedChampionIds, prev.ownedChampionIds),
    ownedSkins: pickList(next.ownedSkins, prev.ownedSkins),
    fetchedAt: Date.now(),
  };
}

async function fetchInventory(lockfile, summonerId) {
  console.log(`[lcu] fetchInventory summonerId=${summonerId || '(missing)'}`);
  let blueEssence = null;
  let riotPoints = null;

  // The currency-typed path is what current clients answer. It's explicitly
  // queried for exactly these two currencies, so if it returns at all, a
  // missing key means that balance is simply 0 (accounts that have never held
  // RP just omit "RP" rather than sending "RP":0) — don't keep hunting.
  const typed = await lcuTry(lockfile, '/lol-inventory/v1/wallet/lol_blue_essence,RP');
  if (typed && typeof typed === 'object') {
    const be = pickNumber(typed.lol_blue_essence, typed.ip);
    const rp = pickNumber(typed.RP, typed.rp);
    if (be != null || rp != null) {
      blueEssence = be != null ? be : 0;
      riotPoints = rp != null ? rp : 0;
    }
  }

  // Fallbacks for older clients whose field names / namespaces differ
  // ({ ip, rp }, etc.) — only if the modern path gave us nothing.
  if (blueEssence == null || riotPoints == null) {
    for (const endpoint of ['/lol-store/v1/wallet', '/lol-inventory/v1/wallet', '/lol-rms/v1/wallet']) {
      const wallet = await lcuTry(lockfile, endpoint);
      if (wallet && typeof wallet === 'object') {
        const be = pickNumber(wallet.lol_blue_essence, wallet.ip, wallet.blueEssence);
        const rp = pickNumber(wallet.RP, wallet.rp, wallet.riotPoints);
        if (be != null) blueEssence = be;
        if (rp != null) riotPoints = rp;
      }
      if (blueEssence != null && riotPoints != null) break;
    }
  }

  // Pull the raw list of champion IDs this account owns. Which endpoint has it
  // (and whether entries carry an `ownership` flag or the list is pre-filtered
  // to owned) varies by client version, so handle both shapes. The caller
  // intersects these IDs against Data Dragon's real champion list to get the
  // owned/total counts — doing it here would repeat the "236/173" bug, since
  // this list can contain stale or non-playable IDs.
  let ownedChampionIds = null;
  let ownedSkins = null;
  const candidates = [];
  if (summonerId) candidates.push(`/lol-champions/v1/inventories/${summonerId}/champions-minimal`);
  candidates.push('/lol-champions/v1/owned-champions-minimal');

  for (const endpoint of candidates) {
    const list = await lcuTry(lockfile, endpoint);
    if (!Array.isArray(list) || !list.length) continue;
    const owned = list.filter(
      (c) => c && typeof c.id === 'number' && c.id > 0 && (!c.ownership || c.ownership.owned)
    );
    ownedChampionIds = owned.map((c) => c.id);

    // Some client versions embed a per-champion `skins` array on each entry —
    // grab owned non-base skins from there if present.
    const skins = collectOwnedSkins(list);
    if (skins.length) ownedSkins = skins;

    console.log(
      `[lcu] ${endpoint}: ${list.length} entries, ${ownedChampionIds.length} champs owned, ${skins.length} skins inline`
    );
    break;
  }

  // If skins didn't ride along on the champion list, ask for them directly.
  if (!ownedSkins && summonerId) {
    const skinList = await lcuTry(lockfile, `/lol-champions/v1/inventories/${summonerId}/skins-minimal`);
    if (Array.isArray(skinList)) {
      ownedSkins = skinList.filter(isOwnedNonBaseSkin).map(toOwnedSkin);
      console.log(`[lcu] skins-minimal: ${skinList.length} entries, ${ownedSkins.length} owned`);
    }
  }

  if (blueEssence == null && riotPoints == null && ownedChampionIds == null && ownedSkins == null) return null;
  return { blueEssence, riotPoints, ownedChampionIds, ownedSkins, fetchedAt: Date.now() };
}

// A real skin id is `championId * 1000 + skinNum` — champion ids top out well
// under 2000, so anything past ~2,000,000 is a non-champion entry the client
// lumps in here ("Classic <champ>" pseudo-skins, event tokens, etc.). skinNum 0
// (or `isBase`) is the base skin, not something you "own".
function isOwnedNonBaseSkin(s) {
  return (
    s &&
    typeof s.id === 'number' &&
    s.id > 0 &&
    s.id < 2000000 &&
    s.id % 1000 !== 0 &&
    !s.isBase &&
    s.ownership &&
    s.ownership.owned
  );
}

// skinNum (id % 1000) is enough to build the loading-art URL, but championId is
// carried through too so the renderer never has to guess it for oddly-numbered
// skin IDs.
function toOwnedSkin(s) {
  return {
    id: s.id,
    name: s.name || '',
    championId: typeof s.championId === 'number' ? s.championId : Math.floor(s.id / 1000),
  };
}

function collectOwnedSkins(championList) {
  const out = [];
  for (const c of championList) {
    if (!c || !Array.isArray(c.skins)) continue;
    for (const s of c.skins) {
      if (isOwnedNonBaseSkin(s)) out.push(toOwnedSkin(s));
    }
  }
  return out;
}

async function getAccountInventory(lockfile, summoner, force) {
  const now = Date.now();
  const puuid = summoner && summoner.puuid;
  const sameAcct = inventoryCache.puuid === puuid;

  const ttl = inventoryComplete(inventoryCache.value)
    ? INVENTORY_TTL_MS
    : Math.min(INVENTORY_RETRY_BASE_MS * 2 ** inventoryCache.attempts, INVENTORY_RETRY_MAX_MS);
  if (!force && sameAcct && now - inventoryCache.at < ttl) {
    return inventoryCache.value;
  }

  const fresh = await fetchInventory(lockfile, summoner && summoner.summonerId);
  const value = mergeInventory(sameAcct ? inventoryCache.value : null, fresh);
  inventoryCache = {
    puuid,
    at: now,
    value,
    attempts: inventoryComplete(value) ? 0 : (sameAcct ? inventoryCache.attempts + 1 : 1),
  };
  return value;
}

const LEAGUE_CLOSE_POLL_MS = 500;
const LEAGUE_CLOSE_TIMEOUT_MS = 6000;

// Closes League gracefully via its own official shutdown endpoint
// (process-control/v1/process/quit) rather than killing the process, then
// waits for its lockfile to actually disappear — the quit call returns as
// soon as it's accepted, not once League has finished tearing down. Used by
// riotclient:signOut: Riot Client's own local API refuses to end a session
// while League (or another Riot game) is still running (confirmed live:
// error "sign_out_failed_other_games_running"), so this has to happen and
// fully finish first.
async function closeLeagueClient() {
  const lockfile = readLockfile();
  if (!lockfile) return { ok: true }; // not running — nothing to close

  let quit;
  try {
    quit = await localApiRequest(lockfile, 'POST', '/process-control/v1/process/quit');
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (quit.status !== 204) return { ok: false, error: `Unexpected response (${quit.status})` };

  const start = Date.now();
  while (readLockfile() && Date.now() - start < LEAGUE_CLOSE_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, LEAGUE_CLOSE_POLL_MS));
  }
  return readLockfile() ? { ok: false, error: 'League Client did not finish closing in time' } : { ok: true };
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
// Tracks which account the last poll saw signed in, so the poll right after an
// account switch can force a fresh inventory read instead of waiting out the
// retry gap.
let lastSignedInPuuid = null;

async function getCurrentSummoner(forceInventory) {
  const lockfile = readLockfile();
  if (!lockfile) {
    lastGameflowPhase = null;
    preGameRankedSnapshot = null;
    lastSignedInPuuid = null;
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
    const justSignedIn = lastSignedInPuuid !== summoner.puuid;
    lastSignedInPuuid = summoner.puuid;
    const inventory = await getAccountInventory(lockfile, summoner, forceInventory || justSignedIn).catch(() => null);
    return {
      signedIn: true,
      puuid: summoner.puuid,
      gameName: summoner.gameName || summoner.displayName || '',
      tagLine: summoner.tagLine || '',
      summonerLevel: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      inventory,
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

module.exports = { getCurrentSummoner, closeLeagueClient };
