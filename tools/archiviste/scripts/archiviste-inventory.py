#!/usr/bin/env python3
"""
Archiviste — Inventaire de fichiers
Scanne local + NAS, indexe dans SQLite, détecte doublons.
"""

import os
import re
import sys
import sqlite3
import hashlib
import subprocess
import json
import time
from datetime import datetime
from pathlib import Path

DB_PATH = "/home/simon/agent/data/archiviste-index.db"
NAS_MOUNT = "/mnt/nas"
NAS_SHARE = "//192.168.1.67/Simon"
NAS_USER = "AutomationHub"
NAS_PASS = "Backup2026ProDes"
LOG_PATH = "/home/simon/agent/logs/archiviste-inventory.log"

# Sources locales à scanner
LOCAL_SOURCES = [
    "/home/simon/Documents",
    "/home/simon/Pictures",
    "/home/simon/Music",
    "/home/simon/Downloads",
    "/home/simon/Projects",
    "/home/simon/simon-memory",
    "/home/simon/Photos",
    "/home/simon/Screenshots",
    "/home/simon/automation-hub",   # added: contains fiscal/aiflow PDFs etc.
    "/home/simon/agent/data",       # added: archiviste vault, voice-log refs
]

# Extensions par catégorie
CATEGORIES = {
    "photo":     {".jpg", ".jpeg", ".png", ".heic", ".gif", ".bmp", ".tiff", ".webp", ".mp4", ".mov", ".avi", ".mkv"},
    "document":  {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md", ".odt", ".ods"},
    "musique":   {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".wma"},
    "archive":   {".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz"},
    "db":        {".db", ".sqlite", ".sqlite3"},
    "config":    {".env", ".json", ".yaml", ".yml", ".conf", ".cfg", ".ini", ".service", ".toml"},
    "code":      {".py", ".js", ".ts", ".sh", ".go", ".rs", ".java", ".cpp", ".c", ".h"},
}

INVOICE_KEYWORDS = ["invoice", "facture", "receipt", "recu", "order", "commande", "payment", "reçu"]
TAX_KEYWORDS = [
    # Feuillets fédéraux (CRA)
    "t4", "t4a", "t5", "t5008", "t3", "t776", "t2125", "co-17",
    # Feuillets Québec (Revenu Québec)
    "rl-1", "rl1", "rl-2", "rl2", "rl-3", "rl3",
    # Termes fiscaux génériques
    "impot", "impôt", "tax", "cotisation", "avis de", "avis_",
    "fiscal", "fisc_", "deduction", "déduction", "feuillet",
    "talon", "paystub",
    # Régimes enregistrés
    "reer", "celi",
    # Agences fiscales
    "cra", "arc-", "arc.", "revenu_quebec", "revenu quebec", "mrq",
    # Synthèses
    "resume_fiscal", "résumé_fiscal", "resume fiscal",
    # Patterns observés dans /automation-hub/backend/data/fiscal/
    "etatdecompte", "etat_de_compte", "etat de compte",
    "role_eval", "role eval", "roleeval",
    "custstate",  # IBKR Customer Statements (gains capital T5008)
]


def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            source TEXT NOT NULL,
            filename TEXT NOT NULL,
            ext TEXT,
            size INTEGER,
            mtime REAL,
            sha256 TEXT,
            category TEXT,
            tags TEXT,
            vectorized INTEGER DEFAULT 0,
            first_seen TEXT,
            last_seen TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sha256 ON files(sha256)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_category ON files(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_source ON files(source)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS scan_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_date TEXT,
            source TEXT,
            files_found INTEGER,
            files_new INTEGER,
            files_updated INTEGER,
            duration_sec REAL
        )
    """)
    conn.commit()


_TAX_PATTERNS = [re.compile(r'(?<![a-z])' + re.escape(k), re.IGNORECASE) for k in TAX_KEYWORDS]
_INVOICE_PATTERNS = [re.compile(r'(?<![a-z])' + re.escape(k), re.IGNORECASE) for k in INVOICE_KEYWORDS]


def _read_content(filepath, ext, max_bytes=200 * 1024) -> str:
    """Extrait les premiers caractères d'un fichier texte ou PDF pour la classification."""
    try:
        size = os.path.getsize(filepath)
        if size > 20 * 1024 * 1024:  # skip > 20MB
            return ""
        if ext == ".txt" and size < max_bytes:
            with open(filepath, "r", errors="replace") as f:
                return f.read(5000)
        if ext == ".pdf":
            result = subprocess.run(
                ["pdftotext", "-l", "3", filepath, "-"],  # 3 premières pages suffisent
                capture_output=True, text=True, timeout=10
            )
            return result.stdout[:5000] if result.returncode == 0 else ""
    except Exception:
        pass
    return ""


def classify(filename, ext, filepath=None):
    name_lower = filename.lower()
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            if cat == "document":
                for pat in _INVOICE_PATTERNS:
                    if pat.search(name_lower):
                        return "facture"
                for pat in _TAX_PATTERNS:
                    if pat.search(name_lower):
                        return "impot"
                # Nom générique → lire le contenu pour affiner la classification
                if filepath:
                    content = _read_content(filepath, ext)
                    if content:
                        for pat in _TAX_PATTERNS:
                            if pat.search(content):
                                return "impot"
                        for pat in _INVOICE_PATTERNS:
                            if pat.search(content):
                                return "facture"
            return cat
    return "autre"


def get_tags(filename, category):
    tags = []
    name_lower = filename.lower()
    if category == "facture":
        tags.append("facture")
    if category == "impot":
        tags.append("impot")
    for kw in INVOICE_KEYWORDS:
        if kw in name_lower and "facture" not in tags:
            tags.append("facture")
    return ",".join(tags)


def hash_file(path, max_size_mb=100):
    """SHA256 partiel pour les gros fichiers (premiers 10MB)."""
    try:
        size = os.path.getsize(path)
        h = hashlib.sha256()
        read_bytes = min(size, 10 * 1024 * 1024)  # 10MB max
        with open(path, "rb") as f:
            data = f.read(read_bytes)
            h.update(data)
        if size > read_bytes:
            h.update(str(size).encode())
        return h.hexdigest()
    except Exception:
        return None


def mount_nas():
    if os.path.ismount(NAS_MOUNT):
        return True
    try:
        os.makedirs(NAS_MOUNT, exist_ok=True)
        result = subprocess.run(
            ["sudo", "mount", "-t", "cifs", NAS_SHARE, NAS_MOUNT,
             "-o", f"username={NAS_USER},password={NAS_PASS},vers=1.0,uid=simon,gid=simon,file_mode=0664,dir_mode=0775"],
            capture_output=True, timeout=15
        )
        return result.returncode == 0
    except Exception:
        return False


def scan_directory(source_name, root_path, conn, verbose=False):
    now = datetime.now().isoformat()
    files_found = 0
    files_new = 0
    files_updated = 0
    t0 = time.time()

    if not os.path.exists(root_path):
        return 0, 0, 0

    for dirpath, dirnames, filenames in os.walk(root_path):
        # Skip hidden dirs and system dirs
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d not in
                       {'__pycache__', 'node_modules', '.git', 'venv', '.venv', 'mypy_cache', '.mypy_cache'}]

        for fname in filenames:
            if fname.startswith('.'):
                continue

            fpath = os.path.join(dirpath, fname)
            try:
                stat = os.stat(fpath)
                size = stat.st_size
                mtime = stat.st_mtime
                ext = Path(fname).suffix.lower()
                category = classify(fname, ext, filepath=fpath)
                tags = get_tags(fname, category)
                files_found += 1

                # Check if already indexed and unchanged
                row = conn.execute(
                    "SELECT id, mtime, sha256 FROM files WHERE path = ?", (fpath,)
                ).fetchone()

                if row and abs(row[1] - mtime) < 1:
                    # File unchanged — update last_seen
                    conn.execute("UPDATE files SET last_seen=? WHERE id=?", (now, row[0]))
                    continue

                # Hash only for documents/invoices/taxes (skip big media)
                sha256 = None
                if category in ("document", "facture", "impot", "config", "db") or size < 5 * 1024 * 1024:
                    sha256 = hash_file(fpath)

                if row:
                    conn.execute("""
                        UPDATE files SET size=?, mtime=?, sha256=?, category=?, tags=?,
                        vectorized=0, last_seen=? WHERE id=?
                    """, (size, mtime, sha256, category, tags, now, row[0]))
                    files_updated += 1
                else:
                    conn.execute("""
                        INSERT INTO files (path, source, filename, ext, size, mtime, sha256,
                        category, tags, first_seen, last_seen)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (fpath, source_name, fname, ext, size, mtime, sha256,
                          category, tags, now, now))
                    files_new += 1

                if verbose and (files_new + files_updated) % 100 == 0:
                    print(f"  {source_name}: {files_found} trouvés, {files_new} nouveaux...")

            except (PermissionError, OSError):
                continue

    conn.commit()
    duration = time.time() - t0
    conn.execute("""
        INSERT INTO scan_log (scan_date, source, files_found, files_new, files_updated, duration_sec)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (now, source_name, files_found, files_new, files_updated, duration))
    conn.commit()
    return files_found, files_new, files_updated


