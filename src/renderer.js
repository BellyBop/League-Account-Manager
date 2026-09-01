'use strict';

// ---------------------------------------------------------------------------
// Renderer: builds the account cards and wires up the modals.
// All privileged work (file IO, Riot API) goes through window.api (preload).
//
// Deliberately kept as one plain script rather than split into ES modules:
// this is loaded via win.loadFile() (a file:// origin), where Chromium's
// module loader hits CORS restrictions that a bundler or custom protocol
// would be needed to work around — not worth the added build complexity for
// this app's size.
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const cardsEl = el('cards');
const emptyStateEl = el('emptyState');
const noMatchesEl = el('noMatches');
const keyWarningEl = el('keyWarning');

let accounts = [];
let settings = { apiKey: '', defaultRegion: 'oce', launchOnStartup: false };
let regions = {};
let editingId = null; // null => adding a new account
let mastery = null;
let searchText = '';
let filterType = '';
let filterRank = '';
let draggedAccountId = null;
let activeAccountStatus = null;
let appVersion = '';

// Data Dragon champion list (id -> { key, name }) + version, for turning an
// account's owned-champion / owned-skin ID lists into names and pictures.
let championById = new Map();
let ddragonVersion = '';
let collectionState = null; // { kind, ign, items } for the owned-collection modal

const ACTIVE_ACCOUNT_POLL_MS = 15000;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  regions = await window.api.getRegions();
  settings = await window.api.getSettings();
  accounts = await window.api.getAccounts();
  mastery = await window.api.getMastery();
  appVersion = await window.api.getAppVersion();
  await loadChampionCatalog();

  populateRegionSelect(el('fieldRegion'));
  populateRegionSelect(el('fieldDefaultRegion'));

  wireEvents();
  applyDensity();
  render();
  renderMastery();
  refreshAll(); // pull fresh data on launch (uses cache instantly, then updates)

  // Local-only and cheap (no Riot API involved), so this can poll far more
  // often than the account cards do — it's just asking the League Client
  // running on this PC who's currently signed in.
  refreshActiveAccount();
  setInterval(() => refreshActiveAccount(), ACTIVE_ACCOUNT_POLL_MS);

  // Auto-update: the main process pushes status as it checks / downloads a new
  // release; show a banner once one's ready to install.
  window.api.onUpdateStatus(applyUpdateStatus);
  applyUpdateStatus(await window.api.getUpdateStatus());
}

function applyUpdateStatus(state) {
  const banner = el('updateBanner');
  const text = el('updateBannerText');
  const restartBtn = el('updateRestartBtn');
  if (!state || state.status === 'idle' || state.status === 'checking' || state.status === 'error') {
    banner.classList.add('hidden');
    return;
  }
  if (state.status === 'downloading') {
    banner.classList.remove('hidden');
    restartBtn.classList.add('hidden');
    text.textContent = `Downloading update${state.version ? ` ${state.version}` : ''}…${state.percent ? ` ${state.percent}%` : ''}`;
    return;
  }
  if (state.status === 'ready') {
    banner.classList.remove('hidden');
    restartBtn.classList.remove('hidden');
    text.textContent = `Update ${state.version || ''} ready — restart to apply.`;
  }
}

function applyDensity() {
  document.body.classList.toggle('compact', !!settings.compactView);
  const btn = el('densityToggleBtn');
  btn.textContent = settings.compactView ? '▭ Wide view' : '▦ Compact view';
  btn.title = settings.compactView ? 'Switch to the wide layout' : 'Switch to a denser layout';
}

async function toggleDensity() {
  settings = await window.api.saveSettings({ compactView: !settings.compactView });
  applyDensity();
}

function populateRegionSelect(select) {
  select.innerHTML = '';
  for (const [key, r] of Object.entries(regions)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = r.label;
    select.appendChild(opt);
  }
}

// Format-only check: can we tell client-side, without ever calling Riot,
// that this key is unusable? Used to decide whether a refresh should even
// attempt a network call.
function keyFormatInvalid() {
  return !settings.apiKey || !settings.apiKey.startsWith('RGAPI-');
}

// Set true the moment any Riot call succeeds (a per-account refresh, or the
// validate probe after pasting a key) and false when one comes back 401/403.
// A Riot dev-key 401/403 is always key-wide, so one success is enough to treat
// the key as live and drop the banner, even while stale per-account "expired"
// errors from the previous key linger (they'd otherwise keep the banner up
// forever). It can go stale if the key expires mid-session with no refresh
// after — same as before this flag existed; the next manual refresh corrects it.
let keyKnownGood = false;

