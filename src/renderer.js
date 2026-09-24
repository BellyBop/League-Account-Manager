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
let sortBy = ''; // '' = manual/drag order; see compareBySort below
let draggedAccountId = null;
let activeAccountStatus = null;
let appVersion = '';

// Data Dragon champion list (numeric id -> { key, name }), for labelling an
// account's owned-champion / owned-skin ID lists. Pictures come from Community
// Dragon by numeric id and don't need this.
let championById = new Map();
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
  applyZoomLevel(settings.zoomLevel || 0);
  render();
  renderMastery();

  // A key already sitting in settings from a previous launch never goes
  // through saveSettings()'s validate-and-clear-the-banner step — without
  // this, the banner would wait on a full account refresh (slow, and can
  // fail for reasons unrelated to the key) before confirming a key that's
  // actually fine. One cheap call up front settles it immediately. Not
  // awaited so it doesn't delay showing cached cards.
  if (!keyFormatInvalid()) {
    window.api.validateApiKey().then((check) => {
      if (check.ok) {
        keyKnownGood = true;
        render();
      }
    });
  }

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

// ---------------------------------------------------------------------------
// Zoom (Ctrl +/-/0, Ctrl+scroll) — matches the browser convention users
// already know. webFrame's zoom is per-renderer-frame and applies instantly;
// the level is persisted to settings so it's remembered next launch, but that
// write is debounced since a scroll-to-zoom gesture can fire many wheel
// events in a row and there's no need to hit disk for every single one.
// ---------------------------------------------------------------------------
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -6;
const ZOOM_MAX = 8;
const ZOOM_SAVE_DEBOUNCE_MS = 500;
let zoomSaveTimer = null;

function applyZoomLevel(level) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  window.api.setZoomLevel(clamped);

  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(async () => {
    settings = await window.api.saveSettings({ zoomLevel: clamped });
  }, ZOOM_SAVE_DEBOUNCE_MS);

  return clamped;
}

