# Good Faith Books

A small shared shelf: suggest books to your friends, see what they suggested,
say what you want to read next.

No build step, no framework, no dependencies. Three files and a database.

## How it works

The page talks straight to a Firebase Realtime Database over its REST API using
plain `fetch()` — no SDK, no registered app. Live updates arrive over
`EventSource`, so a book someone else adds appears on your screen within a second.

**Security lives in the database rules, not in this code.** Every write is
validated *and authorized* server-side: title length, URL scheme, rating range,
required fields, unknown fields, and now — as of 2026-08-09 — real ownership,
checked against the rules in [`database.rules.json`](database.rules.json).
Someone poking at the API with `curl` gets exactly the same refusals this page
does. Treat the client-side checks here as convenience only.

**Identity is real Firebase Anonymous Auth, not a self-reported label.** On
first visit the page silently signs in anonymously and keeps the resulting
identity in `localStorage` (via its refresh token) so the same friend keeps
owning their past suggestions across visits — with no login screen ever shown.
This closes the gap the previous approach had: a client-supplied id could
always be copied by anyone, since the data (including that id) was fully
public, so nothing short of real auth could back an ownership check. Now:
- Only the original submitter's signed-in identity can ever match a book's
  `ownerPCID` — and even they can't overwrite or delete it afterward, since
  the rules only allow *creating* a book at that path, never updating or
  removing one. The shelf really is append-only, enforced, not just by the
  absence of a delete button.
- Voting is keyed by your own real identity, so nobody can cast or erase
  someone else's vote.
- Comments are create-only per id, and stamped with `authorUID`, so nobody
  can edit or delete someone else's comment.
- Marking a book's status (suggested/reading/read) stays open to any
  signed-in friend, deliberately — that's meant to be a shared, collaborative
  action, not locked to the original submitter.

This requires one piece of config that didn't exist before — see
**Configuration** below.

## Files

| | |
|---|---|
| `index.html` | markup, plus a CSP that allows only the database and Open Library |
| `app.js` | all behaviour. No `innerHTML` anywhere — every piece of user text reaches the page via `textContent` |
| `styles.css` | light and dark, follows the system setting |

## Running it locally

```
python -m http.server 8080
```

Then open `http://127.0.0.1:8080`. A server is needed rather than opening the
file directly, because a `file://` page sends `Origin: null` and the database
will refuse it.

`?nolive` loads a single snapshot and opens no stream — useful when debugging, and
required for headless browsers, which otherwise hang forever on the open
connection.

## Cover art

Titles are looked up on [Open Library](https://openlibrary.org), which fills in
the author, year and cover automatically. It occasionally returns a
foreign-language edition's jacket; paste your own URL in the cover field to
override it. Lookup needs internet — without it the form still works, just
without autofill.

## Configuration

The database URL is a constant at the top of `app.js`. `window.BOOKCLUB_DB`
overrides it, which exists so automated tests can point at a local mock instead
of writing to the real shelf.

**Firebase Web API Key (new, required for writes):** anonymous sign-in needs
this. It is a *public* key — Firebase's own docs describe it as safe to embed
in client code, since by itself it only identifies the project to Google's
Auth API and grants no access on its own. This is a completely different
thing from an Admin SDK **service-account key**, which must never appear
anywhere in this repo or be pasted anywhere outside Firebase/Google Cloud's
own consoles — that one bypasses every rule in this file.

1. Firebase Console → Project Settings (gear icon) → General tab → find
   **Web API Key** under "Your project" (it's just sitting there, no
   creation step needed).
2. Open `app.js` and replace the placeholder:
   ```js
   const WEB_API_KEY = window.BOOKCLUB_API_KEY || 'YOUR_FIREBASE_WEB_API_KEY';
   ```
3. In the Firebase Console, go to **Build → Authentication → Sign-in method**
   and enable **Anonymous** as a sign-in provider (it's off by default).
4. Go to **Build → Realtime Database → Rules** and paste in the contents of
   [`database.rules.json`](database.rules.json), replacing whatever is there
   now, then publish.

Until steps 2–4 are done, the page still loads and the shelf is still
browsable (reading has never required auth) — suggesting, voting, marking,
and commenting will just show "can't sign in right now" instead of failing
silently or crashing.
