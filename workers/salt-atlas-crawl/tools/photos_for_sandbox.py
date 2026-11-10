#!/usr/bin/env python3
"""Zip the photos of the pages under review, so they can be attached to a Claude chat and put
into the Salt Atlas Destinations sandbox (which can't load photos from other websites).

Run it in the salt-atlas-crawl folder, after `npx wrangler login`:
    python3 tools/photos_for_sandbox.py
It writes ~/Downloads/sandbox-photos.zip: every downloaded photo of the ready and staged pages, named
<key> as in photo_mirror, photos.json mapping each original photo address to its file, and the page
files themselves (pages/<slug>.json, with pages/notes.json holding what to check on each).

Needs: Python 3.9+, curl and Node (for npx wrangler). No other packages.
"""
import json, os, subprocess, sys, tempfile, zipfile

DB = 'salt-atlas-scrape'
WORKER = 'https://salt-atlas-crawl.accounts-c6e.workers.dev'
OUT = os.path.expanduser('~/Downloads/sandbox-photos.zip')


def d1(sql):
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit('Database query failed. Run `npx wrangler login` first.\n' + r.stderr[-800:])
    data = json.loads(r.stdout)
    return data[0]['results'] if isinstance(data, list) else data['results']


def main():
    rows = d1("SELECT m.url, m.key FROM photo_mirror m WHERE m.status = 'ok' AND EXISTS "
              "(SELECT 1 FROM page_drafts d WHERE d.prospect_id = m.prospect_id AND d.status IN ('ready', 'built'))")
    print(f'{len(rows)} photo(s) to zip.')
    mapping, bad = {}, []
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(OUT, 'w', zipfile.ZIP_STORED) as z:
        for r in rows:
            path = os.path.join(tmp, r['key'])
            c = subprocess.run(['curl', '-sSf', '--max-time', '60', '-o', path, f"{WORKER}/photo/{r['key']}"],
                               capture_output=True, text=True)
            if c.returncode or not os.path.exists(path):
                bad.append(r['url'])
                print(f"  FAIL  {r['key']}  {c.stderr.strip()[:80]}")
                continue
            z.write(path, r['key'])
            mapping[r['url']] = r['key']
        z.writestr('photos.json', json.dumps(mapping, indent=1))
        pages = d1("SELECT slug, kit_json, notes FROM page_drafts WHERE status IN ('ready', 'built') AND kit_json <> '{}'")
        for p in pages:
            z.writestr(f"pages/{p['slug']}.json", p['kit_json'])
        z.writestr('pages/notes.json', json.dumps({p['slug']: p['notes'] for p in pages}, indent=1))
    print(f'\nDone: {len(mapping)} photos and {len(pages)} page files in {OUT}' + (f', {len(bad)} photos failed' if bad else '') + '.')
    print('Attach that zip to the Claude chat.')


if __name__ == '__main__':
    main()