function adjustZoom(delta) {
  applyZoomLevel(window.api.getZoomLevel() + delta);
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

// Same tier/division ladder as lib/rank.js's rankValue (duplicated here
// rather than IPC'd over — it's small, pure, and only ever needed
// client-side for sorting the already-loaded card list).
const RANK_SORT_TIER_ORDER = [
  'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD',
  'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER',
];
const RANK_SORT_DIVISION_ORDER = { IV: 0, III: 1, II: 2, I: 3 };

// Unranked (or a still-loading account with no cache yet) sorts as lower
// than Iron IV, so "Rank: High to Low" doesn't scatter them through the
// middle of the list.
function rankSortValue(account) {
  const solo = account.cache && account.cache.solo;
  if (!solo) return -1;
  const tierIdx = RANK_SORT_TIER_ORDER.indexOf(solo.tier);
  if (tierIdx === -1) return -1;
  if (tierIdx >= RANK_SORT_TIER_ORDER.indexOf('MASTER')) return tierIdx * 400 + solo.lp;
  return tierIdx * 400 + (RANK_SORT_DIVISION_ORDER[solo.rank] || 0) * 100 + solo.lp;
}

function compareBySort(a, b) {
  switch (sortBy) {
    case 'rank-desc': return rankSortValue(b) - rankSortValue(a);
    case 'rank-asc': return rankSortValue(a) - rankSortValue(b);
    case 'label-asc': return (a.label || '').localeCompare(b.label || '');
    case 'label-desc': return (b.label || '').localeCompare(a.label || '');
    default: return 0; // manual order — stable sort leaves drag-order untouched
  }
}

function render() {
  const missing = keyLooksMissing();
  keyWarningEl.classList.toggle('hidden', !missing);

  // Favorites always float to the top regardless of sort mode; within each
  // of those two groups, the chosen sort applies (or, in manual mode, the
  // stable sort just preserves existing drag order).
  const visible = accounts.filter(matchesFilters)
    .sort((a, b) => {
      const favDiff = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      return favDiff !== 0 ? favDiff : compareBySort(a, b);
    });

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

  // Dragging only makes sense in manual order — with a rank/label sort
  // active, render() would just re-sort the drop right back where it was,
  // which looks like the drag silently failed rather than explaining why.
  const manualOrder = sortBy === '';
  const dragHandle = document.createElement('span');
  dragHandle.className = manualOrder ? 'drag-handle' : 'drag-handle drag-handle-disabled';
  dragHandle.textContent = '⠿';
  dragHandle.title = manualOrder ? 'Drag to reorder' : 'Switch to "Manual order" to drag-reorder';
  dragHandle.draggable = manualOrder;
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
  const progress = account.goalProgress || { lpToGo: null, reached: false };
  const label = `${titleCase(account.goal.tier)}${account.goal.rank ? ' ' + account.goal.rank : ''}`;

  let status;
  if (progress.reached) {
    status = 'Reached!';
  } else if (progress.lpToGo != null) {
    status = `${progress.lpToGo.toLocaleString()} LP to go`;
  } else {
    status = 'Unranked';
  }

  const block = document.createElement('div');
  block.className = `goal-block${progress.reached ? ' reached' : ''}`;
  block.title = 'How much LP stands between your current rank and this goal (~100 LP per division) — recalculated fresh from your current rank every refresh, not from wherever you were when you set it.';
  block.innerHTML = `
    <div class="goal-label">
      <span class="goal-name">🎯 Goal: ${escapeHtml(label)}</span>
      <span class="goal-status">${status}</span>
    </div>
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
  const hasChamps = inv && inv.championsOwned != null && inv.ownedChampionIds && inv.ownedChampionIds.length;
  if (!hasChamps) {
    const hint = document.createElement('span');
    hint.className = 'inv-item inv-uncaptured';
    hint.textContent = '◌ Sign in on this PC to capture champs / skins / BE';
    block.appendChild(hint);
  } else if (inv.blueEssence == null && activeAccountStatus && activeAccountStatus.matchedAccountId === account.id) {
    // Champs are in but the wallet hasn't come up yet — it lags the champion
    // list by a poll or three after signing in. Don't move on to the next
    // account just yet.
    const hint = document.createElement('span');
    hint.className = 'inv-item inv-uncaptured';
    hint.textContent = '◌ reading BE / RP…';
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
    if (cat && Array.isArray(cat.champions) && cat.champions.length) {
      championById = new Map(cat.champions.map((c) => [c.id, c]));
    }
  } catch (e) {
    // Offline / Data Dragon down — the modal still shows pictures (Community
    // Dragon, by id) and skin names (from the client), just not champion names.
  }
}

// Images come from Community Dragon, which is keyed by numeric champion ID —
// no dependency on the Data Dragon catalog loading or its per-champion "key"
// string, so pictures still work even when champion *names* don't.
function champSquareUrl(championId) {
  return `https://cdn.communitydragon.org/latest/champion/${championId}/square`;
}

function skinArtUrl(championId, skinNum) {
  return `https://cdn.communitydragon.org/latest/champion/${championId}/tile/skin/${skinNum}`;
}

function championName(id) {
  const c = championById.get(id);
  return c ? c.name : null;
}

function collectionItemsFor(account, kind) {
  const inv = account.inventory || {};
  if (kind === 'champions') {
    return (inv.ownedChampionIds || []).map((id) => ({
      name: championName(id) || `Champion ${id}`,
      sub: '',
      img: champSquareUrl(id),
    }));
  }
  return (inv.ownedSkins || [])
    .map((s) => {
      const championId = s.championId != null ? s.championId : Math.floor(s.id / 1000);
      const skinNum = s.id % 1000;
      const champ = championName(championId);
      return {
        name: s.name || (champ ? `${champ} skin` : `Skin ${s.id}`),
        sub: champ || '',
        img: championId > 0 && championId < 3000 ? skinArtUrl(championId, skinNum) : null,
      };
    });
}

async function openCollectionModal(account, kind) {
  if (!championById.size) await loadChampionCatalog(); // retry if the launch load failed
  const ign = (account.cache && account.cache.ign) || account.riotId || account.label || 'account';
  const items = collectionItemsFor(account, kind)
    .sort((a, b) => (a.sub || a.name).localeCompare(b.sub || b.name) || a.name.localeCompare(b.name));

  collectionState = { kind, ign, items };
  el('collectionModalTitle').textContent =
    `Showing owned ${kind === 'champions' ? 'champs' : 'skins'} for: ${ign}`;
  el('collectionSearch').value = '';
  el('collectionSearch').placeholder = kind === 'champions' ? 'Search champions…' : 'Search skins…';
  // Reveal the modal BEFORE building the grid so lazy-loaded images have a real
  // viewport to intersect — images rendered into a display:none container never
  // start loading, which is why the grid was showing as text only.
  el('collectionModal').classList.remove('hidden');
  renderCollectionGrid('');
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
      img.alt = '';
      img.loading = 'lazy';
      // Hide the cell's image slot if the art 404s (a brand-new skin CDragon
      // hasn't picked up, or an odd non-champion entry) rather than leaving a
      // broken-image box.
      img.addEventListener('error', () => { img.remove(); cell.classList.add('no-art'); });
      img.src = it.img;
      cell.appendChild(img);
    } else {
      cell.classList.add('no-art');
    }
    const name = document.createElement('span');
    name.className = 'collection-name';
    name.textContent = it.name;
    cell.appendChild(name);
    if (it.sub && collectionState.kind === 'skins' && it.sub !== it.name) {
      const sub = document.createElement('span');
      sub.className = 'collection-sub';
      sub.textContent = it.sub;
      cell.appendChild(sub);
    }
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
    account.netLpToday = result.netLpToday;
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
      // Mastery data computed before this feature existed won't have
      // championIcon yet (it'll show up once the weekly/manual refresh
      // recomputes it) — falls back to the text-only chip rather than an
      // empty gap where the picture would be.
      if (champ.championIcon) {
        const img = document.createElement('img');
        img.className = 'mastery-chip-icon';
        img.src = champ.championIcon;
        img.alt = '';
        // A renamed/retired champion key 404ing shouldn't leave a broken-image
        // glyph sitting in the chip — just drop back to text-only for that one.
        img.addEventListener('error', () => img.remove(), { once: true });
        chip.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = `${champ.championName}: ${champ.total.toLocaleString()}`;
      chip.appendChild(label);
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

// Always states the password situation explicitly, in every branch — the bug
// this is guarding against is someone assuming passwords are in a backup
// (because the feature exists and looks configured) when they actually
// aren't, with nothing ever having said so out loud.
async function exportBackup() {
  const result = await window.api.exportBackup();
  if (!result.ok) {
    if (result.error !== 'CANCELED') alert(`Backup failed: ${result.error}`);
    return;
  }
  if (result.passphraseUnavailable) {
    alert(`Backup saved to ${result.filePath}.\n\nPasswords NOT included — this device has no backup passphrase cached. Set one in Settings to include passwords again.`);
  } else if (result.passwordsIncluded) {
    alert(`Backup saved to ${result.filePath}.\n\nPasswords included.`);
  } else {
    alert(`Backup saved to ${result.filePath}.\n\nPasswords NOT included — turn on "include saved passwords" under Local backups in Settings if you want them backed up too.`);
  }
}

async function importBackup() {
  if (!(await confirmModal('Restoring will replace all current accounts with the ones in the backup file (Undo last restore in Settings can put this back afterward). Continue?'))) return;

  // Asked up front, before the file is even picked — same reasoning as
  // cloudRestore(): whether THIS device has a passphrase saved doesn't tell
  // us whether the FILE has passwords in it.
  const passphrase = await promptPassphrase({
    mode: 'restore',
    title: 'Restore from backup',
    hint: "If the backup includes encrypted passwords and you'd like them restored too, enter the backup passphrase. Leave this blank to restore everything else and skip passwords.",
  });
  if (passphrase === null) return;

  const result = await window.api.importBackup(passphrase || null);
  if (!result.ok) {
    const messages = {
      BAD_PASSPHRASE: 'Wrong passphrase — nothing was restored, try again.',
      SNAPSHOT_FAILED: "Restore cancelled: couldn't safely save a copy of your current accounts first, so nothing was touched. Try again, or check disk space/permissions.",
    };
    if (result.error !== 'CANCELED') alert(messages[result.error] || `Restore failed: ${result.error}`);
    return;
  }

  accounts = await window.api.getAccounts();
  closeSettings();
  render();
  refreshAll();

  let message = `Restored ${result.count} account(s).`;
  if (result.passwordsAvailable && !result.passwordsRestored) {
    message += ' Passwords were in this backup but were not restored (skipped, or wrong passphrase).';
  } else if (result.passwordsRestored) {
    message += ' Passwords were restored too.';
  }
  alert(message);
}

// Reverts to the exact snapshot taken automatically right before the most
// recent restore (local or cloud — see snapshotBeforeRestore in
// lib/backup.js). Single-level, same as the delete-account undo toast: doing
// this doesn't itself create a further undo point.
async function handleUndoLastRestore() {
  if (!(await confirmModal('Undo the most recent restore and put your accounts back to exactly how they were right before it?'))) return;
  const result = await window.api.undoLastRestore();
  if (!result.ok) {
    alert(result.error === 'NO_SNAPSHOT' ? "There's no restore to undo yet." : `Undo failed: ${result.error}`);
    return;
  }
  accounts = await window.api.getAccounts();
  render();
  refreshAll();
  alert('Restored to how things were right before your last restore.');
}

// ---------------------------------------------------------------------------
// Cloud backup — see lib/cloudBackup.js for the main-process side. The
// passphrase modal (#passphraseModal) is shared between "set a new
// passphrase" (needs a confirm field, rejects anything short) and "type the
// passphrase to restore" (single field, blank is a valid "skip passwords"
// answer — only the Cancel button aborts outright).
// ---------------------------------------------------------------------------
// In-page replacement for window.confirm() — see the HTML comment on
// #confirmModal for why this exists instead of just using the native one.
function confirmModal(message, { title = 'Are you sure?', confirmLabel = 'Continue' } = {}) {
  return new Promise((resolve) => {
    const overlay = el('confirmModal');
    el('confirmModalTitle').textContent = title;
    el('confirmModalMessage').textContent = message;
    el('confirmModalOkBtn').textContent = confirmLabel;
    overlay.classList.remove('hidden');

    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown, true);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    // Dismissing any other way (clicking the backdrop, pressing Escape) has
    // to resolve the promise too — the generic "hide every .modal-overlay on
    // Escape/backdrop-click" handler in wireEvents() only hides the element,
    // it doesn't know a promise is waiting on this one, so without this the
    // caller's `await confirmModal(...)` would just hang forever and the
    // button that triggered it would look permanently broken.
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }
    function onKeydown(e) { if (e.key === 'Escape') onCancel(); }
    const okBtn = el('confirmModalOkBtn');
    const cancelBtn = el('confirmModalCancelBtn');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    // Capture phase, ahead of the generic handler, purely so cleanup() can
    // remove this one specifically without disturbing that one.
    document.addEventListener('keydown', onKeydown, true);
  });
}

