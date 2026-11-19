#!/usr/bin/env python3
"""Offline CINELIST importer: only CSV or text containing CSFD film/series URLs.

Usage:
  python3 tools/import_csfd.py --txt private/odkazy.txt
  python3 tools/import_csfd.py --csv private/seznam.csv

Keeps plaintext in private/, never in docs/. Individual titles are saved atomically.
Optional providers: TMDB (TMDB_API_KEY or TMDB_BEARER), OMDb (OMDB_API_KEY).
CSFD is unofficial HTML extraction and can be blocked by the website.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone, timedelta
from difflib import SequenceMatcher
import json
import io
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unicodedata
from urllib.parse import urlparse, urlunparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError as e:
    sys.exit(f"Chybí knihovna {e.name}. Nainstaluj: python3 -m pip install -r tools/requirements.txt")

CSFD_ID = re.compile(r'^/film/(?P<id>\d+)(?P<slug>-[a-z0-9-]+)?(?:/prehled/?)?/?$', re.I)
URL_EXTRACT = re.compile(r'https?://[^\s<>"\']+', re.I)
YEAR = re.compile(r'(?<!\d)(?:18|19|20)\d{2}(?!\d)')
PERCENT = re.compile(r'(?<!\d)(100|\d{1,2})\s*%')
SERIES_WORD = re.compile(r'\b(?:seri[aá]l|tv\s*series|tv\s*seri[aá]l|minis[eé]rie|mini[ -]?series)\b', re.I)
DATE_FMT = '%Y-%m-%dT%H:%M:%SZ'
UA = 'CINELIST personal watchlist importer (one request per title; no bot bypass)'


def now_utc():
    return datetime.now(timezone.utc).strftime(DATE_FMT)


def canonical_csfd(value: str):
    """Only allow CSFD movie or series main pages; remove query, hash, redirects."""
    value = value.strip().strip('()[]<>,;\'"')
    try:
        u = urlparse(value)
        if u.scheme not in ('http', 'https') or (u.hostname or '').lower() not in ('www.csfd.cz', 'csfd.cz'):
            return None
        if u.username or u.password or u.port:
            return None
        m = CSFD_ID.fullmatch(u.path)
        if not m:
            return None
        slug = m.group('slug') or ''
        return f'https://www.csfd.cz/film/{int(m.group("id"))}{slug}/prehled/'
    except ValueError:
        return None


def scan_text(raw: str):
    links, ignored = [], []
    for no, row in enumerate(raw.splitlines(), 1):
        row = row.strip()
        if not row:
            continue
        found = canonical_csfd(row)
        if found:
            links.append(found)
        else:
            ignored.append(f'Řádek {no}: očekávám pouze jednu URL filmu/seriálu na ČSFD')
    return links, ignored


def scan_text_file(path: Path):
    raw = sys.stdin.read() if str(path) == '-' else path.read_text(encoding='utf-8-sig')
    return scan_text(raw)


def scan_csv(raw: str):
    try:
        dialect = csv.Sniffer().sniff(raw[:8192], delimiters=',;\t')
    except csv.Error:
        # Original Czech data commonly uses semicolon as delimiter.
        dialect = csv.excel
        if raw.count(';') > raw.count(','):
            dialect = csv.excel(); dialect.delimiter = ';'
    links, ignored = [], []
    for no, row in enumerate(csv.reader(io.StringIO(raw), dialect), 1):
        rowlinks = []
        for cell in row:
            for candidate in URL_EXTRACT.findall(cell):
                normalized = canonical_csfd(candidate)
                if normalized:
                    rowlinks.append(normalized)
        if rowlinks:
            links.extend(rowlinks)
        elif any(URL_EXTRACT.search(cell) for cell in row):
            ignored.append(f'CSV řádek {no}: žádná podporovaná URL ČSFD')
    return links, ignored


def scan_csv_file(path: Path):
    return scan_csv(path.read_text(encoding='utf-8-sig'))


def text(node):
    return node.get_text(' ', strip=True) if node else ''


def first_text(doc, selectors):
    for sel in selectors:
        value = text(doc.select_one(sel))
        if value:
            return value
    return ''


def as_number(value):
    try:
        n = int(value)
        return n if n >= 0 else None
    except (ValueError, TypeError):
        return None


def clean_original(value: str) -> str:
    """Remove the ČSFD 'více' UI control, never a real part of the title."""
    if not isinstance(value, str):
        return ''
    value = value.strip()
    # Only a final, standalone control label is removed (not part of a word).
    return re.sub(r'(?:\s|\xa0)+(?:více|vice)\s*$', '', value, flags=re.I).strip()


def clean_candidate_title(value: str) -> str:
    """Remove title-list controls without expanding legacy-record migration."""
    value = clean_original(value)
    return re.sub(r'(?:\s|\xa0)+(?:méně|mene)\s*$', '', value, flags=re.I).strip()


def original_from_li(li) -> str:
    """Read one title without flag images or expand/collapse controls."""
    copy = BeautifulSoup(str(li), 'html.parser')
    for unwanted in copy.select(
        '.more-name-link, .less-name-link, '
        'img, button, input, select, textarea, script, style'
    ):
        unwanted.decompose()
    # Some layouts use an otherwise unmarked link for these controls. Keep
    # links containing a title, and remove only standalone UI labels.
    for link in copy.select('a'):
        if re.fullmatch(r'\s*(?:více|vice|méně|mene)\s*', text(link), re.I):
            link.decompose()
        else:
            link.unwrap()
    return clean_candidate_title(text(copy))


def normalized_label(value: str) -> str:
    """Normalize country metadata independently of spelling and accents."""
    value = unicodedata.normalize('NFKD', value or '').casefold()
    value = ''.join(char for char in value if not unicodedata.combining(char))
    return ' '.join(re.findall(r'[a-z0-9]+', value))


COUNTRY_GROUPS = {
    'czech': {
        'cesko', 'ceska republika', 'czech', 'czechia', 'czech republic',
    },
    'slovak': {
        'slovensko', 'slovenska republika', 'slovak', 'slovakia', 'slovak republic',
    },
    'english': {
        'usa', 'us', 'u s a', 'spojene staty', 'spojene staty americke',
        'united states', 'united states of america',
        'velka britanie', 'spojene kralovstvi', 'uk', 'u k',
        'great britain', 'united kingdom',
        'australie', 'australia', 'kanada', 'canada', 'irsko', 'ireland',
        'novy zeland', 'new zealand',
    },
}


def country_group(li) -> str:
    """Return the language-priority group indicated by a candidate's flag."""
    for flag in li.select('.flag[title], .flag[alt], img[title], img[alt]'):
        # Prefer title, but accept alt when title is absent or malformed.
        for label in (flag.get('title'), flag.get('alt')):
            normalized = normalized_label(label) if isinstance(label, str) else ''
            for group, known in COUNTRY_GROUPS.items():
                if normalized in known:
                    return group
    return ''