// Broader check driving the top banner: also treats the key as invalid once
// any account's refresh has actually hit a 401/403, since a dev key still
// starts with "RGAPI-" right up until (and after) it expires ~24h in — the
// string shape alone can't tell a live key from a dead one. Must NOT be used
// to gate whether refreshOne attempts a fetch: that stale _error can only be
// cleared by a fetch actually succeeding, so gating on it here would deadlock
// every account against ever retrying once one of them has expired once.
function keyLooksMissing() {
  if (keyFormatInvalid()) return true;
  if (keyKnownGood) return false;
  return accounts.some((a) => a._error === 'EXPIRED_KEY');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function matchesFilters(account) {
  if (filterType && account.label !== filterType) return false;
  if (filterRank) {
    const tier = (account.cache && account.cache.solo && account.cache.solo.tier) || 'UNRANKED';
    if (tier !== filterRank) return false;
  }
  if (!searchText) return true;
  const region = (regions[account.region] && regions[account.region].label) || account.region || '';
  const haystack = [
    account.label,
    account.riotId,
    account.email,
    account.loginUsername,
    account.notes,
    region,
  ].join(' ').toLowerCase();
  return haystack.includes(searchText);
}

function render() {
  keyWarningEl.classList.toggle('hidden', !keyLooksMissing());

  // Favorites float to the top; stable sort keeps everything else in its
  // existing (drag-ordered) relative position.
  const visible = accounts.filter(matchesFilters)
    .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

  cardsEl.innerHTML = '';
  emptyStateEl.classList.toggle('hidden', accounts.length !== 0);
  noMatchesEl.classList.toggle('hidden', accounts.length === 0 || visible.length !== 0);

  for (const account of visible) {
    cardsEl.appendChild(buildCard(account));
  }

  renderRosterDistribution();
  renderActiveAccount();
}

// Highest tier first, Unranked last — always reflects every tracked account,
// regardless of the current search/filter (an overview, not a filtered view).
const TIER_DISPLAY_ORDER = [
  'CHALLENGER', 'GRANDMASTER', 'MASTER', 'DIAMOND', 'EMERALD',
  'PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'IRON', 'UNRANKED',
];

function renderRosterDistribution() {
  const widget = el('rosterWidget');
  if (accounts.length === 0) {
    widget.classList.add('hidden');
    return;
  }
  widget.classList.remove('hidden');

  el('rosterTotal').textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;

  const counts = {};
  for (const account of accounts) {
    const tier = (account.cache && account.cache.solo && account.cache.solo.tier) || 'UNRANKED';
    counts[tier] = (counts[tier] || 0) + 1;
  }

  const chipsEl = el('rosterChips');
  chipsEl.innerHTML = '';
  for (const tier of TIER_DISPLAY_ORDER) {
    if (!counts[tier]) continue;
    const chip = document.createElement('span');
    chip.className = `roster-chip tier-${tier}`;
    chip.innerHTML = `<span class="tier">${counts[tier]}</span> ${titleCase(tier)}`;
    chipsEl.appendChild(chip);
  }
}

// Drop target is the whole card (not just the handle) so you can drop
// anywhere on the card you're dragging onto.
function wireCardDragAndDrop(card, accountId) {
  card.addEventListener('dragover', (e) => {
    if (!draggedAccountId || draggedAccountId === accountId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (!draggedAccountId || draggedAccountId === accountId) return;
    reorderAccounts(draggedAccountId, accountId);
  });
}

async function toggleFavorite(account) {
  account.favorite = !account.favorite;
  await window.api.updateAccount(account.id, { favorite: account.favorite });
  render();
}

async function reorderAccounts(draggedId, targetId) {
  const fromIdx = accounts.findIndex((a) => a.id === draggedId);
  if (fromIdx === -1) return;
  const [moved] = accounts.splice(fromIdx, 1);

  const toIdx = accounts.findIndex((a) => a.id === targetId);
  accounts.splice(toIdx === -1 ? fromIdx : toIdx, 0, moved);
  render();

  await window.api.reorderAccounts(accounts.map((a) => a.id));
}

function buildCard(account) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = account.id;
  wireCardDragAndDrop(card, account.id);

  const data = account.cache;

  // ---- Head: profile icon, label, IGN, actions ----
  const head = document.createElement('div');
  head.className = 'card-head';

  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '⠿';
  dragHandle.title = 'Drag to reorder';
  dragHandle.draggable = true;
  dragHandle.addEventListener('dragstart', (e) => {
    draggedAccountId = account.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', account.id);
  });
  dragHandle.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggedAccountId = null;
  });
  head.appendChild(dragHandle);

  const favBtn = document.createElement('button');
  favBtn.className = 'fav-btn';
  favBtn.textContent = account.favorite ? '⭐' : '☆';
  favBtn.title = account.favorite ? 'Unfavorite' : 'Favorite (pins to the top)';
  favBtn.addEventListener('click', () => toggleFavorite(account));
  head.appendChild(favBtn);

  if (account.favorite) card.classList.add('favorite');

  const icon = document.createElement('img');
  icon.className = 'profile-icon';
  icon.alt = '';
  if (data && data.profileIcon) icon.src = data.profileIcon;
  head.appendChild(icon);

  const identity = document.createElement('div');
  identity.className = 'card-identity';
  identity.innerHTML = `
    ${account.label ? `<span class="card-label">${escapeHtml(account.label)}</span><br>` : ''}
    <div class="card-ign" title="Click to copy Riot ID">${ignHtml(account, data)}</div>
    <div class="card-sub">${subLine(account, data)}</div>
    ${metaLine(account)}
  `;
  const ignEl = identity.querySelector('.card-ign');
  ignEl.addEventListener('click', () => copyRiotId(account, data, ignEl));
  head.appendChild(identity);

  const headActions = document.createElement('div');
  headActions.className = 'card-head-actions';
  const opggBtn = button('📊', 'btn btn-ghost btn-small', () => openOpgg(account, data));
  opggBtn.title = 'Open on op.gg';
  const signInBtn = button('🔑', 'btn btn-ghost btn-small', (e) => signInAccount(account.id, e.currentTarget));
  signInBtn.title = 'Copy login username & launch Riot Client';
  const refreshBtn = button('↻', 'btn btn-ghost btn-small', () => refreshOne(account.id));
  refreshBtn.title = 'Refresh this account';
  const editBtn = button('✎', 'btn btn-ghost btn-small', () => openAccountModal(account.id));
  editBtn.title = 'Edit';
  const delBtn = button('🗑', 'btn btn-danger btn-small', () => deleteAccount(account.id));
  delBtn.title = 'Delete';
  headActions.append(opggBtn, signInBtn);
  // Only shown once a password's actually saved for this account — nothing
  // to copy otherwise. Paste username (🔑 above), tab to the password
  // field, click this.
  if (account.hasPassword) {
    const pwBtn = button('🔒', 'btn btn-ghost btn-small', (e) => copyAccountPassword(account.id, e.currentTarget));
    pwBtn.title = 'Copy saved password';
    headActions.appendChild(pwBtn);
  }
  headActions.append(refreshBtn, editBtn, delBtn);
  head.appendChild(headActions);

  card.appendChild(head);

  // ---- Body: either error, loading, or the data ----
  // A missing/expired key already gets one unmissable banner at the top of
  // the app (#keyWarning) — repeating the same sentence on every single
  // card just to say the same thing N times adds noise, not information.
  // Every other error is still genuinely per-account, so those stay.
  const isKeyError = account._error === 'EXPIRED_KEY' || account._error === 'NO_KEY';
  if (account._error && !isKeyError) {
    const errEl = document.createElement('div');
    errEl.className = 'card-error';
    errEl.textContent = friendlyError(account._error);
    card.appendChild(errEl);
  } else if (account._loading && !data) {
    const l = document.createElement('div');
    l.className = 'card-loading';
    l.textContent = 'Loading…';
    card.appendChild(l);
  }

  if (data) {
    card.appendChild(buildRankRow(data, account));
    const goalBlock = buildGoalBlock(account);
    if (goalBlock) card.appendChild(goalBlock);
    const lpBlock = buildLastLpBlock(account);
    if (lpBlock) card.appendChild(lpBlock);
    card.appendChild(buildGames(data));
  }

  const invBlock = buildInventoryBlock(account);
  if (invBlock) card.appendChild(invBlock);

  // ---- Notes (always available) ----
  card.appendChild(buildNotes(account));

  return card;
}

function ignHtml(account, data) {
  if (data && data.ign) {
    return `${escapeHtml(data.gameName)}<span class="tag">#${escapeHtml(data.tagLine)}</span>`;
  }
  // Before first successful fetch, show what the user typed.
  const parts = (account.riotId || '').split('#');
  if (parts.length === 2) {
    return `${escapeHtml(parts[0])}<span class="tag">#${escapeHtml(parts[1])}</span>`;
  }
  return escapeHtml(account.riotId || 'Unknown');
}

