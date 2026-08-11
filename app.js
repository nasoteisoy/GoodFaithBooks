/* Good Faith Books — static build, talks straight to Firebase Realtime Database.
 *
 * No SDK, no registered web app — just fetch()/EventSource against the REST
 * API, plus the Firebase Auth REST API for anonymous sign-in. The apiKey
 * used here is Firebase's public "Web API Key": it identifies the project,
 * not a secret, and is meant to ship in client code — unlike an Admin SDK
 * service-account key, which must never appear here or anywhere in this repo.
 *
 * WHERE SECURITY LIVES: in the database rules, not in this file. Every write
 * is validated AND, as of the ownership fix, authorized server-side against
 * the signed-in anonymous user's auth.uid — not against a self-reported name
 * a client could fake by copying public data. A friend using curl only gets
 * as far as their own auth.uid lets them, same as this page.
 *
 * Rule carried over from the server build: every piece of user text reaches
 * the page through textContent. There is no innerHTML in this file.
 */
'use strict';

/* window.BOOKCLUB_DB lets automated tests point the page at a local mock instead
   of the real shelf. Set only by a test-only script file; in production nothing
   defines it and the constant below is used. Exists because UI tests were
   seeding and deleting records in the live database, which is a bad habit that
   eventually deletes something real. */
const DB = window.BOOKCLUB_DB
        || 'https://chummy-games-12a1d-default-rtdb.firebaseio.com';
const BOOKS = `${DB}/bookclub/books`;

// Firebase's public Web API Key (Firebase Console -> Project Settings ->
// General -> Web API Key). Safe to ship client-side: by itself it only
// identifies the project to the Auth REST API, it grants nothing. Fill in
// before deploying — until then, sign-in fails gracefully (see initAuth)
// and the shelf stays read-only.
const WEB_API_KEY = window.BOOKCLUB_API_KEY || 'AIzaSyCU-pGbrjIxzcGBjCGfX8_W-dMcqfbswRU';
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN = 'https://securetoken.googleapis.com/v1';

/* ?admin in the URL reveals the delete button in the UI — deliberately not
   discoverable any other way (no header toggle, no on-page hint). The only
   people who know it exists are the ones told directly. By deliberate
   choice there is no allowlist behind it: the database rules allow anyone
   signed in to delete any book, same as edit — this community is small
   and trusted enough that the tradeoff was "no ID management" over
   "restricted to specific people." */
const ADMIN_UI = new URLSearchParams(location.search).has('admin');

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
  return n;
}

const state = {
  books: [],
  q: '', sort: 'rating',
  bookType: new Set(), faith: new Set(), categories: new Set(), format: new Set(), series: new Set(),
  person: new Set(), status: new Set(),
  open: new Set(), expanded: new Set(),
  editingId: null, // set while the add/suggest form is actually editing an existing owned book
};

// RTDB returns a dense array as-is but a sparse one as an object — accept both.
const asList = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);

// The fixed category taxonomy from the recommendation form. "Other" is a
// free-text field alongside these, not part of this list.
const CATEGORIES = [
  '🙏 Prayer & Spiritual Life', '❤️ Saints & Biographies', '🌸 Marian Devotion',
  '🕊️ Sacraments', '💧 Baptism', '✝️ Confession', '🔥 Confirmation',
  '💒 Mass and Eucharist', '🙇‍♂️ Ordination/Priesthood', '💍 Marriage',
  '👨‍👩‍👧 Parenting & Family', '😇 Virtues & Character', "👩 Women's Spirituality",
  "👨 Men's Spirituality", '📖 Scripture', '⛪ Church History',
  '✝️ Catholic Basics / OCIA (RCIA)', '🛡️ Apologetics', '🎓 Philosophy',
  '📜 Theology', '🌎 Social Teaching', '⚔️ Spiritual Warfare',
  '🗓 Liturgical', '📅 Advent', '✝️ Lent', '🎄 Christmas', '⛪️ Easter',
  '📚 Fiction', '📚 Non Fiction', '👩‍💻 Technology Usage', '🤪 Emotional Regulation',
  '😰😔 Anxiety/Depression', '😔 Grief and Loss', '🧎‍♀️ Theology of the Body/Body Boundaries',
  '🤰🤱👩‍🍼 Pregnancy/Postpartum', '🥑🏃‍♀️ Nutrition and Fitness', '🧏‍♀️ Motherhood',
  '🏫 Schooling/Teaching', '🪧 Bilingual', '💐 Romance', '🕰 Historical Fiction',
  '🦄 Fantasy', '❓️ Mystery', '💁‍♀️ Contemporary', '🎩 Classic',
];
const categoriesOf = (b) => asList(b.categories);
// {url, desc} pairs; falls back to the old single-string `link` field for
// books created before multi-link support existed.
const linksOf = (b) => asList(b.links).length ? asList(b.links) : (b.link ? [{ url: b.link, desc: '' }] : []);

// A clickable tag: applies this value as a filter and jumps to Browse with
// it applied. `cls` is the full class string (caller controls styling, e.g.
// "tag cat" vs "series-tag") so this can stand in for any tag anywhere —
// the compact card and the detail page both use this for every taggable
// field (faith, book type, category, format, series), per the user's ask
// that this behavior be consistent everywhere, not just on series.
function seriesLabel(b) {
  return `📚 ${b.series}${b.seriesNumber ? ' #' + b.seriesNumber : ''}`;
}

function filterTag(cls, text, filterSet, value) {
  const t = el('button', cls, text);
  t.type = 'button';
  t.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger a parent card's open-detail click
    filterSet.add(value);
    showTab('browse');
    render();
  });
  return t;
}

function initCategoryChecks() {
  const box = $('category-checks');
  box.replaceChildren();
  for (const c of CATEGORIES) {
    const label = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox'; cb.value = c;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + c));
    box.appendChild(label);
  }
}
initCategoryChecks();