def find_duplicates(conn):
    """Trouve les doublons par hash SHA256."""
    dupes = conn.execute("""
        SELECT sha256, COUNT(*) as cnt, SUM(size) as total_size
        FROM files WHERE sha256 IS NOT NULL
        GROUP BY sha256 HAVING cnt > 1
        ORDER BY total_size DESC
        LIMIT 20
    """).fetchall()
    return dupes


def stats(conn):
    total = conn.execute("SELECT COUNT(*), SUM(size) FROM files").fetchone()
    by_cat = conn.execute("""
        SELECT category, COUNT(*) as cnt, SUM(size) as sz
        FROM files GROUP BY category ORDER BY sz DESC
    """).fetchall()
    by_source = conn.execute("""
        SELECT source, COUNT(*) as cnt, SUM(size) as sz
        FROM files GROUP BY source ORDER BY sz DESC
    """).fetchall()
    dupes = find_duplicates(conn)
    dupe_size = sum(d[2] - d[1] * (d[2] // d[1]) if d[1] > 0 else 0 for d in dupes)

    return {
        "total_files": total[0] or 0,
        "total_size": total[1] or 0,
        "by_category": by_cat,
        "by_source": by_source,
        "duplicates": len(dupes),
        "duplicate_waste": dupe_size,
    }


def prune_missing(conn, verbose=False):
    """DELETE rows whose path no longer exists on disk.
    NAS paths skipped if NAS_MOUNT not mounted (avoid false-positive prune).
    Returns (checked, pruned)."""
    nas_mounted = os.path.ismount(NAS_MOUNT) or os.path.exists(os.path.join(NAS_MOUNT, "Documents"))
    rows = conn.execute("SELECT id, path, source FROM files").fetchall()
    pruned_ids = []
    for fid, path, source in rows:
        if not nas_mounted and path.startswith(NAS_MOUNT):
            continue  # don't prune NAS paths if NAS isn't mounted
        if not os.path.exists(path):
            pruned_ids.append(fid)
            if verbose and len(pruned_ids) <= 20:
                print(f"  pruning: {path}")
    if pruned_ids:
        # Chunk delete (SQLite has a parameter limit ~999)
        for i in range(0, len(pruned_ids), 500):
            chunk = pruned_ids[i:i + 500]
            placeholders = ",".join("?" for _ in chunk)
            conn.execute(f"DELETE FROM files WHERE id IN ({placeholders})", chunk)
        conn.commit()
    return len(rows), len(pruned_ids)


def index_single_file(filepath, conn):
    """Indexe un seul fichier dans la DB (utilisé par document-ocr après OCR)."""
    now = datetime.now().isoformat()
    fpath = os.path.abspath(filepath)
    if not os.path.exists(fpath):
        print(f"ERREUR: fichier introuvable: {fpath}", file=sys.stderr)
        return False

    fname = os.path.basename(fpath)
    ext = Path(fname).suffix.lower()
    stat = os.stat(fpath)
    size = stat.st_size
    mtime = stat.st_mtime

    category = classify(fname, ext, filepath=fpath)
    tags = get_tags(fname, category)
    sha256 = hash_file(fpath) if category in ("document", "facture", "impot") or size < 5 * 1024 * 1024 else None

    source = "local:scan"
    for src in LOCAL_SOURCES:
        if fpath.startswith(src):
            source = f"local:{src.split('/')[-1]}"
            break

    row = conn.execute("SELECT id, mtime FROM files WHERE path = ?", (fpath,)).fetchone()
    if row:
        conn.execute("""
            UPDATE files SET size=?, mtime=?, sha256=?, category=?, tags=?,
            vectorized=0, last_seen=? WHERE id=?
        """, (size, mtime, sha256, category, tags, now, row[0]))
        print(f"  Mis à jour: {fname} [{category}]")
    else:
        conn.execute("""
            INSERT INTO files (path, source, filename, ext, size, mtime, sha256,
            category, tags, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (fpath, source, fname, ext, size, mtime, sha256,
              category, tags, now, now))
        print(f"  Indexé: {fname} [{category}]")

    conn.commit()
    return True


def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    nas_only = "--nas" in sys.argv
    local_only = "--local" in sys.argv
    full = "--full" in sys.argv
    prune = "--prune-missing" in sys.argv

    # Mode --file : indexer un seul fichier immédiatement
    if "--file" in sys.argv:
        idx = sys.argv.index("--file")
        if idx + 1 >= len(sys.argv):
            print("Usage: --file <chemin>", file=sys.stderr)
            sys.exit(1)
        filepath = sys.argv[idx + 1]
        conn = sqlite3.connect(DB_PATH)
        init_db(conn)
        success = index_single_file(filepath, conn)
        conn.close()
        sys.exit(0 if success else 1)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    if prune:
        print(f"🧹 Prune missing entries (NAS check first)...")
        checked, pruned = prune_missing(conn, verbose=verbose)
        print(f"   {checked} entries vérifiées, {pruned} supprimées (paths morts).")
        if verbose and pruned > 20:
            print(f"   ... ({pruned - 20} more)")

    print(f"=== Archiviste Inventory — {datetime.now().strftime('%Y-%m-%d %H:%M')} ===")

    total_found = total_new = total_updated = 0

    # Local sources
    if not nas_only:
        for src_path in LOCAL_SOURCES:
            src_name = f"local:{src_path.split('/')[-1]}"
            print(f"📂 Scan {src_path}...")
            f, n, u = scan_directory(src_name, src_path, conn, verbose)
            print(f"   {f} fichiers, {n} nouveaux, {u} mis à jour")
            total_found += f; total_new += n; total_updated += u

    # NAS
    if not local_only:
        print(f"🗄️  Scan NAS ({NAS_MOUNT})...")
        if mount_nas():
            nas_dirs = [
                ("/mnt/nas/Documents", "nas:Documents"),
                ("/mnt/nas/Photos", "nas:Photos"),
                ("/mnt/nas/Musique", "nas:Musique"),
                ("/mnt/nas/Backups_ProDesk", "nas:Backups"),
            ]
            for nas_path, src_name in nas_dirs:
                if os.path.exists(nas_path):
                    f, n, u = scan_directory(src_name, nas_path, conn, verbose)
                    print(f"   {src_name}: {f} fichiers, {n} nouveaux")
                    total_found += f; total_new += n; total_updated += u
                elif full:
                    # Full scan: scan all of NAS
                    f, n, u = scan_directory("nas:all", NAS_MOUNT, conn, verbose)
                    print(f"   NAS complet: {f} fichiers, {n} nouveaux")
                    total_found += f; total_new += n; total_updated += u
                    break
        else:
            print("   ⚠️  NAS non accessible")

    # rclone sources (si dispo)
    for remote, remote_name in [("gdrive:", "gdrive"), ("amazon:", "amazon")]:
        if not local_only and not nas_only:
            result = subprocess.run(
                ["rclone", "lsd", remote, "--max-depth", "1"],
                capture_output=True, timeout=15
            )
            if result.returncode == 0:
                print(f"☁️  {remote_name} disponible — scan complet en mode full uniquement")
            # TODO: implémenter scan rclone (session prochaine avec credentials)

    # Stats finales
    s = stats(conn)
    print(f"\n📊 Index total:")
    print(f"   Fichiers: {s['total_files']:,}")
    print(f"   Taille: {s['total_size']/1024/1024/1024:.2f} GB")
    print(f"   Nouveaux ce scan: {total_new}")
    print(f"   Doublons détectés: {s['duplicates']} ({s['duplicate_waste']/1024/1024:.0f} MB perdus)")
    print(f"\n📂 Par catégorie:")
    for cat, cnt, sz in s['by_category'][:10]:
        print(f"   {cat:15s}: {cnt:6,} fichiers  ({(sz or 0)/1024/1024:.0f} MB)")

    conn.close()
    return total_new, total_updated


if __name__ == "__main__":
    main()