// Prefers the normalized name/tag from the last successful fetch; falls back
// to whatever was typed in if the account hasn't been refreshed yet.
function resolveRiotId(account, data) {
  let gameName = data && data.gameName;
  let tagLine = data && data.tagLine;
  if (!gameName || !tagLine) {
    const parts = (account.riotId || '').split('#');
    if (parts.length === 2) [gameName, tagLine] = parts;
  }
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

// op.gg's region slugs match our own region keys (oce, na, euw, kr, ...).
function opggUrl(account, data) {
  const riotId = resolveRiotId(account, data);
  if (!riotId || !account.region) return null;
  return `https://www.op.gg/summoners/${account.region}/${encodeURIComponent(riotId.gameName)}-${encodeURIComponent(riotId.tagLine)}`;
}

function openOpgg(account, data) {
  const url = opggUrl(account, data);
  if (!url) {
    alert('Add a valid Riot ID (GameName#TAG) first.');
    return;
  }
  window.api.openExternal(url);
}

async function copyRiotId(account, data, el) {
  const riotId = resolveRiotId(account, data);
  if (!riotId) {
    alert('Add a valid Riot ID (GameName#TAG) first.');
    return;
  }
  await window.api.copyToClipboard(`${riotId.gameName}#${riotId.tagLine}`);
  if (el) {
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 800);
  }
}

function subLine(account, data) {
  const region = (regions[account.region] && regions[account.region].label) || account.region;
  if (data && data.summonerLevel) {
    return `Level ${data.summonerLevel} · ${region}`;
  }
  return region;
}

function metaLine(account) {
  const parts = [];
  if (account.loginUsername) parts.push(`Login: ${escapeHtml(account.loginUsername)}`);
  if (account.email) parts.push(`Email: ${escapeHtml(account.email)}`);
  if (!parts.length) return '';
  return `<div class="card-meta">${parts.join(' · ')}</div>`;
}

function buildRankRow(data, account) {
  const row = document.createElement('div');
  row.className = 'rank-row';
  row.appendChild(rankBadge('Solo/Duo', data.solo));
  row.appendChild(rankBadge('Flex', data.flex));
  row.appendChild(soloTodayBadge(account));
  return row;
}

// Combines two different data sources into one "Solo Today" block: the W/L
// count is rebuilt from real match history (see ensureTodayMatches) and is
// always a complete picture of the day, while the Net LP line is a running
// total of only the games this app was actually open to capture live (see
// lib/lpLog.js) — so it can undercount on a day the app wasn't running the
// whole time. Shown together since they're both "how'd today go," but kept
// visually distinct (LP as a smaller sub-line) so that difference in
// completeness doesn't get lost.
function soloTodayBadge(account) {
  const badge = document.createElement('div');
  badge.className = 'rank-badge wl-badge';
  badge.innerHTML = `
    <span class="queue">Solo Today</span>
    ${formatSoloWinLossToday(account.sessionLP)}
    ${formatNetLpToday(account.netLpToday)}
  `;
  badge.title = 'W/L is every ranked Solo/Duo game played today. Net LP only counts games this app was open to see start-to-finish on this PC.';
  return badge;
}

function formatSoloWinLossToday(sessionLP) {
  if (!sessionLP || sessionLP.soloWins == null || sessionLP.soloLosses == null) {
    return '<span class="wl-big">&nbsp;</span>';
  }
  if (sessionLP.soloWins === 0 && sessionLP.soloLosses === 0) {
    return '<span class="wl-big wl-empty">No games today</span>';
  }
  return `<span class="wl-big"><span class="w">${sessionLP.soloWins}W</span> <span class="l">${sessionLP.soloLosses}L</span></span>`;
}

function formatNetLpToday(net) {
  const notes = [];
  if (net && net.promotions) notes.push(`${net.promotions} promo`);
  if (net && net.demotions) notes.push(`${net.demotions} demo`);
  if (net && net.remakes) notes.push(`${net.remakes} remake`);

  if (!net || (net.gamesCounted === 0 && notes.length === 0)) {
    return '<span class="lp-sub lp-empty">No LP tracked</span>';
  }

  const sign = net.total > 0 ? '+' : '';
  const cls = net.total > 0 ? 'gain' : net.total < 0 ? 'drop' : '';
  return `<span class="lp-sub ${cls}">${sign}${net.total} LP${notes.length ? ' · ' + notes.join(', ') : ''}</span>`;
}

function buildGoalBlock(account) {
  if (!account.goal) return null;
  const progress = account.goalProgress || { percent: 0, reached: false };
  const label = `${titleCase(account.goal.tier)}${account.goal.rank ? ' ' + account.goal.rank : ''}`;

  const block = document.createElement('div');
  block.className = `goal-block${progress.reached ? ' reached' : ''}`;
  block.title = 'Progress measured from your rank when the goal was set, not from before — a freshly-set goal always starts at 0%.';
  block.innerHTML = `
    <div class="goal-label">
      <span class="goal-name">🎯 Goal: ${escapeHtml(label)}</span>
      <span class="goal-status">${progress.reached ? 'Reached!' : `${progress.percent}%`}</span>
    </div>
    <div class="goal-bar"><div class="goal-bar-fill" style="width:${progress.percent}%"></div></div>
  `;
  return block;
}

// Real per-game LP change for this account's most recent ranked Solo/Duo
// game, sourced from the LCU (see computeRankedLpDelta in
// lib/leagueClientApi.js) — only populated while this PC was signed into
// this account for that game's EndOfGame transition, so most cards won't
// have one.
function buildLastLpBlock(account) {
  const delta = account.lastLpDelta;
  if (!delta) return null;

  const block = document.createElement('div');
  let text;
  let cls = 'last-lp';
  if (delta.remake) {
    text = 'Last game: remake, no LP change';
  } else if (delta.promoted) {
    text = `Last game: Promoted to ${titleCase(delta.post.tier)} ${delta.post.division}!`;
    cls += ' win';
  } else if (delta.demoted) {
    text = `Last game: Demoted to ${titleCase(delta.post.tier)} ${delta.post.division}`;
    cls += ' loss';
  } else {
    const sign = delta.lpChange > 0 ? '+' : '';
    text = `Last game: ${sign}${delta.lpChange} LP`;
    cls += delta.lpChange > 0 ? ' win' : delta.lpChange < 0 ? ' loss' : '';
  }
  block.className = cls;
  block.textContent = `${text} · ${timeAgo(delta.capturedAt)}`;
  return block;
}

function inventoryCount(inv) {
  return {
    be: inv && inv.blueEssence,
    rp: inv && inv.riotPoints,
    champs: inv && inv.championsOwned,
    champsTotal: inv && inv.championsTotal,
    skins: inv && inv.ownedSkins ? inv.ownedSkins.length : 0,
  };
}

function sameInventory(a, b) {
  if (!a || !b) return a === b;
  return JSON.stringify(inventoryCount(a)) === JSON.stringify(inventoryCount(b));
}