// Repeatable (url, description) rows for "where to buy" — each row is just
// two inputs plus a remove button, no framework needed for something this
// small. clearLinkRows() + addLinkRow() are also reused when opening the
// form to edit an existing book, to repopulate from its saved links.
function addLinkRow(url = '', desc = '') {
  const row = el('div', 'link-row');
  const urlInput = el('input');
  urlInput.type = 'url'; urlInput.maxLength = 600; urlInput.placeholder = 'https://…'; urlInput.value = url;
  const descInput = el('input');
  descInput.type = 'text'; descInput.maxLength = 120; descInput.placeholder = 'short description'; descInput.value = desc;
  const remove = el('button', 'mini', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove this link');
  remove.addEventListener('click', () => row.remove());
  row.append(urlInput, descInput, remove);
  $('link-rows').appendChild(row);
}
function clearLinkRows() { $('link-rows').replaceChildren(); }
function linkRowValues() {
  return [...$('link-rows').querySelectorAll('.link-row')].map(row => {
    const [urlInput, descInput] = row.querySelectorAll('input');
    return { url: urlInput.value.trim(), desc: descInput.value.trim() };
  }).filter(l => l.url || l.desc);
}
addLinkRow();
$('add-link').addEventListener('click', () => addLinkRow());

/* --------------------------------------------------------------- identity
   Real Firebase Anonymous Auth, not a self-invented random id. The rules
   now check auth.uid before letting anyone overwrite/delete a book or write
   someone else's vote — a client-supplied id could always be copied, since
   the data (including that id) is fully public, so nothing short of real
   auth can back an ownership check. The refresh token lives in localStorage
   so the same friend keeps the same identity — and keeps owning their past
   suggestions — across visits, with no login screen ever shown. */
const MIN_NAME = 2;
let idToken = null, MY_UID = null, tokenTimer = null;

async function signInAnonymously() {
  const r = await fetch(`${IDENTITY}/accounts:signUp?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`sign-in failed (${r.status})`);
  return r.json(); // { idToken, refreshToken, localId, expiresIn, ... } (camelCase)
}

async function refreshSession(refreshToken) {
  const r = await fetch(`${SECURETOKEN}/token?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!r.ok) throw new Error(`token refresh failed (${r.status})`);
  const j = await r.json(); // snake_case fields — normalize to match signUp's shape
  return { idToken: j.id_token, refreshToken: j.refresh_token, localId: j.user_id, expiresIn: j.expires_in };
}

function scheduleRefresh(expiresInSeconds) {
  clearTimeout(tokenTimer);
  // Tokens last ~1h; refresh 5 minutes early so the live connection (see
  // resubscribe) never runs on one that's about to be rejected.
  const ms = Math.max(30, (Number(expiresInSeconds) || 3600) - 300) * 1000;
  tokenTimer = setTimeout(renewAuth, ms);
}

async function renewAuth() {
  const saved = localStorage.getItem('bookclub.rt');
  try {
    const j = saved ? await refreshSession(saved) : await signInAnonymously();
    idToken = j.idToken;
    MY_UID = j.localId;
    try { localStorage.setItem('bookclub.rt', j.refreshToken); } catch { /* private mode */ }
    scheduleRefresh(j.expiresIn);
    resubscribe(); // reopen the live stream with the fresh token
    render();       // "yours" tags / vote highlighting depend on MY_UID
    return true;
  } catch (e) {
    console.error(e);
    // A saved refresh token can go bad (revoked, expired, anon account
    // deleted) — fall back to a brand-new anonymous sign-in once rather
    // than leaving this browser permanently stuck until someone manually
    // clears site data.
    if (saved) {
      try { localStorage.removeItem('bookclub.rt'); } catch { /* ignore */ }
      return renewAuth();
    }
    disableWrites(); // covers scheduled renewals too, not just the first call
    return false;
  }
}

function disableWrites() {
  $('submit').disabled = true;
  $('form-msg').textContent =
    "Can't sign in right now, so suggesting, voting, marking, and commenting are unavailable. Browsing still works.";
  $('form-msg').className = 'form-msg';
}

function who() { return ($('who').value || '').trim().replace(/\s{2,}/g, ' '); }
function named() { return who().length >= MIN_NAME; }

function requireName() {
  if (named()) {
    $('who').closest('.who').classList.remove('missing');
    $('who-hint').classList.add('hidden');
    return true;
  }
  $('who').closest('.who').classList.add('missing');
  $('who-hint').classList.remove('hidden');
  $('who').focus();
  toast('Add your name first');
  return false;
}

function requireAuth() {
  if (MY_UID) return true;
  toast("Still connecting — try again in a moment.");
  return false;
}

(function initWho() {
  let saved = '';
  try { saved = localStorage.getItem('bookclub.who') || ''; } catch { /* ignore */ }
  $('who').value = saved;
  $('who').addEventListener('change', () => {
    try { localStorage.setItem('bookclub.who', who()); } catch { /* ignore */ }
    render();
  });
})();

/* First-visit nudge: if nobody's set a name yet, ask up front instead of
   relying on people to notice the small header field on their own.
   Skippable — browsing, and that same header field, work with no name set. */
(function initNameGate() {
  let saved = '';
  try { saved = localStorage.getItem('bookclub.who') || ''; } catch { /* ignore */ }
  if (saved) return;

  const gate = $('name-gate');
  const input = $('name-gate-input');

  function close() {
    gate.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  }
  function save() {
    const name = input.value.trim().replace(/\s{2,}/g, ' ');
    if (name.length < MIN_NAME) { input.focus(); return; }
    $('who').value = name;
    try { localStorage.setItem('bookclub.who', name); } catch { /* ignore */ }
    close();
    render();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  gate.classList.remove('hidden');
  input.focus();
  document.addEventListener('keydown', onKey);
  gate.addEventListener('click', (e) => { if (e.target === gate) close(); });
  $('name-gate-save').addEventListener('click', save);
  $('name-gate-skip').addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
})();

/* --------------------------------------------------------------------- api */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

/** Rules reject malformed or unauthorized writes with 401. Translate that,
 *  because "Unauthorized" is misleading here — it usually means the data
 *  failed validation or you don't own the thing you're changing, not that
 *  you're "signed out" (this app has no sign-out concept). */
async function send(path, method, body) {
  const url = idToken ? `${DB}/${path}.json?auth=${idToken}` : `${DB}/${path}.json`;
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    // send() is shared by every write in the app (create, vote, like, rate,
    // comment, mark status, delete) — the message has to make sense for all
    // of them, not just book creation.
    throw new Error(r.status === 401
      ? "That was rejected — either the site isn't fully set up yet, or you don't have permission for this action."
      : `Request failed (${r.status})`);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

const newId = () =>
  't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const fromSnapshot = (obj) =>
  Object.entries(obj || {}).map(([id, b]) => ({ id, ...b }));

/* ------------------------------------------------------- live subscription
   EventSource on the REST endpoint: no SDK, and a friend's new suggestion shows
   up on every open page within a second. Polling backs it up so the shelf never
   silently goes stale. */
let es = null, pollTimer = null;

function subscribe() {
  // ?nolive loads a one-off snapshot and opens no stream. An open EventSource
  // keeps the page permanently "loading", which makes headless browsers hang
  // forever instead of finishing a screenshot — so automated checks need a way
  // to opt out. Also handy when debugging a frozen shelf.
  if (new URLSearchParams(location.search).has('nolive')) {
    setStatus('snapshot');
    return;
  }
  try {
    const q = idToken ? `?auth=${idToken}` : '';
    es = new EventSource(`${BOOKS}.json${q}`);
  } catch {
    return startPolling();
  }
  es.addEventListener('put', applyStream);
  es.addEventListener('patch', applyStream);
  es.addEventListener('open', () => setStatus('live'));
  es.addEventListener('error', () => {
    setStatus('reconnecting');
    if (!pollTimer) startPolling();     // EventSource retries; poll meanwhile
  });
}

function applyStream(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  const path = msg.path || '/';
  const data = msg.data;

  if (path === '/') {
    state.books = fromSnapshot(data);
  } else {
    // "/abc" is a whole book; "/abc/votes/XYZ" is one field inside one.
    const [, id, ...rest] = path.split('/');
    if (!id) return;
    const i = state.books.findIndex(b => b.id === id);
    if (!rest.length) {
      if (data === null) { if (i >= 0) state.books.splice(i, 1); }
      else if (i >= 0) state.books[i] = { id, ...data };
      else state.books.unshift({ id, ...data });
    } else if (i >= 0) {
      let node = state.books[i];
      for (const key of rest.slice(0, -1)) node = (node[key] ||= {});
      const last = rest[rest.length - 1];
      if (data === null) delete node[last]; else node[last] = data;
    }
  }
  setStatus('live');
  render();
}

// Reopens the live stream on a fresh token after an auth renewal, rather
// than leaving it running on one that's about to expire.
function resubscribe() {
  if (!es) return; // no stream open yet (e.g. ?nolive, or boot() hasn't reached subscribe() yet)
  es.close();
  subscribe();
}

function startPolling() {
  if (pollTimer) return;
  setStatus('polling');
  const tick = async () => {
    try {
      state.books = fromSnapshot(await send('bookclub/books', 'GET'));
      render();
    } catch { /* offline; retry next tick */ }
  };
  tick();
  pollTimer = setInterval(tick, 6000);
}

function setStatus(s) {
  const n = $('conn');
  n.textContent = s;
  n.className = 'conn ' + (s === 'live' ? 'on' : 'off');
}

/* -------------------------------------------------------------------- tabs */
function showTab(name, updateHash = true) {
  const browsing = name !== 'add';
  // Navigating away from the form without saving cancels an in-progress edit.
  if (browsing && state.editingId) stopEditing();
  // location.hash alone can't clear a ?book= query param, so leaving a
  // detail view needs a full URL rewrite via pushState, not just a hash set.
  const leavingDetail = !!state.viewingId || new URLSearchParams(location.search).has('book');
  state.viewingId = null;
  $('panel-browse').classList.toggle('hidden', !browsing);
  $('panel-add').classList.toggle('hidden', browsing);
  $('panel-detail').classList.add('hidden');
  $('tab-browse').classList.toggle('is-on', browsing);
  $('tab-add').classList.toggle('is-on', !browsing);
  const want = browsing ? '#browse' : '#add';
  if (updateHash) {
    if (leavingDetail) history.pushState({}, '', location.pathname + want);
    else if (location.hash !== want) location.hash = want;
  }
}
$('tab-browse').addEventListener('click', () => showTab('browse'));
$('tab-add').addEventListener('click', () => showTab('add'));
addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'browse', false));
showTab(location.hash.slice(1) || 'browse', false);

/* ------------------------------------------------------------ book detail
   The single source of truth for "which book, if any, is being viewed" is
   the ?book= query param — the same one the share button already produces,
   so a shared link and a normal click land in exactly the same place. */
function showBookDetail(id, push = true) {
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  state.viewingId = id;
  $('tab-browse').classList.remove('is-on');
  $('tab-add').classList.remove('is-on');
  $('panel-browse').classList.add('hidden');
  $('panel-add').classList.add('hidden');
  $('panel-detail').classList.remove('hidden');
  renderDetail(b);
  if (push) {
    const url = `${location.pathname}?book=${id}`;
    history.pushState({ book: id }, '', url);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideBookDetail(updateUrl = true) {
  state.viewingId = null;
  $('panel-detail').classList.add('hidden');
  if (updateUrl) history.pushState({}, '', location.pathname + (location.hash || '#browse'));
}

$('detail-back').addEventListener('click', () => {
  hideBookDetail();
  showTab('browse', false);
});

// Back/forward browser buttons: re-derive the view from the URL rather than
// trying to track history state by hand.
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('book');
  if (id) showBookDetail(id, false);
  else { hideBookDetail(false); showTab(location.hash.slice(1) || 'browse', false); }
});

/* ----------------------------------------------------------------- filters */
function tally(pick) {
  const m = new Map();
  for (const b of state.books) for (const v of pick(b)) if (v) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]));
}

