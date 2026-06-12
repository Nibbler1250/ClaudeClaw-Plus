#!/usr/bin/env python3
"""
Archiviste — Extraction EXIF + reverse-geocoding pour photos/vidéos/screenshots
Incrémental : skip si déjà traité dans la table photo_metadata.
"""
import os, sys, sqlite3, argparse
from datetime import datetime
from PIL import Image
from PIL.ExifTags import TAGS, GPSTAGS
import reverse_geocoder as rg

DB_PATH = '/home/simon/agent/data/archiviste-index.db'
LOG_PATH = '/home/simon/agent/logs/archiviste-photo-meta.log'

def log(msg):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    try:
        with open(LOG_PATH, 'a') as f: f.write(line + '\n')
    except: pass

def init_schema(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS photo_metadata (
            file_id INTEGER PRIMARY KEY,
            taken_at TEXT, make TEXT, model TEXT, orientation INTEGER,
            width INTEGER, height INTEGER,
            gps_lat REAL, gps_lon REAL, gps_alt REAL,
            city TEXT, region TEXT, country TEXT,
            subtype TEXT, extracted_at TEXT,
            FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_photo_taken ON photo_metadata(taken_at)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_photo_city ON photo_metadata(city)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_photo_subtype ON photo_metadata(subtype)')
    conn.commit()

def to_float(v):
    try:
        if hasattr(v, 'numerator'): return float(v)
        return float(v[0]) / float(v[1])
    except Exception:
        try: return float(v)
        except: return None

def dms_to_decimal(dms, ref):
    try:
        d, m, s = to_float(dms[0]), to_float(dms[1]), to_float(dms[2])
        if None in (d, m, s): return None
        dec = d + m/60 + s/3600
        return -dec if ref in ('S', 'W') else dec
    except Exception:
        return None

def extract_exif(path):
    try:
        with Image.open(path) as img:
            width, height = img.size
            exif = img._getexif() or {}
    except Exception as e:
        return {'error': str(e)}
    r = {'width': width, 'height': height}
    gps = None
    for tid, val in exif.items():
        tag = TAGS.get(tid, tid)
        if tag == 'DateTimeOriginal' and val:
            r['taken_at'] = str(val).replace(':', '-', 2).replace(' ', 'T')
        elif tag == 'Make': r['make'] = str(val).strip()
        elif tag == 'Model': r['model'] = str(val).strip()
        elif tag == 'Orientation':
            try: r['orientation'] = int(val)
            except: pass
        elif tag == 'GPSInfo': gps = val
    if gps:
        g = {GPSTAGS.get(k, k): v for k, v in gps.items()}
        lat = dms_to_decimal(g.get('GPSLatitude'), g.get('GPSLatitudeRef'))
        lon = dms_to_decimal(g.get('GPSLongitude'), g.get('GPSLongitudeRef'))
        if lat is not None and lon is not None:
            r['gps_lat'], r['gps_lon'] = lat, lon
            alt = g.get('GPSAltitude')
            if alt is not None: r['gps_alt'] = to_float(alt)
    return r

def detect_subtype(path, ext):
    p = path.lower()
    if '/screenshots/' in p or 'screenshot' in os.path.basename(p):
        return 'screenshot'
    if ext in ('.mp4', '.mov', '.avi', '.mkv'):
        return 'video'
    return 'photo'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--sample', type=int, default=0)
    args = ap.parse_args()
    if args.sample: args.dry_run = True

    conn = sqlite3.connect(DB_PATH)
    init_schema(conn)
    q = '''SELECT f.id, f.path, f.ext FROM files f
           LEFT JOIN photo_metadata pm ON pm.file_id = f.id
           WHERE f.category = 'photo' AND pm.file_id IS NULL'''
    if args.sample: q += f' ORDER BY RANDOM() LIMIT {args.sample}'
    elif args.limit: q += f' LIMIT {args.limit}'
    rows = conn.execute(q).fetchall()
    log(f'Photos à traiter : {len(rows)}')

    processed, coords = [], []
    for fid, path, ext in rows:
        if not os.path.exists(path): continue
        subtype = detect_subtype(path, (ext or '').lower())
        if subtype == 'video':
            data = {'subtype': subtype}
        else:
            data = extract_exif(path)
            data['subtype'] = subtype
        processed.append((fid, path, data))
        if 'gps_lat' in data and 'gps_lon' in data:
            coords.append((data['gps_lat'], data['gps_lon']))

    geo = {}
    if coords:
        log(f'Reverse-geocoding {len(coords)} coordonnées...')
        res = rg.search(coords, mode=1, verbose=False)
        for c, r in zip(coords, res): geo[c] = r

    now = datetime.now().isoformat(timespec='seconds')
    written = 0
    for fid, path, d in processed:
        c = (d.get('gps_lat'), d.get('gps_lon'))
        g = geo.get(c) if None not in c else None
        row = (fid, d.get('taken_at'), d.get('make'), d.get('model'),
               d.get('orientation'), d.get('width'), d.get('height'),
               d.get('gps_lat'), d.get('gps_lon'), d.get('gps_alt'),
               g['name'] if g else None, g['admin1'] if g else None,
               g['cc'] if g else None, d.get('subtype'), now)
        if args.dry_run:
            print(f'  {os.path.basename(path)[:50]:50} | {d.get("subtype","?"):10} | {d.get("taken_at","-"):20} | {(g or {}).get("name","-"):20} | {d.get("model","-")}')
            continue
        conn.execute('INSERT OR REPLACE INTO photo_metadata VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', row)
        written += 1
    conn.commit(); conn.close()
    log(f'Traités : {len(processed)} | Écrits : {written} | Dry-run : {args.dry_run}')

if __name__ == '__main__': main()