function invItem(tag, value, tagClass) {
  const span = document.createElement('span');
  span.className = 'inv-item';
  span.innerHTML = `<span class="inv-tag${tagClass ? ' ' + tagClass : ''}">${tag}</span>${escapeHtml(String(value))}`;
  return span;
}

// Blue Essence, Riot Points, champions owned, and skins owned. Riot's public
// API exposes none of this — it can only be read from the League Client, and
// only for whichever account is signed in on this PC. It's captured while that
// account is active and persisted onto the card, so the last-known values keep
// showing after the client closes (the tooltip says how long ago). The Champs
// and Skins chips open a searchable picture grid of what the account owns.
function buildInventoryBlock(account) {
  const inv = account.inventory;

  const block = document.createElement('div');
  block.className = 'inventory-row';

  if (inv) {
    if (inv.blueEssence != null) block.appendChild(invItem('BE', inv.blueEssence.toLocaleString(), 'be'));
    if (inv.riotPoints != null) block.appendChild(invItem('RP', inv.riotPoints.toLocaleString(), 'rp'));

    if (inv.championsOwned != null) {
      const total = inv.championsTotal ? `/${inv.championsTotal}` : '';
      const item = invItem('Champs', `${inv.championsOwned}${total}`);
      if (inv.ownedChampionIds && inv.ownedChampionIds.length) {
        item.classList.add('inv-clickable');
        item.title = 'Show owned champions';
        item.addEventListener('click', () => openCollectionModal(account, 'champions'));
      }
      block.appendChild(item);
    }

    if (inv.ownedSkins && inv.ownedSkins.length) {
      const item = invItem('Skins', inv.ownedSkins.length);
      item.classList.add('inv-clickable');
      item.title = 'Show owned skins';
      item.addEventListener('click', () => openCollectionModal(account, 'skins'));
      block.appendChild(item);
    }
  }

  // Nothing captured yet (or only a partial capture) — tell the user this one
  // still needs a one-time sign-in on this PC. Champs is the gate: it's the
  // slowest LCU endpoint to warm up and the one people care about here.
  const needsCapture = !inv || inv.championsOwned == null || !(inv.ownedChampionIds && inv.ownedChampionIds.length);
  if (needsCapture) {
    const hint = document.createElement('span');
    hint.className = 'inv-item inv-uncaptured';
    hint.textContent = '◌ Sign in on this PC to capture champs / skins / BE';
    block.appendChild(hint);
  }

  block.title = inv
    ? `Read from the League Client while signed in to this account · updated ${timeAgo(inv.fetchedAt)}`
    : 'Sign into this account in the League Client on this PC and it fills in automatically';
  return block;
}

async function loadChampionCatalog() {
  try {
    const cat = await window.api.getChampionCatalog();
    if (cat && Array.isArray(cat.champions)) {
      ddragonVersion = cat.version || '';
      championById = new Map(cat.champions.map((c) => [c.id, c]));
    }
  } catch (e) {
    // Offline / Data Dragon down — the collection modal will fall back to
    // showing IDs without pictures.
  }
}