function promptPassphrase({ mode, title, hint }) {
  return new Promise((resolve) => {
    const overlay = el('passphraseModal');
    el('passphraseModalTitle').textContent = title;
    el('passphraseModalHint').textContent = hint || '';
    el('passphraseModalError').textContent = '';
    el('fieldPassphrase').value = '';
    el('fieldPassphraseConfirm').value = '';
    el('passphraseConfirmRow').classList.toggle('hidden', mode !== 'set');
    el('passphraseOkBtn').textContent = mode === 'set' ? 'Save passphrase' : 'Continue';
    overlay.classList.remove('hidden');
    // Deferred rather than called immediately — belt-and-suspenders against
    // the same class of Windows/Electron focus quirk that #confirmModal's
    // comment explains (a modal opened the instant a previous one closes can
    // visually look focused while not actually accepting keystrokes for a
    // beat). Every caller of this modal now opens it from a plain in-page
    // action rather than a native dialog, so this is a safety margin, not a
    // fix for an active bug — but it costs nothing to keep.
    setTimeout(() => {
      window.focus();
      el('fieldPassphrase').focus();
    }, 50);

    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown, true);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onOk() {
      const value = el('fieldPassphrase').value;
      if (mode === 'set') {
        if (value.length < 8) {
          el('passphraseModalError').textContent = 'Use at least 8 characters.';
          return;
        }
        if (value !== el('fieldPassphraseConfirm').value) {
          el('passphraseModalError').textContent = "Passphrases don't match.";
          return;
        }
      }
      cleanup();
      resolve(value);
    }
    // Same reasoning as #confirmModal's onOverlayClick/onKeydown — without
    // these, dismissing via backdrop-click or Escape leaves this promise
    // (and whatever restore/passphrase-setting flow is awaiting it) hung.
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }
    function onKeydown(e) { if (e.key === 'Escape') onCancel(); }
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown, true);
    const okBtn = el('passphraseOkBtn');
    const cancelBtn = el('passphraseCancelBtn');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Shared by local and cloud backups (lib/backup.js) — the button/hint live
