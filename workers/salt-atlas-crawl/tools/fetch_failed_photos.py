#!/usr/bin/env python3
"""Fetch the photos the Worker couldn't download, from this computer's internet connection.

Some resort websites refuse requests from Cloudflare's servers (HTTP 520 or 403), so the 06:30 photo
download marks those photos 'failed'. This script downloads them from your computer instead, uploads
each one to the R2 bucket under the same key, and marks it 'ok', so the next staging run and the
Worker's /photo/<key> address use the copy.

Run it in the salt-atlas-crawl folder, after `npx wrangler login`:
    python3 tools/fetch_failed_photos.py            # every failed photo
    python3 tools/fetch_failed_photos.py tengirri.com resortlatitudezero.com   # only these resorts

Needs: Python 3.9+, curl (built into macOS and Windows 10+) and Node (for npx wrangler). No other packages.
"""
import json, os, re, subprocess, sys, tempfile

DB, BUCKET = 'salt-atlas-scrape', 'salt-atlas-scrape'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
MAX_BYTES = 15 * 1024 * 1024


def wrangler(*args):
    return subprocess.run(['npx', 'wrangler', *args], capture_output=True, text=True)


def d1(sql):
    r = wrangler('d1', 'execute', DB, '--remote', '--json', '--command', sql)
    if r.returncode:
        sys.exit('Database query failed. Run `npx wrangler login` first.\n' + r.stderr[-800:])
    data = json.loads(r.stdout)
    return data[0]['results'] if isinstance(data, list) else data['results']


def download(url, path):
    """Download with curl, which uses the computer's own certificate store (Python from python.org on a
    Mac has none until 'Install Certificates' is run). Returns the content type."""
    origin = re.match(r'https?://[^/]+/', url).group(0)
    r = subprocess.run(['curl', '-sSL', '--max-time', '60', '--max-filesize', str(MAX_BYTES), '-A', UA, '-e', origin,
                        '-H', 'Accept: image/*', '-o', path, '-w', '%{http_code} %{content_type}', url],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:120] or f'curl exit {r.returncode}')
    code, _, ctype = r.stdout.strip().partition(' ')
    if not code.startswith('2'):
        raise RuntimeError(f'HTTP {code}')
    return ctype.split(';')[0].strip()


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    only = sys.argv[1:]
    where = "status = 'failed'" + (f" AND prospect_id IN ({','.join(q(p) for p in only)})" if only else '')
    rows = d1(f'SELECT url, key, prospect_id FROM photo_mirror WHERE {where} ORDER BY prospect_id')
    if not rows:
        print('No failed photos. Nothing to do.')
        return
    print(f'{len(rows)} photo(s) to fetch.')
    ok, bad = 0, []
    with tempfile.TemporaryDirectory() as tmp:
        for r in rows:
            url, key, who = r['url'], r['key'], r['prospect_id']
            try:
                path = os.path.join(tmp, key)
                ctype = download(url, path)
                size = os.path.getsize(path)
                if not ctype.startswith('image/'):
                    raise ValueError(f'not an image ({ctype or "no type"})')
                if size > MAX_BYTES or size < 2000:
                    raise ValueError(f'unexpected size ({size} bytes)')
                up = wrangler('r2', 'object', 'put', f'{BUCKET}/photos/{key}', '--file', path, '--content-type', ctype,
                              '--cache-control', 'public, max-age=31536000, immutable', '--remote')
                if up.returncode:
                    raise RuntimeError('upload failed: ' + up.stderr.strip()[-200:])
                d1(f"UPDATE photo_mirror SET status = 'ok', bytes = {size}, content_type = {q(ctype)}, error = NULL, "
                   f"fetched_at = datetime('now') WHERE url = {q(url)}")
                ok += 1
                print(f'  ok    {who}  {url[:90]}')
            except Exception as e:  # keep going; report at the end
                bad.append((who, url, str(e)[:120]))
                print(f'  FAIL  {who}  {url[:90]}  ({str(e)[:80]})')
    print(f'\nDone: {ok} fetched, {len(bad)} failed.')
    if bad:
        print('Still failing (the site may block downloads entirely: ask the resort to send these photos):')
        for who, url, err in bad:
            print(f'  {who}: {url}  [{err}]')


if __name__ == '__main__':
    main()
