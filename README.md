# CINELIST

A personal watchlist for movies and TV series. Browse the built-in demo or import your own collection from ČSFD and unlock it in the browser with a passphrase.

[Quick start](#quick-start) · [Import your library](#import-your-library) · [Deploy](#deploy)

## Features

- Search by title, filter by genre or watch status, and sort by rating, release year, or runtime.
- Switch between grid and list views and between light and dark themes.
- Explore random picks from your collection and see statistics for movies, series, seasons, and episodes.
- View posters, cast, artwork, and ratings from online sources when available.
- Host the read-only catalogue as a static site built with HTML, CSS, and vanilla JavaScript.

## Quick start

From the repository root, run this command with Python 3:

```bash
python3 -m http.server --bind 127.0.0.1 --directory docs 8000
```

Open [http://localhost:8000](http://localhost:8000) and choose the demo option on the lock screen. The demo includes 20 movies and 20 TV series and opens without a passphrase.

## Import your library

The local workflow uses Linux, Python 3.9 or newer with `venv` support, and Node.js for encryption. Start the importer from the repository root as a regular user:

```bash
./start-import.sh
```

The launcher creates `.venv/` and installs the Python dependencies as needed. Open [http://127.0.0.1:8765](http://127.0.0.1:8765), then paste one ČSFD title URL per line or upload a CSV with ČSFD title URLs in any column. The importer saves the library to `private/movies.json` and the import report to `private/last-import.json`.

<details>
<summary>Command-line import and optional metadata</summary>

Once the virtual environment exists, choose the command that matches your input file:

```bash
.venv/bin/python3 tools/import_csfd.py --txt private/links.txt
.venv/bin/python3 tools/import_csfd.py --csv private/links.csv
```

Add `--refresh` to fetch metadata again for previously imported titles. To enrich imports, set `TMDB_BEARER` or `TMDB_API_KEY` for TMDB and `OMDB_API_KEY` for OMDb in the environment before running either importer. OMDb enrichment requires an IMDb ID for the title.

</details>

### Encrypt and preview

After importing, run this command in an interactive terminal:

```bash
node tools/encrypt.mjs
```

Enter and confirm a strong passphrase of at least 16 characters. The command writes `docs/movies.enc.json`. Follow [Quick start](#quick-start) to open the site, or reload the preview page if it is already open. Enter the same passphrase on the lock screen.

## Deploy

Serve `docs/` as the site root on any static HTTPS host. For GitHub Pages, open **Settings → Pages**, select **Deploy from a branch**, and choose `main` and `/docs`. [GitHub Pages setup guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

To update the hosted library, commit and push the regenerated `docs/movies.enc.json`. Keep plaintext files under the Git-ignored `private/` directory and keep passphrases and API credentials out of Git.

CINELIST encrypts the library locally with AES-256-GCM and derives the encryption key using PBKDF2 with SHA-256. The browser decrypts the archive on HTTPS or localhost. Online lookups may send title names or IMDb IDs to external metadata providers.