// once, in the Data section, rather than duplicated under each backup type.
function updateBackupPassphraseUI() {
  const hasPassphrase = !!settings.backupPassphraseSet;
  el('setBackupPassphraseBtn').textContent = hasPassphrase ? '🔑 Change passphrase' : '🔑 Set passphrase';
  el('clearBackupPassphraseBtn').classList.toggle('hidden', !hasPassphrase);
  updateBackupStatusHints();
}

// A plain, impossible-to-miss statement of whether passwords are actually
// going into each kind of backup right now — not something you have to run
// a backup and read a popup to find out. Deliberately styled the same
// (hint-warn) whether "off" is an intentional choice or a passphrase that
// hasn't been set yet: either way, the honest answer right now is "no
// passwords in these backups", and that should never be ambiguous.
function updateBackupStatusHints() {
  const hasPassphrase = !!settings.backupPassphraseSet;

  // The ✓/⚠ icon and its color come from CSS (.hint-ok/.hint-warn ::before),
  // not baked into this text, so it renders as a proper icon+banner rather
  // than an emoji character sitting inline in gray hint text.
  const local = el('localBackupStatusHint');
  const localOn = settings.localBackupIncludePasswords && hasPassphrase;
  local.textContent = localOn ? 'Local backups currently include passwords.' : 'Local backups do NOT currently include passwords.';
  local.classList.toggle('hint-ok', localOn);
  local.classList.toggle('hint-warn', !localOn);

  const cloud = el('cloudBackupStatusHint');
  const cloudOn = settings.cloudBackupIncludePasswords && hasPassphrase;
  cloud.textContent = cloudOn ? 'Cloud backups currently include passwords.' : 'Cloud backups do NOT currently include passwords.';
  cloud.classList.toggle('hint-ok', cloudOn);
  cloud.classList.toggle('hint-warn', !cloudOn);
}