// A multi-select dropdown, not a single-choice one: several of these filters
// (label especially) make sense to combine, e.g. "short" and "gentle" at
// once, so a plain <select> would lose functionality the old chips had.
// Options come from tally() over live data, never a fixed list, so a brand
// new category/label/person/status shows up here the moment someone uses it.
function filterSelect(title, entries, set) {
  if (!entries.length) return null;
  const id = 'filter-' + title.replace(/\s+/g, '-');
  const wrap = el('div', 'filter-field');
  const label = el('label', 'chip-label', title);
  label.htmlFor = id;
  wrap.appendChild(label);

  const sel = el('select', 'select');
  sel.id = id;
  sel.multiple = true;
  sel.size = Math.min(entries.length, 5);
  for (const [value, n] of entries) {
    const o = el('option', null, `${value} (${n})`);
    o.value = value;
    o.selected = set.has(value);
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    set.clear();
    for (const o of sel.selectedOptions) set.add(o.value);
    render();
  });
  wrap.appendChild(sel);
  return wrap;
}

const votesOf = (b) => (b.votes && typeof b.votes === 'object' ? b.votes : {});
const likesOf = (b) => (b.likes && typeof b.likes === 'object' ? b.likes : {});
const commentsOf = (b) =>
  Object.entries(b.comments || {}).map(([id, c]) => ({ id, ...c }))
    .sort((x, y) => (x.at || 0) - (y.at || 0));