def title_key(value: str) -> str:
    """Key equivalent titles without changing their displayed spelling."""
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def alternative_titles(soup):
    """Extract and deduplicate every ČSFD alternative title in document order."""
    candidates = []
    by_key = {}
    for order, li in enumerate(soup.select('.film-header-name .film-names li')):
        candidate = re.sub(r'\s*\([^)]{1,60}\)\s*$', '', original_from_li(li)).strip()
        key = title_key(candidate)
        if not candidate or len(candidate) > 160:
            continue
        group = country_group(li)
        if key in by_key:
            # Retain the first spelling and position, but do not lose useful
            # flag metadata that only appears on a duplicate alias.
            if group:
                by_key[key]['country_orders'].setdefault(group, order)
            continue
        group_orders = {group: order} if group else {}
        entry = {'title': candidate, 'key': key, 'country_orders': group_orders}
        by_key[key] = entry
        candidates.append(entry)
    return candidates


def first_country_candidate(candidates, group):
    """Find a country-tagged title by its true (pre-deduplication) position."""
    matches = [candidate for candidate in candidates if group in candidate['country_orders']]
    return min(matches, key=lambda candidate: candidate['country_orders'][group], default=None)


def repair_legacy_originals(db: dict) -> int:
    """Repair already imported values without a fresh request to ČSFD."""
    fixed = 0
    for item in db.get('media', []):
        previous = item.get('original')
        if isinstance(previous, str):
            cleaned = clean_original(previous)
            if cleaned != previous:
                item['original'] = cleaned
                fixed += 1
    return fixed