function champSquareUrl(key) {
  if (!ddragonVersion || !key) return null;
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png`;
}

// Loading-screen art per skin — path is keyed by the champion's Data Dragon key
// and the skin number (skinId % 1000), with no version in the URL.
function skinArtUrl(key, skinNum) {
  if (!key) return null;
  return `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${key}_${skinNum}.jpg`;
}

function collectionItemsFor(account, kind) {
  const inv = account.inventory || {};
  if (kind === 'champions') {
    return (inv.ownedChampionIds || []).map((id) => {
      const c = championById.get(id);
      return { name: c ? c.name : `Champion ${id}`, sub: '', img: c ? champSquareUrl(c.key) : null };
    });
  }
  return (inv.ownedSkins || []).map((s) => {
    const championId = s.championId != null ? s.championId : Math.floor(s.id / 1000);
    const skinNum = s.id % 1000;
    const c = championById.get(championId);
    return {
      name: s.name || (c ? `${c.name} skin` : `Skin ${s.id}`),
      sub: c ? c.name : '',
      img: c ? skinArtUrl(c.key, skinNum) : null,
    };
  });
}

function openCollectionModal(account, kind) {
  const ign = (account.cache && account.cache.ign) || account.riotId || account.label || 'account';
  const items = collectionItemsFor(account, kind)
    .sort((a, b) => (a.sub || a.name).localeCompare(b.sub || b.name) || a.name.localeCompare(b.name));

  collectionState = { kind, ign, items };
  el('collectionModalTitle').textContent =
    `Showing owned ${kind === 'champions' ? 'champs' : 'skins'} for: ${ign}`;
  el('collectionSearch').value = '';
  el('collectionSearch').placeholder = kind === 'champions' ? 'Search champions…' : 'Search skins…';
  renderCollectionGrid('');
  el('collectionModal').classList.remove('hidden');
  el('collectionSearch').focus();
}

function renderCollectionGrid(query) {
  if (!collectionState) return;
  const grid = el('collectionGrid');
  grid.innerHTML = '';
  const q = query.trim().toLowerCase();
  const filtered = collectionState.items.filter(
    (it) => !q || it.name.toLowerCase().includes(q) || (it.sub && it.sub.toLowerCase().includes(q))
  );

  el('collectionCount').textContent =
    `${filtered.length}${q ? ` of ${collectionState.items.length}` : ''}`;

  if (!filtered.length) {
    grid.innerHTML = '<div class="collection-empty">No matches.</div>';
    return;
  }

  for (const it of filtered) {
    const cell = document.createElement('div');
    cell.className = `collection-item${collectionState.kind === 'skins' ? ' skin' : ''}`;
    if (it.img) {
      const img = document.createElement('img');
      img.src = it.img;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      cell.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'collection-name';
    name.textContent = it.name;
    cell.appendChild(name);
    grid.appendChild(cell);
  }
}

function closeCollectionModal() {
  el('collectionModal').classList.add('hidden');
  collectionState = null;
}

function rankBadge(queueLabel, rank) {
  const badge = document.createElement('div');
  const tier = rank ? rank.tier : 'UNRANKED';
  badge.className = `rank-badge tier-${tier}`;
  if (rank) {
    const total = rank.wins + rank.losses;
    const wr = total ? Math.round((rank.wins / total) * 100) : 0;
    badge.innerHTML = `
      <span class="queue">${queueLabel}</span>
      <span class="tier">${titleCase(rank.tier)} ${rank.rank} · ${rank.lp} LP</span>
      <span class="wl">${rank.wins}W ${rank.losses}L · ${wr}% WR</span>
    `;
  } else {
    badge.innerHTML = `
      <span class="queue">${queueLabel}</span>
      <span class="tier">Unranked</span>
      <span class="wl">&nbsp;</span>
    `;
  }
  return badge;
}

// Riot queue IDs -> human-readable names. This list isn't fetched by queue at
// all (it's just the 5 most recent matches, any queue), so games here can
// easily include Flex/ARAM/Normals that don't count toward Solo W/L Today.
const RANKED_SOLO_QUEUE_ID = 420;
const QUEUE_NAMES = {
  420: 'Ranked Solo/Duo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  700: 'Clash',
  900: 'URF',
  1700: 'Arena',
};

function buildGames(data) {
  const block = document.createElement('div');
  block.className = 'games-block';
  block.innerHTML = `
    <div class="section-title">Last 5 games</div>
    <div class="games-hint">Any queue — only Ranked Solo/Duo counts toward Solo W/L Today, and remakes never count.</div>
  `;

  if (!data.games || data.games.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'games-empty';
    empty.textContent = 'No recent games found.';
    block.appendChild(empty);
    return block;
  }

  const row = document.createElement('div');
  row.className = 'games-row';
  for (const g of data.games) {
    const isSolo = g.queueId === RANKED_SOLO_QUEUE_ID;
    const queueLabel = QUEUE_NAMES[g.queueId] || 'Other queue';
    const resultLabel = g.remake ? 'Remake' : g.win ? 'Win' : 'Loss';

    const cell = document.createElement('div');
    cell.className = g.remake ? 'game remake' : `game ${g.win ? 'win' : 'loss'}${isSolo ? '' : ' other-queue'}`;
    cell.title = `${g.championName} · ${queueLabel} · ${resultLabel}${g.remake ? ' (excluded from ranked W/L)' : ''} · ${g.kills}/${g.deaths}/${g.assists}`;

    const img = document.createElement('img');
    img.src = g.championIcon;
    img.alt = g.championName;
    cell.appendChild(img);

    if (g.remake) {
      const badge = document.createElement('div');
      badge.className = 'queue-badge';
      badge.textContent = 'RMK';
      cell.appendChild(badge);
    } else if (!isSolo) {
      const badge = document.createElement('div');
      badge.className = 'queue-badge';
      badge.textContent = queueLabel === 'Other queue' ? '?' : queueLabel.replace('Ranked ', '').slice(0, 4);
      cell.appendChild(badge);
    }
    const kda = document.createElement('div');
    kda.className = 'kda';
    kda.textContent = `${g.kills}/${g.deaths}/${g.assists}`;
    cell.appendChild(kda);
    row.appendChild(cell);
  }
  block.appendChild(row);
  return block;
}

function buildNotes(account) {
  const block = document.createElement('div');
  block.className = 'notes-block';
  block.innerHTML = `<div class="section-title">Notes</div>`;

  const textarea = document.createElement('textarea');
  textarea.value = account.notes || '';
  textarea.placeholder = 'Add notes about this account…';
  block.appendChild(textarea);

  const row = document.createElement('div');
  row.className = 'notes-row';
  const saved = document.createElement('span');
  saved.className = 'notes-saved';
  saved.textContent = '✓ Saved';
  const saveBtn = button('Save notes', 'btn btn-ghost btn-small', async () => {
    account.notes = textarea.value;
    await window.api.updateAccount(account.id, { notes: textarea.value });
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 1500);
  });
  row.append(saved, saveBtn);
  block.appendChild(row);
  return block;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function refreshOne(id) {
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  if (keyFormatInvalid()) {
    account._error = 'EXPIRED_KEY';
    render();
    return;
  }
  account._loading = true;
  account._error = null;
  render();

  const result = await window.api.fetchAccountData(id);
  account._loading = false;
  if (result.ok) {
    account.cache = result.data;
    account.sessionLP = result.sessionLP;
    account.goalProgress = result.goalProgress;
    account._error = null;
    // A success is proof the key is live — this alone drops the banner (see
    // keyLooksMissing), so stale per-account "expired" errors elsewhere no
    // longer need clearing.
    keyKnownGood = true;
  } else {
    account._error = result.error;
    if (result.error === 'EXPIRED_KEY' || result.error === 'NO_KEY') keyKnownGood = false;
  }
  render();

  // The ↻ button should also pull this account's BE / champs / skins if it's
  // the one signed in on this PC — that data comes from the League Client, not
  // the Riot API, so the normal fetch above never touches it. Not awaited: it
  // can chain several slow LCU probes and refreshOne has nothing to do with
  // the result (the inventory-mirror in refreshActiveAccount re-renders).
  if (activeAccountStatus && activeAccountStatus.matchedAccountId === id) {
    refreshActiveAccount(true);
  }
}

// Guards against two refreshAll() runs overlapping (e.g. the on-launch
// refresh still working through accounts when the user hits "Refresh all" or
// Ctrl+R) — without this, both loops fetch the same accounts concurrently,
// which doubles up on the rate limit and races on saving accounts.json,
// where whichever IPC call finishes last silently wins over the other.
let refreshAllInProgress = false;
// Set when refreshAll() is asked to run while one's already going. Rather than
// silently dropping that request (which is how pasting a fresh key mid-refresh
// used to leave every already-processed card stuck on its stale EXPIRED_KEY
// error until the user manually hit "Refresh all" again), the in-flight loop
// picks this up and does one more full pass — this time with the new key.
let refreshAllQueued = false;

async function refreshAll() {
  if (refreshAllInProgress) {
    refreshAllQueued = true;
    return;
  }
  refreshAllInProgress = true;
  try {
    do {
      refreshAllQueued = false;
      render(); // show cached data immediately
      for (const account of accounts) {
        // Sequential to stay comfortably under the dev-key rate limit.
        await refreshOne(account.id);
      }
      // One check for the whole batch (not per-account) — picks up any account
      // that's newly known to the widget without hammering the rate limit.
      mastery = await window.api.syncMastery();
      renderMastery();
    } while (refreshAllQueued);
  } finally {
    refreshAllInProgress = false;
  }
}

async function signInAccount(id, btn) {
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  if (!account.loginUsername) {
    alert('Add a Riot Account ID (login username) under ✎ Edit first — that\'s what gets copied for sign-in.');
    return;
  }

  await window.api.copyToClipboard(account.loginUsername);
  const result = await window.api.launchRiotClient();

  if (btn) {
    const original = btn.textContent;
    btn.textContent = result.ok ? '✓' : '⚠';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }

  if (!result.ok) {
    alert(
      result.error === 'CLIENT_NOT_FOUND'
        ? 'Username copied to clipboard, but the Riot Client wasn\'t found automatically. Open it yourself and paste your username.'
        : `Username copied to clipboard, but launching the Riot Client failed: ${result.error}`
    );
  }
}

// Decryption and the clipboard write both happen in the main process (see
// accounts:copyPassword) — the plaintext password is never sent down to
// this renderer at all, it just lands directly on the OS clipboard for a
// manual paste into the Riot Client's password field.
async function copyAccountPassword(id, btn) {
  const result = await window.api.copyAccountPassword(id);

  if (btn) {
    const original = btn.textContent;
    btn.textContent = result.ok ? '✓' : '⚠';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }

  if (!result.ok && result.error !== 'NO_PASSWORD') {
    alert(`Couldn't copy the saved password: ${result.error}`);
  }
}