// Ratings are per-person (bookclub/books/$id/ratings/$who), seeded with the
// submitter's own rating at creation time. Newer entries are {name, value}
// so "who rated this" can be shown; entries from before that existed are a
// bare number — both are handled here so old data doesn't break.
const ratingValue = (entry) => (typeof entry === 'object' && entry !== null ? entry.value : entry);
function ratingsOf(b) {
  const r = b.ratings && typeof b.ratings === 'object' ? Object.values(b.ratings).map(ratingValue) : [];
  return r.length ? r : (b.rating ? [b.rating] : []);
}
const avgRating = (b) => {
  const r = ratingsOf(b);
  return r.length ? r.reduce((s, v) => s + v, 0) / r.length : 0;
};
// {name, value} pairs for display. Legacy bare-number entries have no name
// on record, so they show as "someone" rather than guessing.
function ratingEntries(b) {
  if (!b.ratings || typeof b.ratings !== 'object') {
    // Books from before per-person ratings existed at all only have the
    // flat `rating` field — same fallback ratingsOf() already uses.
    return b.rating ? [{ name: 'someone', value: b.rating }] : [];
  }
  return Object.values(b.ratings).map(entry =>
    typeof entry === 'object' && entry !== null
      ? { name: entry.name, value: entry.value }
      : { name: 'someone', value: entry });
}
function myRatingValue(b) {
  const r = b.ratings && MY_UID && b.ratings[MY_UID];
  return r == null ? null : ratingValue(r);
}