async function setBackupPassphrase() {
  const value = await promptPassphrase({
    mode: 'set',
    title: settings.backupPassphraseSet ? 'Change backup passphrase' : 'Set a backup passphrase',
    hint: 'This encrypts passwords inside local and cloud backups alike. It is never stored anywhere but here in your head (or a real password manager) — losing it means losing the passwords in every backup made with it, old and new.',
  });
  if (value === null) return;

  const result = await window.api.setBackupPassphrase(value);
  if (result.ok) {
    settings = { ...settings, backupPassphraseSet: true };
    updateBackupPassphraseUI();
  } else {
    alert(`Couldn't set passphrase: ${result.error}`);
  }
}

async function clearBackupPassphrase() {
  if (!(await confirmModal('Remove the saved backup passphrase? Local and cloud backups will both stop including passwords until you set a new one.'))) return;
  await window.api.clearBackupPassphrase();
  settings = { ...settings, backupPassphraseSet: false, localBackupIncludePasswords: false, cloudBackupIncludePasswords: false };
  el('fieldLocalIncludePasswords').checked = false;
  el('fieldCloudIncludePasswords').checked = false;
  updateBackupPassphraseUI();
}

function updateCloudBackupUI() {
  const folder = settings.cloudBackupFolder;
  el('cloudFolderHint').textContent = folder ? `Backing up to: ${folder}` : 'No folder chosen yet.';

  el('cloudLastBackupHint').textContent = settings.cloudBackupEnabled
    ? `Last cloud backup: ${timeAgo(settings.lastCloudBackupAt)}`
    : 'Cloud backup is off.';
}

