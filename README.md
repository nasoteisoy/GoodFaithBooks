# Book Club

A small shared shelf: suggest books to your friends, see what they suggested,
say what you want to read next.

No build step, no framework, no dependencies. Three files and a database.

## How it works

The page talks straight to a Firebase Realtime Database over its REST API using
plain `fetch()` — no SDK, no `apiKey`, no registered app. Live updates arrive over
`EventSource`, so a book someone else adds appears on your screen within a second.

**Security lives in the database rules, not in this code.** Every write is
validated server-side: title length, URL scheme, rating range, required fields,
and unknown fields are rejected outright. Someone poking at the API with `curl`
gets exactly the same refusals this page does. Treat the client-side checks here
as convenience only.

Identity is a random id kept in `localStorage`, the same approach as the other
games in this project. It is a label, not a credential — anyone can set it. So
"only whoever added a book can remove it" is an honest convention among friends
rather than an enforced guarantee. Real enforcement would need Firebase
Anonymous Auth.

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
