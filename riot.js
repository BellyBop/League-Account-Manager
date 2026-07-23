'use strict';

// ---------------------------------------------------------------------------
// Riot API helper. Runs in the Electron MAIN process so the API key never
// touches the renderer and we avoid browser CORS restrictions.
// ---------------------------------------------------------------------------

// Region routing. Riot splits endpoints across "platform" hosts (summoner /
// league) and "regional" hosts (account / match). See:
//   https://developer.riotgames.com/docs/lol#routing-values
const REGIONS = {
  oce:  { label: 'Oceania (OCE)',        platform: 'oc1',  match: 'sea',      account: 'americas' },
  na:   { label: 'North America (NA)',   platform: 'na1',  match: 'americas', account: 'americas' },
  br:   { label: 'Brazil (BR)',          platform: 'br1',  match: 'americas', account: 'americas' },
  lan:  { label: 'Latin America N (LAN)',platform: 'la1',  match: 'americas', account: 'americas' },
  las:  { label: 'Latin America S (LAS)',platform: 'la2',  match: 'americas', account: 'americas' },
  euw:  { label: 'Europe West (EUW)',    platform: 'euw1', match: 'europe',   account: 'europe' },
  eune: { label: 'Europe Nordic (EUNE)', platform: 'eun1', match: 'europe',   account: 'europe' },
  tr:   { label: 'Turkey (TR)',          platform: 'tr1',  match: 'europe',   account: 'europe' },
  ru:   { label: 'Russia (RU)',          platform: 'ru',   match: 'europe',   account: 'europe' },
  kr:   { label: 'Korea (KR)',           platform: 'kr',   match: 'asia',     account: 'asia' },
  jp:   { label: 'Japan (JP)',           platform: 'jp1',  match: 'asia',     account: 'asia' },
};

// Cache the Data Dragon version so we don't fetch it on every card refresh.
let ddragonVersion = null;
let ddragonVersionFetchedAt = 0;

async function getDDragonVersion() {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (ddragonVersion && Date.now() - ddragonVersionFetchedAt < ONE_DAY) {
    return ddragonVersion;
  }
  try {
    const res = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const versions = await res.json();
    ddragonVersion = versions[0];
    ddragonVersionFetchedAt = Date.now();
  } catch (e) {
    ddragonVersion = ddragonVersion || '14.24.1'; // fallback so images still load
  }
  return ddragonVersion;
}

function champIconUrl(version, championName) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championName}.png`;
}

function profileIconUrl(version, iconId) {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${iconId}.png`;
}

// Numeric champion id -> display name, resolved from Data Dragon and cached.
let championNameById = null;
let championNameByIdVersion = null;

async function getChampionNameByIdMap(version) {
  if (championNameById && championNameByIdVersion === version) return championNameById;
  const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  const json = await res.json();
  const map = {};
  for (const key of Object.keys(json.data)) {
    map[Number(json.data[key].key)] = json.data[key].name;
  }
  championNameById = map;
  championNameByIdVersion = version;
  return map;
}