async function chooseCloudFolder() {
  const result = await window.api.chooseCloudBackupFolder();
  if (result.ok) {
    settings = { ...settings, cloudBackupFolder: result.folder };
    updateCloudBackupUI();
  } else if (result.error !== 'CANCELED') {
    alert(`Couldn't set that folder: ${result.error}`);
  }
}

// Same shape as chooseCloudFolder — an empty localBackupFolder just means
// "the built-in auto-backups folder", so there's nothing to show/choose
// differently here besides which path that resolves to.
function updateLocalFolderUI() {
  el('localFolderHint').textContent = settings.localBackupFolder
    ? `Backing up to: ${settings.localBackupFolder}`
    : 'Backing up to the built-in folder.';
}

async function chooseLocalFolder() {
  const result = await window.api.chooseAutoBackupFolder();
  if (result.ok) {
    settings = { ...settings, localBackupFolder: result.folder };
    updateLocalFolderUI();
  } else if (result.error !== 'CANCELED') {
    alert(`Couldn't set that folder: ${result.error}`);
  }
}

async function cloudBackupNow() {
  const result = await window.api.runCloudBackupNow();
  if (!result.ok) {
    const messages = { NO_FOLDER: 'Choose a backup folder first.', FOLDER_UNAVAILABLE: "That folder isn't reachable right now (unplugged drive, sync client not running?)." };
    alert(messages[result.error] || `Backup failed: ${result.error}`);
    return;
  }
  settings = { ...settings, lastCloudBackupAt: Date.now() };
  updateCloudBackupUI();
  if (result.passphraseUnavailable) {
    alert('Backed up, but passwords NOT included — this device has no backup passphrase cached. Set one in Settings to include passwords again.');
  } else if (result.passwordsIncluded) {
    alert(`Backed up to ${result.filePath}.\n\nPasswords included.`);
  } else {
    alert(`Backed up to ${result.filePath}.\n\nPasswords NOT included — turn on "include saved passwords" under Cloud backup in Settings if you want them backed up too.`);
  }
}

