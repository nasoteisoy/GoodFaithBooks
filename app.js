/* Book club — static build, talks straight to Firebase Realtime Database.
 *
 * No SDK, no apiKey, no registered web app. The REST API echoes any Origin and
 * allows every method, so plain fetch() is enough, and EventSource gives live
 * updates. Both verified against the deployed database on 2026-08-07.
 *
 * WHERE SECURITY LIVES: in the database rules, not in this file. Every write is
 * validated server-side — title length, URL scheme, rating range, unknown
 * fields. A friend using curl gets exactly the same rejections. Treat everything
 * below as convenience, not enforcement.
 *
 * Rule carried over from the server build: every piece of user text reaches the
 * page through textContent. There is no innerHTML in this file.
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

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
  return n;
}

const state = {
  books: [],
  q: '', sort: 'new',
  cat: new Set(), label: new Set(), person: new Set(), status: new Set(),
  open: new Set(),
};

/* ---------------------------------------------------------------- identity
   Same shape your games already use: a random id kept in localStorage. It is a
   label, not a credential — anyone can set it. The rules accept it as ownerPCID,
   so "only whoever added it can remove it" is an honest convention among friends
   rather than an enforced guarantee. */
const MIN_NAME = 2;

function pcid() {
  const k = 'BookClub-PC-ID';
  let id = null;
  try { id = localStorage.getItem(k); } catch { /* private mode */ }
  if (!id || id.length !== 12) {
    id = Array.from({ length: 12 },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]).join('');
    try { localStorage.setItem(k, id); } catch { /* ignore */ }
  }
  return id;
}
const MY_PCID = pcid();

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