function renderMastery() {
  const widget = el('masteryWidget');
  // Keep the widget (and its ↻ button) visible whenever there's an account to
  // compute it for — hiding it entirely whenever data's missing would strand
  // anyone whose last refresh attempt failed, with no way to retry.
  if (accounts.length === 0) {
    widget.classList.add('hidden');
    return;
  }
  widget.classList.remove('hidden');

  const chipsEl = el('masteryChips');
  chipsEl.innerHTML = '';

  const hasData = mastery && mastery.topChampions && mastery.topChampions.length > 0;
  if (hasData) {
    for (const champ of mastery.topChampions) {
      const chip = document.createElement('span');
      chip.className = 'mastery-chip';
      chip.textContent = `${champ.championName}: ${champ.total.toLocaleString()}`;
      chipsEl.appendChild(chip);
    }
    el('masteryUpdated').textContent = `Updated ${timeAgo(mastery.fetchedAt)}`;
  } else {
    const chip = document.createElement('span');
    chip.className = 'mastery-chip';
    chip.textContent = 'Not calculated yet — click ↻';
    chipsEl.appendChild(chip);
    el('masteryUpdated').textContent = '';
  }
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(diff / (60 * 1000));
  return `${Math.max(mins, 0)}m ago`;
}

// Who's currently signed in to the Riot/League Client on this PC — local
// machine state Riot's web API can't see, so this only works while that
// client is actually running here (see lib/leagueClientApi.js).
let activeRefreshRunning = false;
let activeRefreshForcePending = false;

async function refreshActiveAccount(forceInventory) {
  // The 15s interval, the post-game scheduler, and the ↻ button can all call
  // this at once; a forced call can chain ~7 LCU probes (3s timeout each) on a
  // client that never exposes inventory, so overlapping runs would pile up and
  // race each other's gameflow-phase read. One at a time; a force that arrives
  // mid-run is re-run once the current one finishes.
  if (activeRefreshRunning) {
    if (forceInventory) activeRefreshForcePending = true;
    return;
  }
  activeRefreshRunning = true;
  try {
    await runActiveAccountRefresh(forceInventory);
  } finally {
    activeRefreshRunning = false;
  }
  if (activeRefreshForcePending) {
    activeRefreshForcePending = false;
    refreshActiveAccount(true);
  }
}

async function runActiveAccountRefresh(forceInventory) {
  try {
    activeAccountStatus = await window.api.getActiveAccountStatus(
      forceInventory ? { forceInventory: true } : undefined
    );
  } catch (e) {
    activeAccountStatus = { signedIn: false };
  }
  renderActiveAccount();

  // BE / RP / champions-owned for the signed-in account — the main process has
  // already persisted this onto the matched card; mirror it onto our in-memory
  // copy so it shows right away without a full account reload.
  if (activeAccountStatus.inventory && activeAccountStatus.matchedAccountId) {
    const matched = accounts.find((a) => a.id === activeAccountStatus.matchedAccountId);
    if (matched && !sameInventory(matched.inventory, activeAccountStatus.inventory)) {
      matched.inventory = activeAccountStatus.inventory;
      // Skip the re-render if someone's mid-edit in a notes box (a full render
      // rebuilds every card and would drop their unsaved text) — the new
      // numbers land on the next render regardless.
      if (!(document.activeElement && document.activeElement.tagName === 'TEXTAREA')) render();
    }
  }

  // Only the account that was actually just playing — never every card, and
  // never some other tracked account that happens to share the PC.
  if (activeAccountStatus.gameJustEnded && activeAccountStatus.matchedAccountId) {
    schedulePostGameRefresh(activeAccountStatus.matchedAccountId);
  }

  // Real per-game LP change for a ranked Solo/Duo game that just ended (see
  // computeRankedLpDelta in lib/leagueClientApi.js) — the main process has
  // already persisted it onto the matched account, so pull a fresh copy of
  // the accounts list to pick that up and show it on the card, in addition
  // to the transient flash below.
  if (activeAccountStatus.lpDelta) {
    flashActiveAccountNote(formatLpDeltaFlash(activeAccountStatus.lpDelta));
    if (activeAccountStatus.matchedAccountId) {
      accounts = await window.api.getAccounts();
      render();
    }
  }
}

function formatLpDeltaFlash(delta) {
  if (delta.remake) return 'Remake — no LP change';
  if (delta.promoted) return `Promoted! ${titleCase(delta.post.tier)} ${delta.post.division}`;
  if (delta.demoted) return `Demoted to ${titleCase(delta.post.tier)} ${delta.post.division}`;
  const sign = delta.lpChange > 0 ? '+' : '';
  return `${sign}${delta.lpChange} LP`;
}

function flashActiveAccountNote(text) {
  const nameEl = el('activeAccountName');
  const original = nameEl.textContent;
  nameEl.textContent = `${text}`;
  setTimeout(() => { nameEl.textContent = original; }, 8000);
}

// Riot's match API needs a little time to process a game that just ended —
// refreshing the instant the client reports "game over" often still misses
// it, so this waits before pulling the card's data.
const POST_GAME_REFRESH_DELAY_MS = 15000;
let scheduledPostGameRefreshFor = null;

function schedulePostGameRefresh(accountId) {
  if (scheduledPostGameRefreshFor === accountId) return; // already queued for this game
  scheduledPostGameRefreshFor = accountId;
  setTimeout(() => {
    scheduledPostGameRefreshFor = null;
    refreshOne(accountId);
  }, POST_GAME_REFRESH_DELAY_MS);
}

function renderActiveAccount() {
  const widget = el('activeAccountWidget');
  if (accounts.length === 0) {
    widget.classList.add('hidden');
    return;
  }
  widget.classList.remove('hidden');

  const icon = el('activeAccountIcon');
  const nameEl = el('activeAccountName');
  const status = activeAccountStatus;

  if (!status || !status.signedIn) {
    widget.classList.add('offline');
    widget.classList.remove('clickable');
    icon.classList.add('hidden');
    nameEl.textContent = 'Not signed in on this PC';
    widget.onclick = null;
    el('activeAccountSignOutBtn').classList.add('hidden');
    return;
  }

  widget.classList.remove('offline');
  icon.classList.toggle('hidden', !status.profileIcon);
  if (status.profileIcon) icon.src = status.profileIcon;
  el('activeAccountSignOutBtn').classList.remove('hidden');

  nameEl.textContent = status.matchedLabel ? `${status.ign} — ${status.matchedLabel}` : `${status.ign} (not tracked)`;

  if (status.matchedAccountId) {
    widget.classList.add('clickable');
    widget.onclick = () => jumpToCard(status.matchedAccountId);
  } else {
    widget.classList.remove('clickable');
    widget.onclick = null;
  }
}