async function cloudRestore() {
  if (!(await confirmModal('Restoring will replace all current accounts with the ones in the chosen backup (Undo last restore in Settings can put this back afterward). Continue?'))) return;

  // Asked up front, before the file is even picked, rather than gated on
  // whether THIS device currently has a passphrase saved — the whole point
  // of restoring is often a fresh machine that has never had one.
  const passphrase = await promptPassphrase({
    mode: 'restore',
    title: 'Restore from cloud backup',
    hint: "If the backup includes encrypted passwords and you'd like them restored too, enter the passphrase it was made with. Leave this blank to restore everything else and skip passwords.",
  });
  if (passphrase === null) return;

  const result = await window.api.restoreCloudBackup(passphrase || null);
  if (!result.ok) {
    const messages = {
      BAD_FILE: "That doesn't look like a cloud backup file.",
      BAD_PASSPHRASE: 'Wrong passphrase — nothing was restored, try again.',
      SNAPSHOT_FAILED: "Restore cancelled: couldn't safely save a copy of your current accounts first, so nothing was touched. Try again, or check disk space/permissions.",
    };
    if (result.error !== 'CANCELED') alert(messages[result.error] || `Restore failed: ${result.error}`);
    return;
  }

  accounts = await window.api.getAccounts();
  closeSettings();
  render();
  refreshAll();

  let message = `Restored ${result.count} account(s).`;
  if (result.passwordsAvailable && !result.passwordsRestored) {
    message += ' Passwords were in this backup but were not restored (skipped, or wrong passphrase).';
  } else if (result.passwordsRestored) {
    message += ' Passwords were restored too.';
  }
  alert(message);
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
  el('fieldLocalIncludePasswords').checked = !!settings.localBackupIncludePasswords;
  el('fieldCloudBackupEnabled').checked = !!settings.cloudBackupEnabled;
  el('fieldCloudIncludePasswords').checked = !!settings.cloudBackupIncludePasswords;
  updateBackupPassphraseUI();
  updateLocalFolderUI();
  updateCloudBackupUI();
  el('settingsVersion').textContent = appVersion ? `Version ${appVersion} · ` : '';
  el('updateCheckResult').textContent = '';
  el('settingsModal').classList.remove('hidden');
  el('fieldApiKey').focus();
}

function closeSettings() {
  el('settingsModal').classList.add('hidden');
}

// Cloud backup's enable toggle and "include passwords" toggle persist the
// instant they're changed, same as the folder picker and passphrase buttons
// next to them — NOT deferred to the modal's Save button like apiKey/region
// below. They used to be deferred, which meant clicking "Back up now" (a
// separate, immediate action) right after ticking one of these but before
// hitting Save would silently run against whatever was still on disk — e.g.
// "include passwords" reads as off, no error, no warning, just a backup that
// quietly has no passwords in it. Immediate persistence makes every control
// in this section behave the same way: what you see checked is what's saved.
async function toggleCloudBackupEnabled(checked) {
  if (checked && !settings.cloudBackupFolder) {
    alert('Choose a cloud backup folder first.');
    el('fieldCloudBackupEnabled').checked = false;
    return;
  }
  settings = await window.api.saveSettings({ cloudBackupEnabled: checked });
  updateCloudBackupUI();
}

// Local and cloud "include passwords" toggles both gate on the same shared
// passphrase (see updateBackupPassphraseUI) — ticking either one prompts to
// set it if it isn't already, same immediate-persist reasoning as above.
async function toggleLocalIncludePasswords(checked) {
  if (checked && !settings.backupPassphraseSet) {
    await setBackupPassphrase();
    if (!settings.backupPassphraseSet) {
      el('fieldLocalIncludePasswords').checked = false;
      return;
    }
  }
  settings = await window.api.saveSettings({ localBackupIncludePasswords: checked });
  updateBackupStatusHints();
}

