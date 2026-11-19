# CineList agent guide

CineList is a Czech-language watchlist for movies and TV series. The public site is a static catalogue with a built-in demo and a passphrase-protected library. A local Python importer builds the library from ČSFD links, and a Node.js script encrypts it for publishing.

## Repository map

| Path | Responsibility |
| --- | --- |
| `docs/index.html`, `docs/styles.css`, `docs/app.js` | Public UI, catalogue filters and sorting, demo loading, and browser decryption |
| `docs/online-details.mjs`, `docs/api-cache.mjs`, `docs/sw.js` | Online metadata and artwork, public JSON cache, and image-only service worker cache |
| `docs/demo-movies.json`, `docs/movies.enc.json` | Public demo fixture and generated encrypted library |
| `tools/import_csfd.py` | ČSFD URL and CSV parsing, metadata enrichment, and library merging |
| `start-import.sh`, `tools/admin_server.py`, `tools/admin.*` | Local importer launcher, loopback HTTP server, and admin UI |
| `tools/encrypt.mjs` | Encryption CLI for the versioned library format |

## Local development

Run commands from the repository root. Preview the site over HTTP on loopback so browser fetches and Web Crypto work.

```sh
python3 -m http.server --bind 127.0.0.1 --directory docs 8000
```

Open `http://127.0.0.1:8000/` and choose the demo on the lock screen. Deploy with `docs/` as the site root over HTTPS. Use relative asset URLs so the site also works under a GitHub Pages project path.

For importer work, run `./start-import.sh` as a regular Linux user and open `http://127.0.0.1:8765/`. The launcher uses Python 3.9+ and installs dependencies from `tools/requirements.txt` into `.venv/`. For CLI options, run `.venv/bin/python3 tools/import_csfd.py --help`. See [README.md](README.md) for the import and publishing workflow.

## Implementation conventions

- Use the existing vanilla HTML, CSS, and JavaScript. Keep the public site deployable without a build step or a server application.
- Write user-facing text in Czech. For UI changes, preserve keyboard access, visible focus, responsive layouts, and reduced-motion behavior.
- Keep imported and third-party values on existing safe rendering paths. Escape values interpolated into HTML and validate external URLs before rendering them.
- Treat `cinelist-library` v1 and `cinelist-encrypted` v1 as compatibility contracts. For format changes, check the demo, importer, encryptor, and browser reader together. Preserve stable IDs, existing watch statuses during re-import, and atomic file writes.
- Preserve request cancellation when the user closes a detail view, switches libraries, or locks the catalogue. Render available catalogue data when providers time out or return no match.
- When changing a versioned browser asset path, update every reference to that asset, including dynamic imports. For a new metadata provider, check the relevant CSP directive and cache allowlist.

## Data boundaries

- Keep plaintext imports, reports, credentials, and passphrases out of Git and the public site. Keep project-local private data under the ignored `private/` directory.
- Keep the importer bound to `127.0.0.1` and preserve its Host, Origin, and local token checks. Keep optional TMDB and OMDb credentials in the importer environment.
- Keep decrypted records and passphrases out of browser storage, caches, and logs. Keep browser caches limited to public provider responses and artwork.
- Treat `docs/movies.enc.json` as generated data. Regenerate it only for a requested library update. For encryption testing, use a disposable passphrase and explicit input and output paths, with a public or synthetic fixture and a temporary output.

## Verification

The repository has no configured test runner. Run the relevant syntax checks and smoke-test the behavior you changed.

```sh
for file in docs/*.js docs/*.mjs tools/*.js tools/*.mjs; do
  node --check "$file" || exit 1
done
python3 -m py_compile tools/import_csfd.py tools/admin_server.py
sh -n start-import.sh
git diff --check
```

- **Catalogue:** Use the demo to check affected filters, sorting, layouts, and detail views. For lock-screen changes, also check returning to the lock screen and reopening the demo.
- **Metadata:** Verify that stored details remain usable on a failed lookup and that late responses do not update a closed or superseded view.
- **Importer:** Exercise affected text and CSV paths with fixtures. Use the `run_import` fetcher hook for network-free checks and send the library and report to temporary paths.
- **Encryption:** Open a temporary archive in a disposable preview directory. Check successful unlock with the fixture passphrase and error handling with an incorrect passphrase.