(function initWho() {
  let saved = '';
  try { saved = localStorage.getItem('bookclub.who') || ''; } catch { /* ignore */ }
  $('who').value = saved;
  $('who').addEventListener('change', () => {
    try { localStorage.setItem('bookclub.who', who()); } catch { /* ignore */ }
    render();
  });
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

/** Rules reject malformed writes with 401. Translate that, because
 *  "Unauthorized" is misleading here — it means the data failed validation, not
 *  that you are signed out. */
async function send(path, method, body) {
  const r = await fetch(`${DB}/${path}.json`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(r.status === 401
      ? 'The database rejected that — check the title, your name, and any links.'
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
    es = new EventSource(`${BOOKS}.json`);
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
  renderDatalists();
}

function startPolling() {
  if (pollTimer) return;
  setStatus('polling');
  const tick = async () => {
    try {
      state.books = fromSnapshot(await send('bookclub/books', 'GET'));
      render(); renderDatalists();
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
  $('panel-browse').classList.toggle('hidden', !browsing);
  $('panel-add').classList.toggle('hidden', browsing);
  $('tab-browse').classList.toggle('is-on', browsing);
  $('tab-add').classList.toggle('is-on', !browsing);
  const want = browsing ? '#browse' : '#add';
  if (updateHash && location.hash !== want) location.hash = want;
}
$('tab-browse').addEventListener('click', () => showTab('browse'));
$('tab-add').addEventListener('click', () => showTab('add'));
addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'browse', false));
showTab(location.hash.slice(1) || 'browse', false);

/* ----------------------------------------------------------------- filters */
function tally(pick) {
  const m = new Map();
  for (const b of state.books) for (const v of pick(b)) if (v) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(b[0]));
}

function chipRow(title, entries, set) {
  if (!entries.length) return null;
  const wrap = el('div', 'chip-group');
  wrap.appendChild(el('span', 'chip-label', title));
  for (const [value, n] of entries) {
    const c = el('button', 'chip' + (set.has(value) ? ' is-on' : ''));
    c.type = 'button';
    c.appendChild(el('span', null, value));
    c.appendChild(el('span', 'n', n));
    c.addEventListener('click', () => {
      set.has(value) ? set.delete(value) : set.add(value);
      render();
    });
    wrap.appendChild(c);
  }
  return wrap;
}

// RTDB stores a JS array as an object when keys are sparse, so accept both.
function labelsOf(b) {
  const l = b.labels;
  return Array.isArray(l) ? l : (l && typeof l === 'object' ? Object.values(l) : []);
}
const votesOf = (b) => (b.votes && typeof b.votes === 'object' ? b.votes : {});
const commentsOf = (b) =>
  Object.entries(b.comments || {}).map(([id, c]) => ({ id, ...c }))
    .sort((x, y) => (x.at || 0) - (y.at || 0));

function renderFilters() {
  const box = $('filters');
  box.replaceChildren();
  for (const r of [
    chipRow('category', tally(b => [b.category]), state.cat),
    chipRow('label', tally(labelsOf), state.label),
    chipRow('from', tally(b => [b.suggestedBy]), state.person),
    chipRow('status', tally(b => [b.status]), state.status),
  ].filter(Boolean)) box.appendChild(r);

  if (state.cat.size + state.label.size + state.person.size + state.status.size) {
    const clear = el('button', 'chip', 'clear filters');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      state.cat.clear(); state.label.clear(); state.person.clear(); state.status.clear();
      render();
    });
    box.appendChild(clear);
  }
}

function visible() {
  const q = state.q.trim().toLowerCase();
  const out = state.books.filter(b => {
    if (state.cat.size && !state.cat.has(b.category)) return false;
    if (state.person.size && !state.person.has(b.suggestedBy)) return false;
    if (state.status.size && !state.status.has(b.status)) return false;
    if (state.label.size && !labelsOf(b).some(l => state.label.has(l))) return false;
    if (!q) return true;
    return [b.title, b.author, b.note, b.category, b.suggestedBy, b.year, ...labelsOf(b)]
      .join(' ').toLowerCase().includes(q);
  });
  const by = {
    new:    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    old:    (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    title:  (a, b) => (a.title || '').localeCompare(b.title || ''),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~'),
    votes:  (a, b) => Object.keys(votesOf(b)).length - Object.keys(votesOf(a)).length,
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
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
  card.appendChild(coverNode(b));

  const body = el('div', 'body');
  body.appendChild(el('h3', 'title', b.title));
  const bits = [b.author, b.year].filter(Boolean).join(' · ');
  if (bits) body.appendChild(el('p', 'byline', bits));
  if (b.rating > 0) body.appendChild(el('div', 'stars', '★'.repeat(b.rating)));

  const tags = el('div', 'labels');
  if (b.category) tags.appendChild(el('span', 'tag cat', b.category));
  for (const l of labelsOf(b)) tags.appendChild(el('span', 'tag', l));
  if (tags.childElementCount) body.appendChild(tags);

  if (b.note) body.appendChild(el('p', 'note', b.note));
  body.appendChild(el('p', 'meta', 'suggested by ' + (b.suggestedBy || 'someone')));
  card.appendChild(body);

  const foot = el('div', 'foot');
  const votes = votesOf(b);
  const names = Object.values(votes);
  const mine = Object.prototype.hasOwnProperty.call(votes, MY_PCID);
  const vote = el('button', 'mini' + (mine ? ' is-on' : ''),
    (mine ? '✓ want to read' : 'want to read') + (names.length ? ' ' + names.length : ''));
  vote.type = 'button';
  vote.title = names.length ? names.join(', ') : 'nobody yet';
  vote.addEventListener('click', async () => {
    if (!requireName()) return;
    vote.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/votes/${MY_PCID}`, 'PUT', mine ? null : who());
    } catch (e) { toast(e.message); }
    vote.disabled = false;
  });
  foot.appendChild(vote);

  const cN = commentsOf(b).length;
  const talk = el('button', 'mini', cN ? `comments ${cN}` : 'comment');
  talk.type = 'button';
  talk.addEventListener('click', () => {
    state.open.has(b.id) ? state.open.delete(b.id) : state.open.add(b.id);
    render();
  });
  foot.appendChild(talk);

  const next = { suggested: 'reading', reading: 'read', read: 'suggested' };
  const mark = el('button', 'mini',
    b.status === 'read' ? 'mark unread' : `mark ${next[b.status] || 'reading'}`);
  mark.type = 'button';
  mark.addEventListener('click', async () => {
    try { await send(`bookclub/books/${b.id}/status`, 'PUT', next[b.status] || 'reading'); }
    catch (e) { toast(e.message); }
  });
  foot.appendChild(mark);

  foot.appendChild(el('span', 'spacer'));

  if (b.link) {
    const a = el('a', 'ext', 'info ↗');
    a.href = b.link;                    // rules restrict to http(s)
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    foot.appendChild(a);
  }

  /* No delete button, deliberately. The rules permit creating a book and never
   * overwriting or removing one, so a shelf is append-only. That removes the
   * whole spoofable-ownership problem — there is no permission to fake, because
   * nobody has it. Mistakes are fixed in the Firebase console.
   * ownerPCID survives only as provenance: a quiet marker on your own additions. */
  if (b.ownerPCID === MY_PCID) foot.appendChild(el('span', 'yours', 'yours'));
  card.appendChild(foot);

  if (state.open.has(b.id)) card.appendChild(thread(b));
  return card;
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
  const input = el('input');
  input.type = 'text'; input.maxLength = 1000; input.placeholder = 'Say something…';
  const post = el('button', 'mini', 'Post');
  post.type = 'submit';
  form.append(input, post);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !requireName()) return;
    post.disabled = true;
    try {
      await send(`bookclub/books/${b.id}/comments/${newId()}`, 'PUT',
                 { by: who(), text, at: Date.now() });
      input.value = '';
    } catch (e) { toast(e.message); }
    post.disabled = false;
  });
  box.appendChild(form);
  return box;
}

/* ------------------------------------------------------------------ render */
function render() {
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

function renderDatalists() {
  const cats = $('cats');
  cats.replaceChildren();
  for (const [c] of tally(b => [b.category])) {
    const o = el('option'); o.value = c; cats.appendChild(o);
  }
  const bank = $('label-bank');
  bank.replaceChildren();
  for (const [l] of tally(labelsOf).slice(0, 14)) {
    const c = el('button', 'chip', l);
    c.type = 'button';
    c.addEventListener('click', () => {
      const cur = $('f-labels').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes(l)) cur.push(l);
      $('f-labels').value = cur.join(', ');
    });
    bank.appendChild(c);
  }
}

$('q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; render(); });

/* --------------------------------------------------- open library lookup
   Called straight from the browser: openlibrary.org sends
   Access-Control-Allow-Origin: *, so no proxy is needed now the server is gone. */
let lookupTimer = null;
const closeSuggest = () => $('suggest').classList.add('hidden');

function fillFrom(hit) {
  $('f-title').value = hit.title || $('f-title').value;
  if (hit.author) $('f-author').value = hit.author;
  if (hit.year) $('f-year').value = hit.year;
  if (hit.cover) $('f-cover').value = hit.cover;
  if (hit.link && !$('f-link').value) $('f-link').value = hit.link;
  closeSuggest(); updatePreview(); $('f-note').focus();
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

  const title = $('f-title').value.trim();
  if (!title) { msg.textContent = 'A title is required.'; $('f-title').focus(); return; }
  if (!requireName()) { msg.textContent = 'Add your name at the top of the page.'; return; }
  if ($('f-website').value) return;            // honeypot

  // Send only fields the rules recognise: an unknown key is rejected outright.
  const book = {
    title,
    author: $('f-author').value.trim(),
    year: $('f-year').value.trim(),
    category: $('f-category').value.trim(),
    note: $('f-note').value.trim(),
    cover: $('f-cover').value.trim(),
    link: $('f-link').value.trim(),
    rating: parseInt($('f-rating').value, 10) || 0,
    status: 'suggested',
    suggestedBy: who(),
    ownerPCID: MY_PCID,
    createdAt: Date.now(),
  };
  // De-duplicate after lowercasing: "strange, Strange" is one label, not two.
  // The rules accept duplicates, so without this the same tag renders twice on
  // the card — a regression from the server build's clean_labels().
  const labels = [...new Set(
    $('f-labels').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  )].slice(0, 12);
  if (labels.length) book.labels = labels;

  const btn = $('submit');
  btn.disabled = true;
  try {
    await send(`bookclub/books/${newId()}`, 'PUT', book);
    $('form').reset();
    updatePreview();
    toast(`Added “${book.title}”`);
    showTab('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$('form').addEventListener('reset', () => setTimeout(() => {
  updatePreview(); $('form-msg').textContent = '';
}, 0));

/* -------------------------------------------------------------------- boot */
(async function boot() {
  setStatus('connecting');
  try {
    state.books = fromSnapshot(await send('bookclub/books', 'GET'));
    render(); renderDatalists();
  } catch {
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Could not reach the shelf. Check your connection.';
  }
  subscribe();
})();