async function toggleCloudIncludePasswords(checked) {
  if (checked && !settings.backupPassphraseSet) {
    await setBackupPassphrase();
    if (!settings.backupPassphraseSet) {
      el('fieldCloudIncludePasswords').checked = false;
      return; // passphrase setup was cancelled/failed — leave the setting off
    }
  }
  settings = await window.api.saveSettings({ cloudBackupIncludePasswords: checked });
  updateCloudBackupUI();
  updateBackupStatusHints();
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
    // dead the moment a fresh one goes in.
    keyKnownGood = false;
    for (const account of accounts) {
      if (account._error === 'EXPIRED_KEY' || account._error === 'NO_KEY') account._error = null;
    }
    render();

    // Best-effort fast path only: confirm a good key quickly so the banner
    // can drop before any per-account refresh even starts. A negative result
    // here is NOT proof the key is dead — confirmed live that Riot's edge can
    // flat-out 401 a freshly (re)issued key for a stretch and then accept the
    // exact same key moments later with nothing else changed — so this must
    // never short-circuit the real refresh below. refreshAll()'s actual
    // per-account fetches are the source of truth and will set keyKnownGood
    // themselves the moment one succeeds; this just tries to beat them to it.
    const check = await window.api.validateApiKey();
    if (check.ok) keyKnownGood = true;
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
      // A malformed cached puuid causes this (Riot 400s "Exception decrypting
      // <puuid>" on every by-puuid call) — the app already re-resolves and
      // retries once automatically (see fetchAccountData in riot.js), so this
      // only ever reaches the UI if that retry also failed.
      if (code && /exception decrypting/i.test(code)) {
        return 'Riot API hiccup resolving this account — wait a moment and refresh again.';
      }
      return code || 'Something went wrong.';
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
// Generic "ⓘ" reveal — toggles the hidden hint text named in
// data-info-target, rather than the Settings screen showing every
// explanation up front whether or not anyone wants to read it right now.
function wireInfoButtons() {
  document.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(btn.dataset.infoTarget);
      if (target) target.classList.toggle('hidden');
    });
  });
}

function wireEvents() {
  wireInfoButtons();
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
    el('searchClearBtn').classList.toggle('hidden', !e.target.value);
    render();
  });
  el('searchClearBtn').addEventListener('click', () => {
    el('searchInput').value = '';
    searchText = '';
    el('searchClearBtn').classList.add('hidden');
    el('searchInput').focus();
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
  el('sortBy').addEventListener('change', (e) => {
    sortBy = e.target.value;
    render();
  });

  el('masteryRefreshBtn').addEventListener('click', refreshMastery);
  el('exportBackupBtn').addEventListener('click', exportBackup);
  el('importBackupBtn').addEventListener('click', importBackup);
  el('openAutoBackupBtn').addEventListener('click', async () => {
    const result = await window.api.openAutoBackupFolder();
    if (!result.ok) alert("That folder isn't reachable right now (unplugged drive, permissions?).");
  });
  el('chooseAutoFolderBtn').addEventListener('click', chooseLocalFolder);
  el('undoLastRestoreBtn').addEventListener('click', handleUndoLastRestore);
  el('fieldLocalIncludePasswords').addEventListener('change', (e) => toggleLocalIncludePasswords(e.target.checked));
  el('setBackupPassphraseBtn').addEventListener('click', setBackupPassphrase);
  el('clearBackupPassphraseBtn').addEventListener('click', clearBackupPassphrase);
  el('fieldCloudBackupEnabled').addEventListener('change', (e) => toggleCloudBackupEnabled(e.target.checked));
  el('fieldCloudIncludePasswords').addEventListener('change', (e) => toggleCloudIncludePasswords(e.target.checked));
  el('chooseCloudFolderBtn').addEventListener('click', chooseCloudFolder);
  el('openCloudFolderBtn').addEventListener('click', async () => {
    const result = await window.api.openCloudBackupFolder();
    if (result.ok) return;
    alert(result.error === 'NO_FOLDER'
      ? 'Choose a cloud backup folder first.'
      : "That folder isn't reachable right now (unplugged drive, permissions?).");
  });
  el('cloudBackupNowBtn').addEventListener('click', cloudBackupNow);
  el('cloudRestoreBtn').addEventListener('click', cloudRestore);
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

    // Zoom: fine while a modal's open (unlike the shortcuts below) since it
    // can't collide with typing in a form field.
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      adjustZoom(ZOOM_STEP);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      adjustZoom(-ZOOM_STEP);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      applyZoomLevel(0);
      return;
    }

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

  // Ctrl+scroll to zoom — same convention as browsers. { passive: false } is
  // required so preventDefault() can actually stop the page from scrolling
  // while zooming.
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, { passive: false });
}

init();
