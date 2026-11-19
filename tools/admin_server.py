#!/usr/bin/env python3
"""Local-only visual importer for CINELIST. Never expose on the internet."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading

from import_csfd import run_import, scan_csv, scan_text

ROOT = Path(__file__).resolve().parents[1]
TOOL = Path(__file__).resolve().parent


class LocalAdmin(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, addr, handler):
        super().__init__(addr, handler)
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.job = {'status':'idle','events':[], 'progress':0, 'total':0,'summary':None}
        self.out = ROOT/'private/movies.json'
        self.report = ROOT/'private/last-import.json'

    def update(self, **fields):
        with self.lock:
            self.job.update(fields)

    def read_status(self):
        with self.lock:
            return json.loads(json.dumps(self.job, ensure_ascii=False))

    def add_event(self, event):
        with self.lock:
            self.job['events'] = (self.job['events']+[event['message']])[-100:]
            if event.get('index') is not None:
                self.job['progress'] = max(0, event['index'] - (1 if event.get('stage') == 'loading' else 0))
            if event.get('total') is not None:
                self.job['total'] = event['total']

    def start_import(self, mode, contents, refresh):
        if mode not in ('txt','csv') or not isinstance(contents,str) or len(contents) > 1500000 or not isinstance(refresh,bool):
            return False, 'Povoleno je pouze CSV nebo prostý text s ČSFD URL.'
        links,ignored = scan_csv(contents) if mode=='csv' else scan_text(contents)
        if not links:
            return False, 'Ve vstupu nebyla nalezena platná URL filmu/seriálu na ČSFD.'
        with self.lock:
            if self.job['status']=='running':
                return False, 'Předchozí import stále běží.'
            self.job={'status':'running','events':[], 'progress':0, 'total':len(set(links)), 'summary':None}
        def worker():
            try:
                # No env/API values are sent from the browser or written to the public folder.
                import os
                summary=run_import(links, ignored, self.out, self.report, refresh=refresh,
                    tmdb_bearer=os.environ.get('TMDB_BEARER',''),tmdb_key=os.environ.get('TMDB_API_KEY',''),
                    omdb_key=os.environ.get('OMDB_API_KEY',''),on_event=self.add_event)
                self.update(status='finished', summary=summary)
            except Exception as e:
                self.add_event({'message':f'Import přerušen: {type(e).__name__}: {str(e)[:220]}', 'stage':'error'})
                self.update(status='error')
        threading.Thread(target=worker, daemon=True).start()
        return True, 'Import spuštěn.'


class Handler(BaseHTTPRequestHandler):
    server: LocalAdmin

    def allowed_host(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')

    def authorized(self):
        return self.headers.get('X-CINELIST-LOCAL-KEY') == self.server.token

    def write(self, status, data, content_type):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def json(self, status, data):
        self.write(status,json.dumps(data,ensure_ascii=False).encode('utf-8'),'application/json; charset=utf-8')

    def check_host(self):
        if not self.allowed_host():
            self.json(403,{'error':'Nepovolená adresa.'})
            return False
        return True

    def do_GET(self):
        if not self.check_host():return
        if self.path in ('/','/index.html'):
            data=(TOOL/'admin.html').read_text(encoding='utf-8').replace('%%LOCAL_TOKEN%%',self.server.token)
            self.write(200,data.encode('utf-8'),'text/html; charset=utf-8')
        elif self.path in ('/admin.css','/admin.js'):
            name=self.path[1:]
            media='text/css; charset=utf-8' if name.endswith('.css') else 'text/javascript; charset=utf-8'
            self.write(200,(TOOL/name).read_bytes(),media)
        elif self.path=='/api/status':
            if not self.authorized():return self.json(403,{'error':'Nepovolený přístup.'})
            self.json(200,self.server.read_status())
        else:
            self.json(404,{'error':'Nenalezeno.'})

    def do_POST(self):
        if not self.check_host():return
        expected=(f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}')
        if self.headers.get('Origin') not in expected or not self.authorized():
            return self.json(403,{'error':'Nepovolený přístup.'})
        if self.path!='/api/import':return self.json(404,{'error':'Nenalezeno.'})
        if not self.headers.get('Content-Type','').startswith('application/json'):
            return self.json(415,{'error':'Očekávám JSON.'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size < 2 or size > 2_000_000:
                return self.json(413,{'error':'Soubor je příliš velký.'})
            payload=json.loads(self.rfile.read(size))
            ok,msg=self.server.start_import(payload.get('mode'),payload.get('content'),payload.get('refresh',False))
            self.json(202 if ok else 400,{'message':msg})
        except (ValueError,UnicodeDecodeError,AttributeError) as e:
            self.json(400,{'error':f'Neplatný vstup: {type(e).__name__}'})


def main():
    p=argparse.ArgumentParser(description='Soukromá lokální administrační stránka, pouze 127.0.0.1')
    p.add_argument('--port',type=int,default=8765)
    args=p.parse_args()
    with LocalAdmin(('127.0.0.1',args.port),Handler) as server:
        print(f'CINELIST lokální import: http://127.0.0.1:{server.server_port}/',flush=True)
        print('Přístup je povolen pouze z tohoto počítače. Ukončíš Ctrl+C.',flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass

if __name__=='__main__':main()