// A small wrapper that surfaces Riot's error codes in a human-friendly way.
async function riotGet(url, apiKey) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('EXPIRED_KEY');
    err.code = res.status;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('NOT_FOUND');
    err.code = 404;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error('RATE_LIMITED');
    err.code = 429;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Riot API ${res.status}: ${text}`);
  }
  return res.json();
}

// Parse "GameName#TAG" into its two parts.
function parseRiotId(riotId) {
  const idx = (riotId || '').lastIndexOf('#');
  if (idx === -1) return null;
  const gameName = riotId.slice(0, idx).trim();
  const tagLine = riotId.slice(idx + 1).trim();
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MATCH_DETAIL_DELAY_MS = 200;

/**
 * Resolves a batch of match IDs into lightweight match summaries, reusing
 * `cache` (a plain object keyed by matchId, if supplied) instead of
 * re-fetching matches already known — match results never change once the
 * game ends, so anything already in the cache is a free hit. This is the
 * single source of match-detail fetching for both the "last 5 games" list
 * and the deeper today's-matches pagination, so both benefit from the cache.
 *
 * @param {object} opts { apiKey, region, puuid, matchIds, cache? }
 * @returns {Promise<object[]>} one entry per resolvable match ID
 */
async function getMatchDetails({ apiKey, region, puuid, matchIds, cache }) {
  const routing = REGIONS[region];
  if (!routing) return [];

  const results = [];
  let calledNetwork = false;
  for (const matchId of matchIds) {
    const cached = cache && cache[matchId];
    if (cached) {
      results.push(cached);
      continue;
    }

    if (calledNetwork) await delay(MATCH_DETAIL_DELAY_MS); // space out real network calls only
    calledNetwork = true;
    try {
      const match = await riotGet(
        `https://${routing.match}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
        apiKey
      );
      const me = match.info.participants.find((p) => p.puuid === puuid);
      if (!me) continue;
      const detail = {
        matchId,
        championName: me.championName,
        win: me.win,
        kills: me.kills,
        deaths: me.deaths,
        assists: me.assists,
        queueId: match.info.queueId,
        gameMode: match.info.gameMode,
        durationSec: match.info.gameDuration,
        gameEndTimestamp: match.info.gameEndTimestamp,
        // Remakes (early-surrendered AFK games) show a win/loss result here
        // but Riot excludes them from ranked wins/losses entirely — that's
        // how the "Solo W/L Today" tally can legitimately show fewer games
        // than are visible in the "last 5 games" list.
        remake: Boolean(me.gameEndedInEarlySurrender),
      };
      if (cache) cache[matchId] = detail;
      results.push(detail);
    } catch (e) {
      // Skip a single bad match rather than failing the whole lookup.
    }
  }
  return results;
}

/**
 * Fetch everything we display for one account: IGN, rank, last 5 games.
 * @param {object} opts { apiKey, riotId, region, knownPuuid?, matchCache? }
 *   knownPuuid — if the caller already resolved this exact riotId before,
 *     passing its puuid skips the account-v1 lookup call entirely.
 *   matchCache — plain object keyed by matchId, shared with getMatchDetails
 *     to avoid re-fetching matches already seen (see main.js).
 */
async function fetchAccountData({ apiKey, riotId, region, knownPuuid, matchCache }) {
  if (!apiKey) throw new Error('NO_KEY');
  const routing = REGIONS[region];
  if (!routing) throw new Error(`Unknown region: ${region}`);

  const parsed = parseRiotId(riotId);
  if (!parsed) throw new Error('BAD_RIOT_ID');

  const version = await getDDragonVersion();

  // 1) Riot ID -> PUUID (account-v1, regional host) — skipped when the
  // caller already knows the puuid for this exact riotId string.
  let puuid = knownPuuid;
  let gameName = parsed.gameName;
  let tagLine = parsed.tagLine;
  if (!puuid) {
    const account = await riotGet(
      `https://${routing.account}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
        `${encodeURIComponent(parsed.gameName)}/${encodeURIComponent(parsed.tagLine)}`,
      apiKey
    );
    puuid = account.puuid;
    gameName = account.gameName;
    tagLine = account.tagLine;
  }

  // 2) PUUID -> summoner (summoner-v4, platform host). Gives us profile icon + level.
  const summoner = await riotGet(
    `https://${routing.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
    apiKey
  );

  // 3) Ranked entries (league-v4, platform host).
  let rankEntries = [];
  try {
    rankEntries = await riotGet(
      `https://${routing.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
      apiKey
    );
  } catch (e) {
    // Fallback for older routing that keyed off summonerId.
    if (summoner.id) {
      rankEntries = await riotGet(
        `https://${routing.platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`,
        apiKey
      ).catch(() => []);
    }
  }

  const solo = rankEntries.find((r) => r.queueType === 'RANKED_SOLO_5x5');
  const flex = rankEntries.find((r) => r.queueType === 'RANKED_FLEX_SR');

  // 4) Last 5 match IDs (match-v5, regional match host) + their details,
  // reusing matchCache for any already fetched in a previous refresh.
  const matchIds = await riotGet(
    `https://${routing.match}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5`,
    apiKey
  );
  const matchDetails = await getMatchDetails({ apiKey, region, puuid, matchIds, cache: matchCache });
  const games = matchDetails.map((m) => ({ ...m, championIcon: champIconUrl(version, m.championName) }));

  return {
    puuid,
    ign: `${gameName}#${tagLine}`,
    gameName,
    tagLine,
    summonerLevel: summoner.summonerLevel,
    profileIcon: profileIconUrl(version, summoner.profileIconId),
    solo: solo
      ? {
          tier: solo.tier,
          rank: solo.rank,
          lp: solo.leaguePoints,
          wins: solo.wins,
          losses: solo.losses,
        }
      : null,
    flex: flex
      ? {
          tier: flex.tier,
          rank: flex.rank,
          lp: flex.leaguePoints,
          wins: flex.wins,
          losses: flex.losses,
        }
      : null,
    games,
    fetchedAt: Date.now(),
  };
}