function ratingWidget(b) {
  if (!MY_UID) return null;
  const myRating = myRatingValue(b);
  const rateRow = el('div', 'rate-row');
  rateRow.appendChild(el('span', 'rate-label', myRating ? `Your rating: ${myRating}/10` : 'Rate this book'));
  const rateSelect = el('select', 'select');
  const blank = el('option', null, '–'); blank.value = '';
  rateSelect.appendChild(blank);
  for (let i = 1; i <= 10; i++) {
    const o = el('option', null, String(i));
    o.value = String(i);
    if (myRating === i) o.selected = true;
    rateSelect.appendChild(o);
  }
  const rateBtn = el('button', 'mini', myRating ? 'update' : 'rate');
  rateBtn.type = 'button';
  rateBtn.addEventListener('click', async () => {
    const val = parseInt(rateSelect.value, 10);
    if (!val || !requireName() || !requireAuth()) return;
    rateBtn.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/ratings/${MY_UID}`, 'PUT', { name: who(), value: val });
    } catch (e) { toast(e.message); }
    rateBtn.disabled = false;
  });
  rateRow.append(rateSelect, rateBtn);
  return rateRow;
}

// Who did what — votes, likes, ratings, and the last status change all show
// names now. Deliberately not shown: who shared a link, or how many times —
// that was never tracked and was explicitly asked to stay that way.
function whoDidWhat(b) {
  const box = el('div', 'who-list');
  const voters = Object.values(votesOf(b));
  if (voters.length) {
    const p = el('p', 'who-line');
    p.appendChild(el('b', null, 'Wants to read: '));
    p.appendChild(document.createTextNode(voters.join(', ')));
    box.appendChild(p);
  }
  // Older likes are a bare `true` with no name attached — only show ones we
  // actually know the name for, rather than printing "true".
  const likers = Object.values(likesOf(b)).filter(v => typeof v === 'string');
  if (likers.length) {
    const p = el('p', 'who-line');
    p.appendChild(el('b', null, 'Liked by: '));
    p.appendChild(document.createTextNode(likers.join(', ')));
    box.appendChild(p);
  }
  if (b.status && b.status !== 'suggested' && b.statusBy) {
    const p = el('p', 'who-line');
    p.appendChild(el('b', null, `Marked ${b.status} by: `));
    p.appendChild(document.createTextNode(b.statusBy));
    box.appendChild(p);
  }
  const ratings = ratingEntries(b);
  if (ratings.length) {
    const p = el('p', 'who-line');
    p.appendChild(el('b', null, 'Rated by: '));
    p.appendChild(document.createTextNode(ratings.map(r => `${r.name} (${r.value}/10)`).join(', ')));
    box.appendChild(p);
  }
  return box.childElementCount ? box : null;
}

function renderFilters() {
  const box = $('filters');
  box.replaceChildren();
  for (const r of [
    filterSelect('type', tally(b => [b.bookType]), state.bookType),
    filterSelect('faith', tally(b => [b.faith]), state.faith),
    filterSelect('category', tally(categoriesOf), state.categories),
    filterSelect('series', tally(b => [b.series]), state.series),
    filterSelect('format', tally(b => asList(b.formats)), state.format),
    filterSelect('from', tally(b => [b.suggestedBy]), state.person),
    filterSelect('status', tally(b => [b.status]), state.status),
  ].filter(Boolean)) box.appendChild(r);

  const active = state.bookType.size + state.faith.size + state.categories.size + state.series.size
    + state.format.size + state.person.size + state.status.size;
  if (active) {
    const clear = el('button', 'chip', 'clear filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      state.bookType.clear(); state.faith.clear(); state.categories.clear(); state.series.clear();
      state.format.clear(); state.person.clear(); state.status.clear();
      render();
    });
    box.appendChild(clear);
  }
}

function visible() {
  const q = state.q.trim().toLowerCase();
  const out = state.books.filter(b => {
    if (state.bookType.size && !state.bookType.has(b.bookType)) return false;
    if (state.faith.size && !state.faith.has(b.faith)) return false;
    if (state.person.size && !state.person.has(b.suggestedBy)) return false;
    if (state.status.size && !state.status.has(b.status)) return false;
    if (state.categories.size && !categoriesOf(b).some(c => state.categories.has(c))) return false;
    if (state.series.size && !state.series.has(b.series)) return false;
    if (state.format.size && !asList(b.formats).some(f => state.format.has(f))) return false;
    if (!q) return true;
    return [b.title, b.author, b.description, b.note, b.bookType, b.faith, b.suggestedBy, b.series, ...categoriesOf(b)]
      .join(' ').toLowerCase().includes(q);
  });
  const by = {
    new:    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    old:    (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    title:  (a, b) => (a.title || '').localeCompare(b.title || ''),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~'),
    votes:  (a, b) => Object.keys(votesOf(b)).length - Object.keys(votesOf(a)).length,
    rating: (a, b) => avgRating(b) - avgRating(a),
  }[state.sort];
  return out.sort(by);
}

/* --------------------------------------------------------------- book card */
function coverNode(b) {
  const wrap = el('div', 'cover-wrap');
  const initials = (b.title || '?').trim().slice(0, 1).toUpperCase()
                 + ((b.author || '').trim().slice(0, 1).toUpperCase());
  wrap.appendChild(el('div', 'cover-fallback', initials || '?'));
  if (b.cover) {
    const img = el('img');
    img.alt = ''; img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());   // DOM node, not a db ref
    img.src = b.cover;                                   // rules restrict to http(s)
    wrap.appendChild(img);
  }
  if (b.status && b.status !== 'suggested') {
    wrap.appendChild(el('span', 'badge ' + b.status, b.status));
  }
  return wrap;
}

function bookCard(b) {
  const card = el('article', 'book');
  card.dataset.id = b.id;
  const cover = coverNode(b);
  cover.classList.add('clickable');
  cover.tabIndex = 0;
  cover.setAttribute('role', 'button');
  cover.addEventListener('click', () => showBookDetail(b.id));
  cover.addEventListener('keydown', (e) => { if (e.key === 'Enter') showBookDetail(b.id); });
  card.appendChild(cover);

  const body = el('div', 'body');
  const titleEl = el('h3', 'title clickable', b.title);
  titleEl.tabIndex = 0;
  titleEl.setAttribute('role', 'button');
  titleEl.title = 'View details';
  titleEl.addEventListener('click', () => showBookDetail(b.id));
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') showBookDetail(b.id); });
  body.appendChild(titleEl);
  const bits = [b.author, b.bookType].filter(Boolean).join(' · ');
  if (bits) body.appendChild(el('p', 'byline', bits));
  if (b.series) body.appendChild(filterTag('series-tag', seriesLabel(b), state.series, b.series));
  const ratingCount = ratingsOf(b).length;
  if (ratingCount) {
    body.appendChild(el('div', 'stars',
      `★ ${avgRating(b).toFixed(1)}/10 (${ratingCount} rating${ratingCount === 1 ? '' : 's'})`));
  }

  const tags = el('div', 'labels');
  if (b.faith) tags.appendChild(filterTag('tag cat', b.faith, state.faith, b.faith));
  for (const c of categoriesOf(b)) tags.appendChild(filterTag('tag', c, state.categories, c));
  if (tags.childElementCount) body.appendChild(tags);

  const expanded = state.expanded.has(b.id);
  const more = el('button', 'more-toggle', expanded ? 'less info ▲' : 'more info ▼');
  more.type = 'button';
  more.setAttribute('aria-expanded', String(expanded));
  more.addEventListener('click', () => {
    state.expanded.has(b.id) ? state.expanded.delete(b.id) : state.expanded.add(b.id);
    render();
  });
  body.appendChild(more);

  if (expanded) {
    if (b.note) {
      const why = el('p', 'note why');
      why.appendChild(el('b', null, 'Why recommend it: '));
      why.appendChild(document.createTextNode(b.note));
      body.appendChild(why);
    }
    if (b.description) body.appendChild(el('p', 'note', b.description));
    if (b.warnings) {
      const w = el('p', 'warn-note');
      w.appendChild(el('b', null, '⚠ '));
      w.appendChild(document.createTextNode(b.warnings));
      body.appendChild(w);
    }

    const formats = asList(b.formats);
    if (formats.length) {
      const f = el('div', 'labels');
      for (const fmt of formats) f.appendChild(filterTag('tag', fmt, state.format, fmt));
      body.appendChild(f);
    }

    const links = linksOf(b);
    if (links.length) {
      const linkList = el('div', 'link-list');
      for (const l of links) {
        const row = el('div', 'link-item');
        // Same javascript:-URI guard as everywhere else user text becomes a
        // clickable href: only a real http(s) URL gets to be an <a>.
        if (/^https?:\/\//i.test((l.url || '').trim())) {
          const a = el('a', 'ext', l.desc || l.url);
          a.href = l.url.trim();
          a.target = '_blank'; a.rel = 'noopener noreferrer';
          row.appendChild(a);
        } else if (l.desc || l.url) {
          row.appendChild(el('span', 'ext', l.desc || l.url));
        }
        if (row.childElementCount) linkList.appendChild(row);
      }
      if (linkList.childElementCount) body.appendChild(linkList);
    }

    // Anyone signed in can add or change their own rating — the average
    // shown above updates live for every visitor via the normal subscription.
    const rw1 = ratingWidget(b);
    if (rw1) body.appendChild(rw1);

    body.appendChild(el('p', 'meta', 'suggested by ' + (b.suggestedBy || 'someone')));
  }

  card.appendChild(body);
  card.appendChild(bookFooter(b, { includeCommentToggle: true }));
  if (state.open.has(b.id)) card.appendChild(thread(b));
  return card;
}

// Shared action-button row: vote, like, comment, mark status, share, plus
// the owner "yours" marker and admin delete. Used by both the compact card
// and the detail page so this interactive logic (all the send() calls and
// error handling) exists exactly once instead of drifting between two copies.
function bookFooter(b, opts = {}) {
  const foot = el('div', 'foot');
  const votes = votesOf(b);
  const names = Object.values(votes);
  const mine = MY_UID ? Object.prototype.hasOwnProperty.call(votes, MY_UID) : false;
  const vote = el('button', 'mini' + (mine ? ' is-on' : ''),
    (mine ? '✓ want to read' : 'want to read') + (names.length ? ' ' + names.length : ''));
  vote.type = 'button';
  vote.title = names.length ? names.join(', ') : 'nobody yet';
  vote.addEventListener('click', async () => {
    if (!requireName() || !requireAuth()) return;
    vote.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/votes/${MY_UID}`, 'PUT', mine ? null : who());
    } catch (e) { toast(e.message); }
    vote.disabled = false;
  });
  foot.appendChild(vote);

  const likes = likesOf(b);
  const likeCount = Object.keys(likes).length;
  const iLike = MY_UID ? Object.prototype.hasOwnProperty.call(likes, MY_UID) : false;
  const like = el('button', 'mini like' + (iLike ? ' is-on' : ''),
    (iLike ? '♥' : '♡') + ' ' + likeCount);
  like.type = 'button';
  like.title = iLike ? 'Unlike' : 'Like';
  like.addEventListener('click', async () => {
    if (!requireName() || !requireAuth()) return;
    like.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/likes/${MY_UID}`, 'PUT', iLike ? null : who());
    } catch (e) { toast(e.message); }
    like.disabled = false;
  });
  foot.appendChild(like);

  if (opts.includeCommentToggle) {
    const cN = commentsOf(b).length;
    const talk = el('button', 'mini', cN ? `comments ${cN}` : 'comment');
    talk.type = 'button';
    talk.addEventListener('click', () => {
      state.open.has(b.id) ? state.open.delete(b.id) : state.open.add(b.id);
      render();
    });
    foot.appendChild(talk);
  }

  const next = { suggested: 'reading', reading: 'read', read: 'suggested' };
  const mark = el('button', 'mini',
    b.status === 'read' ? 'mark unread' : `mark ${next[b.status] || 'reading'}`);
  mark.type = 'button';
  mark.addEventListener('click', async () => {
    if (!requireName() || !requireAuth()) return;
    try {
      await send(`bookclub/books/${b.id}`, 'PATCH', { status: next[b.status] || 'reading', statusBy: who() });
    } catch (e) { toast(e.message); }
  });
  foot.appendChild(mark);

  const share = el('button', 'mini', 'share');
  share.type = 'button';
  share.addEventListener('click', () => shareBook(b));
  foot.appendChild(share);

  foot.appendChild(el('span', 'spacer'));

  if (MY_UID && b.ownerPCID === MY_UID) foot.appendChild(el('span', 'yours', 'yours'));

  // Anyone signed in can delete — the button below is shown only with
  // ?admin in the URL (see the ADMIN_UI comment near the top of this
  // file), but the rules don't actually check for that.
  if (ADMIN_UI) {
    const del = el('button', 'mini danger', 'delete');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!requireAuth()) return;
      if (!confirm(`Remove "${b.title}" permanently? This can't be undone.`)) return;
      del.disabled = true;
      try {
        await send(`bookclub/books/${b.id}`, 'DELETE');
      } catch (e) {
        toast(e.message);
        del.disabled = false;
      }
    });
    foot.appendChild(del);
  }

  return foot;
}