function jumpToCard(accountId) {
  const card = cardsEl.querySelector(`[data-id="${accountId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('jump-highlight');
  setTimeout(() => card.classList.remove('jump-highlight'), 1500);
}

// Ends the current sign-in session via the Riot Client's own local API (see
// riotclient:signOut / endRiotClientSession in lib/riotClient.js) — a real
// logout, not a process close standing in for one. Verified live: the
// running client reacts on its own and drops straight to its login screen,
// no relaunch needed.
async function signOutActiveAccount(e) {
  e.stopPropagation(); // the widget itself is also a click target (jumps to card)

  const ign = activeAccountStatus && activeAccountStatus.ign;
  const confirmed = confirm(
    `Sign out${ign ? ` of ${ign}` : ''}? If you're currently in champion select or a match, ` +
    'this will disconnect you and may count as leaving.'
  );
  if (!confirmed) return;

  const btn = el('activeAccountSignOutBtn');
  btn.disabled = true;
  const original = btn.textContent;
  // Worst case (League still closing + a few sign-out retries) can run a
  // good few seconds — spell it out rather than leaving a bare "…" up long
  // enough to look stuck.
  btn.textContent = 'Signing out…';

  const result = await window.api.signOutRiotClient();
  if (!result.ok) alert(`Couldn't sign out: ${result.error}`);

  // Give the client a moment to actually react to the session ending
  // before polling status — the normal 15s interval would eventually catch
  // it too, but this feels instant instead of leaving a stale "signed in"
  // state up for a while.
  setTimeout(async () => {
    await refreshActiveAccount();
    btn.disabled = false;
    btn.textContent = original;
  }, 2000);
}

