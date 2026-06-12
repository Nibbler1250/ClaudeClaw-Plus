#!/usr/bin/env python3
"""Re-applique classify() sur les rows existantes en DB et UPDATE category si différent."""
import sqlite3
import sys
import importlib.util
from pathlib import Path

DB = Path("/home/simon/agent/data/archiviste-index.db")
INV = Path("/home/simon/agent/scripts/archiviste-inventory.py")

spec = importlib.util.spec_from_file_location("inv", INV)
inv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inv)

dry_run = "--apply" not in sys.argv

conn = sqlite3.connect(DB)
rows = conn.execute("SELECT id, filename, ext, category FROM files").fetchall()

changes = {}  # (old, new) -> count
sample = {}   # (old, new) -> [filenames...]
to_update = []

for fid, fname, ext, current in rows:
    new = inv.classify(fname, ext)
    if new != current:
        key = (current, new)
        changes[key] = changes.get(key, 0) + 1
        sample.setdefault(key, []).append(fname)
        to_update.append((new, fid))

print(f"Total rows analysés : {len(rows)}")
print(f"Changements détectés: {len(to_update)}")
print()
print(f"{'OLD':<12} {'NEW':<12} {'COUNT':>7}")
print("-" * 35)
for (old, new), n in sorted(changes.items(), key=lambda x: -x[1]):
    print(f"{old:<12} {new:<12} {n:>7}")
print()
print("Échantillons (max 5 par transition):")
for key, files in sorted(sample.items(), key=lambda x: -changes[x[0]]):
    old, new = key
    print(f"\n  {old} -> {new}:")
    for f in files[:5]:
        print(f"    - {f}")

if dry_run:
    print("\n[DRY-RUN] Pas d'UPDATE. Relancer avec --apply pour appliquer.")
else:
    print(f"\n[APPLY] UPDATE de {len(to_update)} rows...")
    cur = conn.cursor()
    cur.executemany("UPDATE files SET category=? WHERE id=?", to_update)
    new_tags_rows = conn.execute(
        "SELECT id, filename, category FROM files WHERE category IN ('impot', 'facture')"
    ).fetchall()
    tag_updates = [(inv.get_tags(fname, cat), fid) for fid, fname, cat in new_tags_rows]
    cur.executemany("UPDATE files SET tags=? WHERE id=?", tag_updates)
    conn.commit()
    print(f"✅ {len(to_update)} categories + {len(tag_updates)} tags refresh.")

conn.close()