// The full detail page for one book — everything the compact card hides
// behind "more info" is always shown here, plus an edit button up top
// (next to the title, not buried in the footer) and an always-open
// comment thread instead of a toggle.
function renderDetail(b) {
  const box = $('detail-content');
  box.replaceChildren();

  const cover = coverNode(b);
  cover.classList.add('detail-cover');
  box.appendChild(cover);

  const body = el('div', 'body detail-body');

  const head = el('div', 'detail-head');
  head.appendChild(el('h2', 'title', b.title));
  if (MY_UID) {
    const editBtn = el('button', 'mini primary', 'edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => startEdit(b));
    head.appendChild(editBtn);
  }
  body.appendChild(head);

  const bits = [b.author, b.bookType].filter(Boolean).join(' · ');
  if (bits) body.appendChild(el('p', 'byline', bits));
  if (b.series) body.appendChild(filterTag('series-tag', seriesLabel(b), state.series, b.series));

  const ratingCount = ratingsOf(b).length;
  if (ratingCount) {
    body.appendChild(el('div', 'stars',
      `★ ${avgRating(b).toFixed(1)}/10 (${ratingCount} rating${ratingCount === 1 ? '' : 's'})`));
  }

  const tags = el('div', 'labels');
  if (b.bookType) tags.appendChild(filterTag('tag', b.bookType, state.bookType, b.bookType));
  if (b.faith) tags.appendChild(filterTag('tag cat', b.faith, state.faith, b.faith));
  for (const c of categoriesOf(b)) tags.appendChild(filterTag('tag', c, state.categories, c));
  if (tags.childElementCount) body.appendChild(tags);

  if (b.note) {
    const why = el('p', 'note why');
    why.appendChild(el('b', null, 'Why recommend it: '));
    why.appendChild(document.createTextNode(b.note));
    body.appendChild(why);
  }
  if (b.description) body.appendChild(el('p', 'note', b.description));
  if (b.warnings) {
    const w = el('p', 'warn-note');
    w.appendChild(el('b', null, '⚠ '));
    w.appendChild(document.createTextNode(b.warnings));
    body.appendChild(w);
  }

  const formats = asList(b.formats);
  if (formats.length) {
    const f = el('div', 'labels');
    for (const fmt of formats) f.appendChild(filterTag('tag', fmt, state.format, fmt));
    body.appendChild(f);
  }

  const links = linksOf(b);
  if (links.length) {
    const linkList = el('div', 'link-list');
    for (const l of links) {
      const row = el('div', 'link-item');
      if (/^https?:\/\//i.test((l.url || '').trim())) {
        const a = el('a', 'ext', l.desc || l.url);
        a.href = l.url.trim();
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        row.appendChild(a);
      } else if (l.desc || l.url) {
        row.appendChild(el('span', 'ext', l.desc || l.url));
      }
      if (row.childElementCount) linkList.appendChild(row);
    }
    if (linkList.childElementCount) body.appendChild(linkList);
  }

  const rw2 = ratingWidget(b);
  if (rw2) body.appendChild(rw2);

  const who1 = whoDidWhat(b);
  if (who1) body.appendChild(who1);

  body.appendChild(el('p', 'meta', 'suggested by ' + (b.suggestedBy || 'someone')));
  body.appendChild(bookFooter(b));
  body.appendChild(thread(b));

  box.appendChild(body);
}

function thread(b) {
  const box = el('div', 'thread');
  const list = commentsOf(b);
  if (!list.length) box.appendChild(el('p', 'no-cmt', 'No comments yet.'));
  for (const c of list) {
    const p = el('p', 'cmt');
    p.appendChild(el('b', null, c.by));
    p.appendChild(document.createTextNode(c.text));
    box.appendChild(p);
  }
  const form = el('form', 'cmt-form');
  const input = el('textarea');
  input.maxLength = 1000; input.rows = 2; input.placeholder = 'Say something…';
  // Enter submits, Shift+Enter makes a new line — a plain textarea would
  // otherwise trap Enter as a newline with no obvious way to send.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  const post = el('button', 'mini', 'Post');
  post.type = 'submit';
  form.append(input, post);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !requireName() || !requireAuth()) return;
    post.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/comments/${newId()}`, 'PUT',
                 { by: who(), text, at: Date.now(), authorUID: MY_UID });
      input.value = '';
    } catch (e) { toast(e.message); }
    post.disabled = false;
  });
  box.appendChild(form);
  return box;
}

/* ------------------------------------------------------------------ render */
function render() {
  jumpToSharedBookIfNeeded();
  // Keep an open detail page live too — someone else's comment/vote/edit
  // should show up there the same way it does in the list.
  if (state.viewingId) {
    const b = state.books.find(x => x.id === state.viewingId);
    if (b) renderDetail(b); else hideBookDetail();
  }
  renderFilters();
  const list = visible();
  const grid = $('grid');
  grid.replaceChildren();
  for (const b of list) grid.appendChild(bookCard(b));

  const total = state.books.length;
  $('count').textContent = total === 0 ? ''
    : list.length === total ? `${total} book${total === 1 ? '' : 's'}`
    : `${list.length} of ${total} books`;

  const empty = $('empty');
  if (!total) {
    empty.classList.remove('hidden');
    empty.textContent = 'The shelf is empty. Add the first suggestion →';
  } else if (!list.length) {
    empty.classList.remove('hidden');
    empty.textContent = 'Nothing matches those filters.';
  } else empty.classList.add('hidden');
}

$('q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; render(); });

$('filters-toggle').addEventListener('click', () => {
  const open = $('filters').classList.toggle('open');
  $('filters-toggle').setAttribute('aria-expanded', String(open));
  $('filters-toggle').querySelector('.chevron').textContent = open ? '▾' : '▸';
});

/* --------------------------------------------------- open library lookup
   Called straight from the browser: openlibrary.org sends
   Access-Control-Allow-Origin: *, so no proxy is needed now the server is gone. */
let lookupTimer = null;
const closeSuggest = () => $('suggest').classList.add('hidden');

function fillFrom(hit) {
  $('f-title').value = hit.title || $('f-title').value;
  if (hit.author) $('f-author').value = hit.author;
  if (hit.cover) $('f-cover').value = hit.cover;
  const firstUrlInput = $('link-rows').querySelector('.link-row input');
  if (hit.link && firstUrlInput && !firstUrlInput.value) firstUrlInput.value = hit.link;
  closeSuggest(); updatePreview(); $('f-description').focus();
}

async function lookup(q) {
  const box = $('suggest');
  try {
    const url = 'https://openlibrary.org/search.json?' + new URLSearchParams({
      q, limit: '8', fields: 'title,author_name,first_publish_year,cover_i,key' });
    const raw = await (await fetch(url)).json();
    const hits = (raw.docs || []).slice(0, 8).map(d => ({
      title: d.title || '',
      author: (d.author_name || [''])[0] || '',
      year: String(d.first_publish_year || '').slice(0, 8),
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
      link: d.key ? `https://openlibrary.org${d.key}` : '',
    }));
    box.replaceChildren();
    if (!hits.length) return closeSuggest();
    for (const h of hits) {
      const b = el('button', 'sg');
      b.type = 'button';
      if (h.cover) {
        const img = el('img');
        img.alt = ''; img.loading = 'lazy';
        img.addEventListener('error', () => img.remove());
        img.src = h.cover;
        b.appendChild(img);
      }
      const txt = el('span');
      txt.appendChild(el('span', 'sg-t', h.title));
      txt.appendChild(el('span', 'sg-a', [h.author, h.year].filter(Boolean).join(' · ')));
      b.appendChild(txt);
      b.addEventListener('click', () => fillFrom(h));
      box.appendChild(b);
    }
    box.classList.remove('hidden');
  } catch { closeSuggest(); }
}

