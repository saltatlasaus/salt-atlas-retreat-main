#!/usr/bin/env python3
"""Turn destination page drafts into real pages on the Salt Atlas website, photos included.

Run it on a computer with internet, from anywhere, pointing at your copy of saltatlas-website:

    python3 pull_pages.py --site ~/code/saltatlas-website                 # every draft marked 'ready' in D1
    python3 pull_pages.py --site ~/code/saltatlas-website --json-dir drafts/   # page files in a folder instead
    python3 pull_pages.py --site ~/code/saltatlas-website --only aloita-resort

What it does, all in code (no Claude cost):
  1. Reads each page's kit JSON (from D1 page_drafts via `npx wrangler d1 execute`, or from a folder).
  2. Downloads every photo the page links to on the resort's own site, resizes it to 1800px wide,
     saves it as WebP in public/img/destinations/<md5 of the file>.webp and records it in
     tools/destinations/blobmap.json, so the page loads it from saltatlas.com (same as live pages).
  3. Writes tools/destinations/kit/resorts/<slug>.json, runs the site build and the language build.
  4. Undoes the date-only changes the build makes to other pages, so the commit holds just these pages.
  5. Marks the drafts 'built' in D1 (when they came from D1).

Then review the pages locally (python3 -m http.server -d public) and push a branch for a Cloudflare preview.
Needs: Python 3.10+, Pillow (pip install pillow), Node, and `npx wrangler login` done for the D1 step.
"""
import argparse, hashlib, io, json, os, re, subprocess, sys, urllib.request

DB = 'salt-atlas-scrape'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
MAX_W, QUALITY = 1800, 70  # same as the site's tools/images.py


def d1(sql):
    out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return data[0]['results'] if isinstance(data, list) else data['results']


def images_in(obj):
    """Every external photo URL in a kit JSON (src / poster fields)."""
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ('src', 'poster') and isinstance(v, str) and v.startswith('http') and 'saltatlas.com' not in v:
                found.append(v)
            else:
                found += images_in(v)
    elif isinstance(obj, list):
        for v in obj:
            found += images_in(v)
    return found


def to_webp(url, out_dir):
    from PIL import Image, ImageOps
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': re.match(r'https?://[^/]+/', url).group(0)})
    raw = urllib.request.urlopen(req, timeout=60).read()
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGB')
    if im.width > MAX_W:
        im = im.resize((MAX_W, round(im.height * MAX_W / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=QUALITY, method=6)
    blob = hashlib.md5(buf.getvalue()).hexdigest()
    with open(os.path.join(out_dir, blob + '.webp'), 'wb') as f:
        f.write(buf.getvalue())
    return blob, im.width, im.height


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True, help='path to your saltatlas-website checkout')
    ap.add_argument('--json-dir', help='read <slug>.json page files from this folder instead of D1')
    ap.add_argument('--only', nargs='*', help='only these slugs')
    a = ap.parse_args()
    site = os.path.abspath(os.path.expanduser(a.site))
    kit = os.path.join(site, 'tools/destinations/kit')
    img_dir = os.path.join(site, 'public/img/destinations')
    blobmap_path = os.path.join(site, 'tools/destinations/blobmap.json')

    pages, from_d1 = [], not a.json_dir
    if from_d1:
        for r in d1("SELECT prospect_id, slug, kit_json, notes FROM page_drafts WHERE status = 'ready'"):
            pages.append((r['slug'], json.loads(r['kit_json']), r['notes']))
    else:
        for f in sorted(os.listdir(a.json_dir)):
            if f.endswith('.json'):
                pages.append((f[:-5], json.load(open(os.path.join(a.json_dir, f))), None))
    if a.only:
        pages = [p for p in pages if p[0] in a.only]
    if not pages:
        print('Nothing to build.')
        return

    blobmap = json.load(open(blobmap_path))
    failed = []
    for slug, page, notes in pages:
        urls = list(dict.fromkeys(images_in(page)))
        print(f'\n{slug}: {len(urls)} photos' + (f'  (note: {notes})' if notes else ''))
        for u in urls:
            if u in blobmap and os.path.exists(os.path.join(img_dir, blobmap[u] + '.webp')):
                continue
            try:
                blob, w, h = to_webp(u, img_dir)
                blobmap[u] = blob
                print(f'  ok   {w}x{h}  {u[:90]}')
            except Exception as e:  # keep going: the page still links the original
                failed.append((slug, u, str(e)[:80]))
                print(f'  FAIL {u[:90]}  {str(e)[:60]}')
        page.setdefault('noindex', True)  # stays out of search until someone flips it
        with open(os.path.join(kit, 'resorts', slug + '.json'), 'w') as f:
            json.dump(page, f, ensure_ascii=False, indent=2)
    with open(blobmap_path, 'w') as f:
        json.dump(blobmap, f, ensure_ascii=False, indent=0)

    subprocess.run(['python3', 'tools/destinations/kit/tools/site_build.py', 'public'], cwd=site, check=True)
    subprocess.run(['python3', 'tools/i18n/i18n.py', 'build'], cwd=site, check=True)

    # The build re-stamps every page's date; keep only the pages we meant to change.
    keep = {s for s, _, _ in pages}
    changed = subprocess.run(['git', 'diff', '--name-only'], cwd=site, capture_output=True, text=True).stdout.split()
    undo = [p for p in changed if p != 'tools/destinations/blobmap.json'
            and not any(f'/{s}/' in p or p.endswith(f'/{s}.json') or p.endswith(f'/{s}.html') for s in keep)]
    if undo:
        subprocess.run(['git', 'checkout', '--'] + undo, cwd=site, check=True)

    if from_d1:
        slugs = ','.join("'" + s.replace("'", "''") + "'" for s in keep)
        d1(f"UPDATE page_drafts SET status = 'built', updated_at = datetime('now') WHERE slug IN ({slugs})")

    print(f'\nBuilt {len(pages)} page(s). Photos that could not be fetched: {len(failed)}')
    for s, u, e in failed:
        print(f'  {s}: {u}  ({e})')
    print('Preview: python3 -m http.server -d public 8000, then open http://localhost:8000/destinations/<slug>/')


if __name__ == '__main__':
    main()