def parse_csfd(html: str, url: str):
    """Parse a single ČSFD overview response. Empty values are never invented."""
    low = html[:70000].lower()
    if any(needle in low for needle in ('protected by botstopper', 'anubis', 'access denied:', 'captcha')):
        raise ValueError('ČSFD požadavek zablokovalo ochranou proti botům')
    soup = BeautifulSoup(html, 'html.parser')
    candidates = alternative_titles(soup)
    name = first_text(soup, ['.film-header-name > h1', '.film-header-name h1', 'h1.film-title-name', 'h1'])
    if not name:
        for group in ('czech', 'slovak', 'english'):
            match = first_country_candidate(candidates, group)
            if match:
                name = match['title']
                break
        if not name and candidates:
            name = candidates[0]['title']
        if not name:
            og = soup.select_one('meta[property="og:title"]')
            name = (og.get('content') or '').strip() if og else ''
            name = re.sub(r'\s*\(\d{4}\).*$', '', name)
    if not name or name.lower() in ('oh noes!', 'access denied'):
        raise ValueError('ČSFD nevrátilo rozpoznatelnou stránku filmu')
    info = first_text(soup, ['.film-info-content > .origin', '.film-info-content .origin', 'p.origin'])
    header = first_text(soup, ['.film-header-name', '.film-header', 'header.film-header'])
    type_markers = first_text(soup, ['.film-header-name .film-type', '.film-header-name .type', '.film-header-type', '.film-info-content .film-type'])
    # Look for genuine schema.org TVSeries / Movie structured metadata first.
    schema_type = ''
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            obj = json.loads(script.string or script.get_text())
            nodes = obj.get('@graph', [obj]) if isinstance(obj, dict) else obj if isinstance(obj, list) else []
            for node in nodes:
                if isinstance(node, dict) and node.get('@type'):
                    ty = node['@type']
                    ty = ' '.join(ty) if isinstance(ty, list) else str(ty)
                    if 'TVSeries' in ty or 'Movie' in ty:
                        schema_type = ty
                        break
        except (ValueError, TypeError):
            pass
    media_type = 'series' if ('TVSeries' in schema_type or SERIES_WORD.search(type_markers) or SERIES_WORD.search(header)) else 'movie'
    genre_el = soup.select_one('.film-info-content > .genres, .film-info-content .genres, p.genres')
    genre_line = text(genre_el)
    genres = []
    parts = re.split(r'\s*/\s*|\s*[,|]\s*', genre_line)
    if len(parts) == 1 and genre_el and len(genre_el.select('a')) > 1:
        # Some layouts omit visual separators between linked genres.
        parts = [text(link) for link in genre_el.select('a')]
        remaining = BeautifulSoup(str(genre_el), 'html.parser')
        for link in remaining.select('a'):
            link.decompose()
        # Also retain unlinked genres, e.g. Komedie / Sportovní.
        parts += re.split(r'\s*/\s*|\s*[,|]\s*', text(remaining))
    for name_part in parts:
        value = name_part.strip(' .\xa0')
        if value and value not in genres and len(value) < 50:
            genres.append(value)
    year_match = YEAR.search(info)
    if not year_match:
        year_match = YEAR.search(first_text(soup, ['.film-header-name', '.film-header']))
    year = int(year_match.group()) if year_match else None
    duration_match = re.search(r'(?<!\d)(\d{1,4})\s*min(?:\.|\b)', info, flags=re.I)
    duration = int(duration_match.group(1)) if duration_match and media_type == 'movie' else None
    score_raw = first_text(soup, ['.box-rating .film-rating-average', '.film-rating-average', '.film-rating-average strong', '[itemprop="ratingValue"]'])
    percent = PERCENT.search(score_raw)
    rating = int(percent.group(1)) if percent else None
    # Episodes/seasons are only included when explicitly indicated on the page.
    seasons = episodes = None
    if media_type == 'series':
        for heading in soup.select('.box-header h3, h2, h3'):
            heading_text = text(heading)
            em = re.search(r'\bEpizody\b\s*\(?\s*(\d{1,5})\b', heading_text, re.I)
            sm = re.search(r'\bS[eé]rie\b\s*\(?\s*(\d{1,4})\b', heading_text, re.I)
            if em and episodes is None:
                episodes = int(em.group(1))
            if sm and seasons is None:
                seasons = int(sm.group(1))
        ep_in_origin = re.search(r'(?<!\d)(\d{1,5})\s*[x×]\s*\d+\s*min', info, re.I)
        if ep_in_origin and episodes is None:
            episodes = int(ep_in_origin.group(1))
    title_identity = title_key(name)
    distinct = [candidate for candidate in candidates if candidate['key'] != title_identity]
    original_match = first_country_candidate(distinct, 'english')
    if not original_match and distinct:
        original_match = distinct[0]
    original = original_match['title'] if original_match else ''
    return {
        'type': media_type, 'title': name, 'original': original,
        'year': year, 'duration': duration, 'seasons': seasons, 'episodes': episodes,
        'genres': genres[:12],
        'ratings': {'csfd': {'value': rating, 'max': 100}} if rating is not None else {},
    }