$('f-title').addEventListener('input', (e) => {
  clearTimeout(lookupTimer);
  const q = e.target.value.trim();
  if (q.length < 3) return closeSuggest();
  lookupTimer = setTimeout(() => lookup(q), 350);
});
$('f-title').addEventListener('blur', () => setTimeout(closeSuggest, 180));

function updatePreview() {
  const img = $('f-preview'), url = $('f-cover').value.trim();
  if (/^https?:\/\//i.test(url)) { img.src = url; img.classList.remove('hidden'); }
  else img.classList.add('hidden');
}
$('f-cover').addEventListener('input', updatePreview);
$('f-preview').addEventListener('error', () => $('f-preview').classList.add('hidden'));

/* ------------------------------------------------------------- add a book */
$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('form-msg');
  msg.className = 'form-msg'; msg.textContent = '';

  const bookType = $('f-book-type').value;
  const title = $('f-title').value.trim();
  const author = $('f-author').value.trim();
  const faith = $('f-faith').value;
  const description = $('f-description').value.trim();
  const rating = parseInt($('f-rating').value, 10);
  const note = $('f-note').value.trim();
  const formats = [...document.querySelectorAll('input[name=format]:checked')].map(c => c.value);

  if (!bookType) { msg.textContent = 'Book Type is required.'; $('f-book-type').focus(); return; }
  if (!title) { msg.textContent = 'A title is required.'; $('f-title').focus(); return; }
  if (!author) { msg.textContent = 'Author is required.'; $('f-author').focus(); return; }
  if (!faith) { msg.textContent = 'Catholic/Christian? is required.'; $('f-faith').focus(); return; }
  if (!description) { msg.textContent = 'A description is required.'; $('f-description').focus(); return; }
  if (!rating) { msg.textContent = 'A rating is required.'; $('f-rating').focus(); return; }
  if (!note) { msg.textContent = 'Tell us why you recommend it.'; $('f-note').focus(); return; }
  if (!formats.length) { msg.textContent = 'Pick at least one format.'; return; }
  if (!requireName()) { msg.textContent = 'Add your name at the top of the page.'; return; }
  if ($('f-website').value) return;            // honeypot
  if (!requireAuth()) { msg.textContent = 'Still connecting — try again in a moment.'; return; }

  const categories = [...document.querySelectorAll('#category-checks input:checked')].map(c => c.value);
  const other = $('f-category-other').value.trim();
  if (other) categories.push(other);
  const links = linkRowValues();
  const series = $('f-series').value.trim();
  // A number without a series name is meaningless to display, so drop it
  // rather than store an orphaned value.
  const seriesNumber = series ? parseInt($('f-series-number').value, 10) || null : null;
  const cover = $('f-cover').value.trim();
  const warnings = $('f-warnings').value.trim();

  const editingId = state.editingId;
  const btn = $('submit');
  btn.disabled = true;
  try {
    if (editingId) {
      // PATCH (not PUT) so this only touches these keys — status, votes,
      // likes, ratings, comments, ownerPCID and createdAt are left alone.
      // A PUT would silently wipe all of that, since Firebase PUT replaces
      // the whole node.
      const patch = {
        bookType, title, author, faith, description, note, formats, cover, warnings, rating,
        categories: categories.length ? categories : null,
        links: links.length ? links : null,
        series: series || null,
        seriesNumber,
      };
      await send(`bookclub/books/${editingId}`, 'PATCH', patch);
      toast(`Saved changes to “${title}”`);
      stopEditing();
    } else {
      // Send only fields the rules recognise: an unknown key is rejected outright.
      const book = {
        bookType, title, author, faith, description, note, formats, cover, warnings, rating,
        // Seeds the shared ratings pool with the submitter's own score, so
        // "average rating" starts out equal to what they gave it rather than
        // 0 before anyone else has rated it.
        ratings: { [MY_UID]: { name: who(), value: rating } },
        status: 'suggested',
        suggestedBy: who(),
        ownerPCID: MY_UID,
        createdAt: Date.now(),
      };
      if (categories.length) book.categories = categories;
      if (links.length) book.links = links;
      if (series) book.series = series;
      if (seriesNumber) book.seriesNumber = seriesNumber;
      await send(`bookclub/books/${newId()}`, 'PUT', book);
      toast(`Added “${title}”`);
    }
    $('form').reset();
    clearLinkRows(); addLinkRow();
    updatePreview();
    showTab('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// Clicking a book you own opens it here, pre-filled, instead of a blank
// form. Only reachable via that explicit click — nothing auto-opens it.
function startEdit(b) {
  state.editingId = b.id;
  $('f-book-type').value = b.bookType || '';
  $('f-faith').value = b.faith || '';
  $('f-title').value = b.title || '';
  $('f-author').value = b.author || '';
  $('f-series').value = b.series || '';
  $('f-series-number').value = b.seriesNumber || '';
  $('f-cover').value = b.cover || '';
  updatePreview();

  const cats = new Set(categoriesOf(b));
  const known = new Set(CATEGORIES);
  for (const cb of document.querySelectorAll('#category-checks input')) cb.checked = cats.has(cb.value);
  $('f-category-other').value = [...cats].filter(c => !known.has(c)).join(', ');

  $('f-description').value = b.description || '';
  $('f-rating').value = b.rating ? String(b.rating) : '';
  $('f-note').value = b.note || '';
  for (const cb of document.querySelectorAll('input[name=format]')) cb.checked = asList(b.formats).includes(cb.value);

  clearLinkRows();
  const links = asList(b.links);
  if (links.length) for (const l of links) addLinkRow(l.url, l.desc);
  else if (b.link) addLinkRow(b.link, ''); // pre-migration single-link data
  else addLinkRow();

  $('f-warnings').value = b.warnings || '';

  $('form-heading').textContent = 'Edit book';
  $('submit').textContent = 'Save changes';
  showTab('add');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stopEditing() {
  state.editingId = null;
  $('form-heading').textContent = 'Suggest a book';
  $('submit').textContent = 'Add to the shelf';
}

function shareBook(b) {
  const url = `${location.origin}${location.pathname}?book=${b.id}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      () => toast('Link copied!'),
      () => prompt('Copy this link:', url)
    );
  } else {
    prompt('Copy this link:', url);
  }
}

// ?book=<id> in the URL jumps straight to that book: switches to Browse,
// expands its "more info", and scrolls it into view. Runs once, the first
// time that book actually shows up in state.books (it might arrive a beat
// after the initial page load, over the live connection).
let jumpedToSharedBook = false;
function jumpToSharedBookIfNeeded() {
  if (jumpedToSharedBook) return;
  const id = new URLSearchParams(location.search).get('book');
  if (!id) { jumpedToSharedBook = true; return; }
  if (!state.books.some(x => x.id === id)) return; // not loaded yet — try again next render
  jumpedToSharedBook = true;
  showBookDetail(id, false); // false: don't push a new history entry for the initial load
}

$('form').addEventListener('reset', () => setTimeout(() => {
  updatePreview(); $('form-msg').textContent = '';
}, 0));

/* -------------------------------------------------------------------- boot */
(async function boot() {
  setStatus('connecting');
  // Sign in/refresh in parallel with the first read, not before it: reading
  // needs no auth (rules keep it public), so a broken/unconfigured API key
  // should degrade to "browsing works, writing doesn't" rather than a blank
  // page. renewAuth() disables writes itself on failure — including later
  // scheduled renewals, not just this first call.
  renewAuth();
  try {
    state.books = fromSnapshot(await send('bookclub/books', 'GET'));
    render();
  } catch {
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Could not reach the shelf. Check your connection.';
  }
  subscribe();
})();