async function refreshMastery() {
  const btn = el('masteryRefreshBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '…';
  mastery = await window.api.refreshMastery();
  renderMastery();
  btn.textContent = original;
  btn.disabled = false;
}

async function exportBackup() {
  const result = await window.api.exportBackup();
  if (result.ok) {
    alert(`Backup saved to ${result.filePath}`);
  } else if (result.error !== 'CANCELED') {
    alert(`Backup failed: ${result.error}`);
  }
}

async function importBackup() {
  if (!confirm('Restoring will replace all current accounts with the ones in the backup file. Continue?')) return;
  const result = await window.api.importBackup();
  if (result.ok) {
    accounts = await window.api.getAccounts();
    closeSettings();
    render();
    refreshAll();
    alert(`Restored ${result.count} account(s).`);
  } else if (result.error !== 'CANCELED') {
    alert(`Restore failed: ${result.error}`);
  }
}

const UNDO_WINDOW_MS = 8000;
let pendingUndo = null; // { account, index, timeoutId }

async function deleteAccount(id) {
  const index = accounts.findIndex((a) => a.id === id);
  if (index === -1) return;
  const account = accounts[index];

  // Only one undo slot — a prior pending delete just becomes permanent.
  if (pendingUndo) clearTimeout(pendingUndo.timeoutId);

  accounts = await window.api.deleteAccount(id);
  render();

  const timeoutId = setTimeout(() => {
    pendingUndo = null;
    el('undoToast').classList.add('hidden');
  }, UNDO_WINDOW_MS);
  pendingUndo = { account, index, timeoutId };

  const name = account.label || account.riotId || 'Account';
  el('undoToastText').textContent = `${name} deleted.`;
  el('undoToast').classList.remove('hidden');
}

async function undoDelete() {
  if (!pendingUndo) return;
  clearTimeout(pendingUndo.timeoutId);
  const { account, index } = pendingUndo;
  pendingUndo = null;
  el('undoToast').classList.add('hidden');

  accounts = await window.api.restoreAccount(account, index);
  render();
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function openAccountModal(id) {
  editingId = id || null;
  const isEdit = Boolean(id);
  el('accountModalTitle').textContent = isEdit ? 'Edit account' : 'Add account';

  // The password field always opens blank, whether adding or editing — a
  // saved password is never decrypted just to redisplay it. Leaving it
  // blank on save means "keep whatever's already saved"; the "remove saved
  // password" checkbox is the only way to clear one, and only makes sense
  // (and only shows) when editing an account that actually has one.
  el('fieldPassword').value = '';
  el('fieldRemovePassword').checked = false;

  if (isEdit) {
    const a = accounts.find((x) => x.id === id);
    el('fieldLabel').value = a.label || 'Smurf';
    el('fieldRiotId').value = a.riotId || '';
    el('fieldRegion').value = a.region || settings.defaultRegion;
    el('fieldEmail').value = a.email || '';
    el('fieldLoginUsername').value = a.loginUsername || '';
    el('fieldGoalTier').value = (a.goal && a.goal.tier) || '';
    el('fieldGoalDivision').value = (a.goal && a.goal.rank) || 'IV';
    el('fieldNotes').value = a.notes || '';
    el('fieldRemovePasswordRow').classList.toggle('hidden', !a.hasPassword);
  } else {
    el('fieldLabel').value = 'Smurf';
    el('fieldRiotId').value = '';
    el('fieldRegion').value = settings.defaultRegion || 'oce';
    el('fieldEmail').value = '';
    el('fieldLoginUsername').value = '';
    el('fieldGoalTier').value = '';
    el('fieldGoalDivision').value = 'IV';
    el('fieldNotes').value = '';
    el('fieldRemovePasswordRow').classList.add('hidden');
  }
  updateGoalDivisionField();
  el('accountModal').classList.remove('hidden');
  el('fieldLabel').focus();
}

const APEX_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

function updateGoalDivisionField() {
  const tier = el('fieldGoalTier').value;
  el('fieldGoalDivision').disabled = !tier || APEX_TIERS.includes(tier);
}

function closeAccountModal() {
  el('accountModal').classList.add('hidden');
  el('fieldPassword').value = '';
  editingId = null;
}

function findDuplicateAccount(riotId, excludeId) {
  const normalized = riotId.trim().toLowerCase();
  return accounts.find((a) => a.id !== excludeId && (a.riotId || '').trim().toLowerCase() === normalized);
}

async function saveAccountModal() {
  const label = el('fieldLabel').value.trim() || 'Smurf';
  const riotId = el('fieldRiotId').value.trim();
  const region = el('fieldRegion').value;
  const email = el('fieldEmail').value.trim();
  const loginUsername = el('fieldLoginUsername').value.trim();
  const password = el('fieldPassword').value;
  const removePassword = el('fieldRemovePassword').checked;
  const goalTier = el('fieldGoalTier').value;
  const goalDivision = el('fieldGoalDivision').value;
  const notes = el('fieldNotes').value;

  if (!riotId.includes('#')) {
    alert('Riot ID must be in the form GameName#TAG (e.g. Faker#KR1).');
    return;
  }

  const dup = findDuplicateAccount(riotId, editingId);
  if (dup) {
    const dupLabel = dup.label || 'an existing account';
    if (!confirm(`"${riotId}" is already tracked (labeled "${dupLabel}"). Add it again anyway?`)) return;
  }

  let targetId = editingId;
  if (editingId) {
    await window.api.updateAccount(editingId, { label, riotId, region, email, loginUsername, notes });
  } else {
    accounts = await window.api.addAccount({ label, riotId, region, email, loginUsername, notes });
    targetId = accounts[accounts.length - 1].id;
  }

  // A typed password always wins over the checkbox — blank means "leave
  // whatever's saved alone", so setAccountPassword only needs to run when
  // there's actually a change to make.
  if (password || removePassword) {
    const pwResult = await window.api.setAccountPassword(targetId, password);
    if (!pwResult.ok) {
      alert(`Everything else saved, but the password didn't: ${pwResult.error}`);
    }
  }

  if (goalTier) {
    await window.api.setAccountGoal(targetId, goalTier, goalDivision);
  } else {
    await window.api.clearAccountGoal(targetId);
  }
  accounts = await window.api.getAccounts();

  closeAccountModal();
  render();
  refreshOne(targetId);
}

function openSettings() {
  el('fieldApiKey').value = settings.apiKey || '';
  el('fieldDefaultRegion').value = settings.defaultRegion || 'oce';
  el('fieldLaunchOnStartup').checked = !!settings.launchOnStartup;
  el('fieldAutoUpdate').checked = settings.autoUpdateCheck !== false;
  el('settingsVersion').textContent = appVersion ? `Version ${appVersion} · ` : '';
  el('updateCheckResult').textContent = '';
  el('settingsModal').classList.remove('hidden');
  el('fieldApiKey').focus();
}

function closeSettings() {
  el('settingsModal').classList.add('hidden');
}

async function saveSettings() {
  const apiKey = el('fieldApiKey').value.trim();
  const defaultRegion = el('fieldDefaultRegion').value;
  const launchOnStartup = el('fieldLaunchOnStartup').checked;
  const autoUpdateCheck = el('fieldAutoUpdate').checked;
  const keyChanged = apiKey !== (settings.apiKey || '');
  settings = await window.api.saveSettings({ apiKey, defaultRegion, launchOnStartup, autoUpdateCheck });
  closeSettings();

  if (keyChanged && apiKey) {
    // A brand-new key: drop every stale "key expired" error left over from the
    // old one straight away so the banner and cards stop claiming the key is
    // dead the moment a fresh one goes in, then confirm the new key really
    // works with one cheap test call before kicking off the full refresh.
    keyKnownGood = false;
    for (const account of accounts) {
      if (account._error === 'EXPIRED_KEY' || account._error === 'NO_KEY') account._error = null;
    }
    render();

    const check = await window.api.validateApiKey();
    if (check.ok) {
      keyKnownGood = true;
    } else if (check.error === 'EXPIRED_KEY' || check.error === 'NO_KEY') {
      // The replacement key is itself missing/expired — say so now instead of
      // letting the user watch every card fail one by one.
      for (const account of accounts) account._error = check.error;
      render();
      return;
    }
  }

  render();
  refreshAll();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function button(text, className, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function titleCase(s) {
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

function friendlyError(code) {
  switch (code) {
    case 'EXPIRED_KEY':
    case 'NO_KEY':
      return 'API key missing or expired — open Settings and paste a fresh key.';
    case 'NOT_FOUND':
      return 'Account not found. Check the Riot ID and region.';
    case 'BAD_RIOT_ID':
      return 'Riot ID must look like GameName#TAG.';
    case 'RATE_LIMITED':
      return 'Rate limited by Riot. Wait a moment and refresh again.';
    default:
      return code || 'Something went wrong.';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  el('addBtn').addEventListener('click', () => openAccountModal(null));
  el('addFirstBtn').addEventListener('click', () => openAccountModal(null));
  el('refreshAllBtn').addEventListener('click', refreshAll);
  el('settingsBtn').addEventListener('click', openSettings);
  el('activeAccountSignOutBtn').addEventListener('click', signOutActiveAccount);
  el('densityToggleBtn').addEventListener('click', toggleDensity);

  el('accountCancelBtn').addEventListener('click', closeAccountModal);
  el('accountSaveBtn').addEventListener('click', saveAccountModal);
  el('fieldGoalTier').addEventListener('change', updateGoalDivisionField);
  el('settingsCancelBtn').addEventListener('click', closeSettings);
  el('settingsSaveBtn').addEventListener('click', saveSettings);

  el('openSettingsFromWarning').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  el('devPortalLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://developer.riotgames.com/');
  });

  el('checkUpdateLink').addEventListener('click', async (e) => {
    e.preventDefault();
    el('updateCheckResult').textContent = ' checking…';
    const state = await window.api.checkForUpdate();
    // The real outcome arrives via the pushed update:status event; this is just
    // immediate acknowledgement plus the "you're on the latest" / dev-build case.
    if (state.status === 'idle') el('updateCheckResult').textContent = " you're up to date";
    else if (state.status === 'error') el('updateCheckResult').textContent = ' check failed';
    else el('updateCheckResult').textContent = '';
  });

  el('searchInput').addEventListener('input', (e) => {
    searchText = e.target.value.trim().toLowerCase();
    render();
  });
  el('filterType').addEventListener('change', (e) => {
    filterType = e.target.value;
    render();
  });
  el('filterRank').addEventListener('change', (e) => {
    filterRank = e.target.value;
    render();
  });

  el('masteryRefreshBtn').addEventListener('click', refreshMastery);
  el('exportBackupBtn').addEventListener('click', exportBackup);
  el('importBackupBtn').addEventListener('click', importBackup);
  el('openAutoBackupBtn').addEventListener('click', () => window.api.openAutoBackupFolder());
  el('undoToastBtn').addEventListener('click', undoDelete);

  el('collectionCloseBtn').addEventListener('click', closeCollectionModal);
  el('collectionSearch').addEventListener('input', (e) => renderCollectionGrid(e.target.value));

  el('updateRestartBtn').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Restarting…';
    await window.api.installUpdate();
  });

  // Close modals on overlay click / Escape.
  for (const overlay of document.querySelectorAll('.modal-overlay')) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.add('hidden'));
      return;
    }

    if (!(e.ctrlKey || e.metaKey)) return;
    // Don't hijack these while a modal's open — the user's likely mid-form.
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

    const key = e.key.toLowerCase();
    if (key === 'f') {
      e.preventDefault();
      el('searchInput').focus();
      el('searchInput').select();
    } else if (key === 'n') {
      e.preventDefault();
      openAccountModal(null);
    } else if (key === 'r') {
      e.preventDefault();
      refreshAll();
    }
  });
}

init();