def api_json(session, url, **kwargs):
    r = session.get(url, timeout=15, **kwargs)
    r.raise_for_status()
    return r.json()


def matched_title(name, candidates):
    norm = lambda s: ''.join(c for c in unicodedata.normalize('NFKD', (s or '').lower()) if not unicodedata.combining(c) and c.isalnum())
    a = norm(name)
    return max((SequenceMatcher(None, a, norm(t)).ratio() for t in candidates if t), default=0.0)


def enrich_tmdb(session, item, bearer, api_key):
    if not bearer and not api_key or not item.get('title'):
        return None
    endpoint = 'tv' if item['type'] == 'series' else 'movie'
    token = {'Authorization': f'Bearer {bearer}'} if bearer else {}
    credentials = {} if bearer else {'api_key': api_key}
    query = item['title']
    found = api_json(session, f'https://api.themoviedb.org/3/search/{endpoint}', params={'query':query,'language':'cs-CZ', **credentials}, headers=token)
    candidates = []
    for entry in found.get('results', []):
        score = matched_title(query, [entry.get('title'),entry.get('name'),entry.get('original_title'),entry.get('original_name')])
        d = entry.get('release_date') or entry.get('first_air_date') or ''
        year = as_number(d[:4])
        # Strict automatic matching prevents silently attaching ratings to another film.
        if score < .83 or (item.get('year') and (year is None or abs(item['year'] - year) > 1)):
            continue
        candidates.append((score, entry))
    if not candidates:
        return 'TMDB: nebyla nalezena dostatečně jistá shoda'
    candidates.sort(key=lambda x: x[0], reverse=True)
    if len(candidates) > 1 and candidates[0][0] - candidates[1][0] < .06:
        return 'TMDB: více podobných výsledků, žádný nebyl automaticky přiřazen'
    tmdb_id = candidates[0][1]['id']
    result = api_json(session, f'https://api.themoviedb.org/3/{endpoint}/{tmdb_id}', params={'language':'cs-CZ','append_to_response':'external_ids', **credentials}, headers=token)
    item['links']['tmdb'] = f'https://www.themoviedb.org/{endpoint}/{tmdb_id}'
    item.setdefault('externalIds', {})['tmdb'] = str(tmdb_id)
    item.setdefault('sources', {})['tmdb'] = {
        'syncedAt': now_utc(),
        'expiresAt': (datetime.now(timezone.utc) + timedelta(days=180)).strftime(DATE_FMT),
    }
    if not item.get('original'):
        item['original'] = result.get('original_title') or result.get('original_name') or ''
    if not item.get('year'):
        date = result.get('release_date') or result.get('first_air_date') or ''
        item['year'] = as_number(date[:4])
    if not item.get('duration') and item['type'] == 'movie':
        item['duration'] = as_number(result.get('runtime'))
    if item['type'] == 'series':
        item['seasons'] = item.get('seasons') or as_number(result.get('number_of_seasons'))
        item['episodes'] = item.get('episodes') or as_number(result.get('number_of_episodes'))
    if not item.get('genres'):
        item['genres'] = [g['name'] for g in result.get('genres', []) if g.get('name')]
    if not item.get('overview'):
        item['overview'] = result.get('overview') or ''
    rating = result.get('vote_average')
    if isinstance(rating, (int, float)) and 0 < rating <= 10 and result.get('vote_count', 0) > 0:
        item['ratings']['tmdb'] = {'value': round(float(rating), 1), 'max': 10}
    imdb_id = (result.get('external_ids') or {}).get('imdb_id') or result.get('imdb_id')
    if isinstance(imdb_id, str) and re.fullmatch(r'tt\d{7,10}', imdb_id):
        item['externalIds']['imdb'] = imdb_id
        item['links']['imdb'] = f'https://www.imdb.com/title/{imdb_id}/'
    return None