// Fetches a page of match history further back than the "last 5" list goes
// — used to find the true start of "today" when someone's played more Solo
// games than that, without paying for it on every refresh (see
// ensureTodayMatches in main.js, which only calls this when actually needed
// and caches the result for the rest of the day).
async function fetchMatchPage({ apiKey, puuid, region, start, count, cache }) {
  const routing = REGIONS[region];
  if (!routing) return [];
  const matchIds = await riotGet(
    `https://${routing.match}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}`,
    apiKey
  );
  return getMatchDetails({ apiKey, region, puuid, matchIds, cache });
}

// ---------------------------------------------------------------------------
// Collective champion mastery widget: the N champions with the highest
// combined mastery points across all accounts. Deliberately separate from
// fetchAccountData: this is refreshed on its own slow schedule (weekly)
// rather than on every card refresh.
// ---------------------------------------------------------------------------
const MASTERY_TOP_N = 5;

// One call per account returns ALL of that account's champion masteries —
// cheaper than querying champion-by-champion, and lets us find whichever
// champions actually rank highest instead of guessing a fixed list upfront.
async function fetchAllChampionMasteries({ apiKey, puuid, region }) {
  const routing = REGIONS[region];
  if (!routing) return [];
  try {
    return await riotGet(
      `https://${routing.platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`,
      apiKey
    );
  } catch (e) {
    // A 404 genuinely means no mastery data at all for this account — a
    // real "nothing to add." Anything else (rate limited, expired key,
    // network blip) must NOT be swallowed: it needs to fail the whole
    // computation so the caller keeps whatever it had cached rather than
    // overwriting good data with an incomplete result.
    if (e.message === 'NOT_FOUND') return [];
    throw e;
  }
}

/**
 * @param {object} opts { apiKey, accounts: [{ id, puuid, region }] }
 */
async function computeMasteryWidget({ apiKey, accounts }) {
  const version = await getDDragonVersion();
  const championNames = await getChampionNameByIdMap(version);
  const usable = accounts.filter((a) => a.puuid && a.region);

  const totals = new Map(); // championId -> { total, perAccount: { accountId: points } }

  for (let i = 0; i < usable.length; i++) {
    const account = usable[i];
    // Space requests out — this runs right after (or during) a much
    // heavier per-account refresh cycle, so stay gentle on the rate limit.
    if (i > 0) await delay(600);

    const masteries = await fetchAllChampionMasteries({ apiKey, puuid: account.puuid, region: account.region });
    for (const m of masteries) {
      if (!totals.has(m.championId)) totals.set(m.championId, { total: 0, perAccount: {} });
      const entry = totals.get(m.championId);
      const points = m.championPoints || 0;
      entry.total += points;
      entry.perAccount[account.id] = points;
    }
  }

  const topChampions = [...totals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, MASTERY_TOP_N)
    .map(([championId, entry]) => ({
      championId,
      championName: championNames[championId] || `Champion ${championId}`,
      total: entry.total,
      perAccount: entry.perAccount,
    }));

  // Tracked separately from perAccount membership: an account can legitimately
  // contribute 0 to every top champion (so it'd never appear in perAccount),
  // which is different from "this account was never queried."
  return { fetchedAt: Date.now(), topChampions, accountIds: usable.map((a) => a.id) };
}

module.exports = {
  fetchAccountData,
  REGIONS,
  computeMasteryWidget,
  fetchMatchPage,
  getDDragonVersion,
  profileIconUrl,
};