def enrich_omdb(session, item, key):
    if not key or not item.get('externalIds', {}).get('imdb'):
        return None
    data = api_json(session, 'https://www.omdbapi.com/', params={'apikey': key, 'i':item['externalIds']['imdb']})
    if data.get('Response') == 'False':
        return f'OMDb: {data.get("Error", "bez výsledku")}'
    item.setdefault('sources', {})['omdb'] = {'syncedAt':now_utc()}
    try:
        val = float(data.get('imdbRating', 'nan'))
        if 0 <= val <= 10:
            item['ratings']['imdb'] = {'value': val, 'max': 10}
    except ValueError:
        pass
    try:
        val = int(data.get('Metascore', 'N/A'))
        if 0 <= val <= 100:
            item['ratings']['metacritic'] = {'value': val, 'max': 100}
    except ValueError:
        pass
    for source in data.get('Ratings', []):
        if source.get('Source') == 'Rotten Tomatoes':
            found = PERCENT.search(source.get('Value', ''))
            if found:
                item['ratings']['rt'] = {'value': int(found.group(1)), 'max': 100}
    return None


def empty_db():
    return {'format':'cinelist-library','version':1,'media':[]}


def load_db(path):
    if not path.exists():
        return empty_db()
    db = json.loads(path.read_text(encoding='utf-8'))
    if db.get('format') != 'cinelist-library' or db.get('version') != 1 or not isinstance(db.get('media'), list):
        raise ValueError('Soubor private/movies.json nemá očekávaný formát.')
    return db


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.cinelist-', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def merge_item(old, fresh):
    if not old:
        return fresh
    result = dict(old)
    for field in ('type','title','original','year','duration','seasons','episodes','genres','overview'):
        value = fresh.get(field)
        if value is not None and value != '' and value != []:
            result[field] = value
    for field in ('links','externalIds','ratings','sources'):
        result[field] = {**old.get(field, {}), **fresh.get(field, {})}
        if field == 'ratings':
            result[field] = {k:v for k,v in result[field].items() if not v.get('sample') or k not in fresh.get('ratings', {})}
    return result


def retrieve_csfd(session, url):
    # Exactly one direct request to ČSFD per new/refresh URL.
    r = session.get(url, timeout=18, headers={'User-Agent': UA, 'Accept-Language':'cs-CZ,cs;q=0.9'})
    if r.status_code in (401, 403, 429, 503):
        raise ValueError(f'ČSFD odmítlo požadavek (HTTP {r.status_code})')
    r.raise_for_status()
    if 'text/html' not in r.headers.get('Content-Type', 'text/html'):
        raise ValueError('ČSFD neposlalo HTML stránku')
    if len(r.content) > 3_000_000:
        raise ValueError('Stránka ČSFD je nečekaně velká')
    return parse_csfd(r.text, url)


def run_import(links, ignored, out, report_path, refresh=False, delay=4.5, session=None, tmdb_bearer='', tmdb_key='', omdb_key='', fetcher=None, on_event=None):
    root = Path(__file__).resolve().parents[1]
    for target in (out, report_path):
        resolved = target.resolve()
        if resolved.is_relative_to(root) and not resolved.is_relative_to(root / 'private'):
            raise ValueError('Nezašifrovaná data a report smějí být uvnitř projektu pouze v private/!')
    db = load_db(out)
    repaired = repair_legacy_originals(db)
    if repaired:
        db['updatedAt'] = now_utc()
        atomic_json(out, db)
    by_id = {item['id']: i for i, item in enumerate(db['media'])}
    seen = set()
    unique = []
    for url in links:
        csfd_id = re.match(r'https://www\.csfd\.cz/film/(\d+)', url).group(1)
        if csfd_id in seen:
            continue
        unique.append((url, csfd_id))
        seen.add(csfd_id)
    summary = {'startedAt':now_utc(), 'total':len(unique), 'duplicatesInInput': len(links)-len(unique), 'ignored':ignored, 'added':0, 'updated':0, 'skipped':0, 'failed':[], 'warnings':[], 'originalsRepaired':repaired}
    http = session or requests.Session()
    def announce(message, *, stage=None, index=None):
        print(message, flush=True)
        if on_event:
            on_event({'message': message, 'stage': stage, 'index': index, 'total':len(unique)})
    last_csfd_call = None
    for i,(url,csfd_id) in enumerate(unique,1):
        id_ = f'csfd-{csfd_id}'
        old = db['media'][by_id[id_]] if id_ in by_id else None
        if old and not refresh and old.get('sources',{}).get('csfd',{}).get('syncedAt'):
            summary['skipped'] += 1
            announce(f'[{i}/{len(unique)}] PŘESKOČENO {url} (již importováno)', stage='skipped', index=i)
            continue
        if last_csfd_call is not None and delay > 0:
            time.sleep(max(0, delay - (time.monotonic()-last_csfd_call)))
        announce(f'[{i}/{len(unique)}] Stahuji {url}', stage='loading', index=i)
        last_csfd_call = time.monotonic()
        try:
            fields = (fetcher or retrieve_csfd)(http, url)
            item = {
                'id': id_, 'type': fields['type'], 'title': fields['title'],
                'original': fields.get('original',''), 'year':fields.get('year'),
                'duration':fields.get('duration'), 'seasons':fields.get('seasons'), 'episodes':fields.get('episodes'),
                'status': 'watchlist' if fields['type']=='movie' else 'download',
                'genres':fields.get('genres', []), 'ratings':fields.get('ratings', {}),
                'links':{'csfd':url}, 'overview': '',
                'sources':{'csfd': {'syncedAt':now_utc()}},
            }
            if tmdb_bearer or tmdb_key:
                try:
                    warning = enrich_tmdb(http, item, tmdb_bearer, tmdb_key)
                    if warning:
                        summary['warnings'].append(f'{url}: {warning}')
                except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                    summary['warnings'].append(f'{url}: TMDB nebylo dostupné ({type(e).__name__})')
            if omdb_key:
                try:
                    warning = enrich_omdb(http, item, omdb_key)
                    if warning:
                        summary['warnings'].append(f'{url}: {warning}')
                except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                    summary['warnings'].append(f'{url}: OMDb nebylo dostupné ({type(e).__name__})')
            merged = merge_item(old, item)
            if old:
                db['media'][by_id[id_]] = merged
                summary['updated'] += 1
            else:
                by_id[id_] = len(db['media'])
                db['media'].append(merged)
                summary['added'] += 1
            db['updatedAt'] = now_utc()
            atomic_json(out, db)
            announce(f'  ✓ {merged["title"]} · {merged.get("year") or "?"} · {", ".join(merged.get("genres") or []) or "bez žánrů"}', stage='saved', index=i)
        except (requests.RequestException, ValueError, KeyError, TypeError) as e:
            summary['failed'].append({'url':url,'reason':str(e)[:240]})
            announce(f'  ✗ Nepodařilo se importovat: {e}', stage='failed', index=i)
        finally:
            summary['finishedAt'] = now_utc()
            atomic_json(report_path, summary)
    announce(f'Hotovo: přidáno {summary["added"]}, aktualizováno {summary["updated"]}, vynecháno {summary["skipped"]}, chyb {len(summary["failed"])}.', stage='done', index=len(unique))
    announce(f'Report: {report_path}. Nezašifrovaná knihovna: {out}.', stage='done', index=len(unique))
    return summary


def main():
    p = argparse.ArgumentParser(description='Importuj pouze ČSFD URL z CSV nebo prostého textu, automaticky načti metadata a ulož lokálně.')
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--csv', type=Path, help='CSV s ČSFD odkazy v libovolném sloupci')
    group.add_argument('--txt', type=Path, help='TXT s jednou URL ČSFD na řádek; - znamená stdin')
    p.add_argument('--out', type=Path, default=Path('private/movies.json'))
    p.add_argument('--report', type=Path, default=Path('private/last-import.json'))
    p.add_argument('--refresh', action='store_true', help='Znovu načti i již úspěšně importované záznamy')
    p.add_argument('--delay', type=float, default=4.5, help='Sekundy mezi požadavky na ČSFD (výchozí 4,5)')
    args = p.parse_args()
    if args.delay < 0:
        p.error('--delay musí být nezáporné')
    try:
        links, ignored = scan_csv_file(args.csv) if args.csv else scan_text_file(args.txt)
        if not links:
            p.error('V souboru nebyla nalezena žádná platná URL ČSFD')
        result = run_import(links, ignored, args.out, args.report, args.refresh, args.delay,
                            tmdb_bearer=os.environ.get('TMDB_BEARER', ''), tmdb_key=os.environ.get('TMDB_API_KEY',''),
                            omdb_key=os.environ.get('OMDB_API_KEY',''))
        if result['failed']:
            sys.exit(2)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        p.error(str(e))

if __name__ == '__main__':
    main()
