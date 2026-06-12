#!/usr/bin/env python3
"""
Archiviste — Rapport et dossiers thématiques
Génère rapport Telegram, dossiers Impôts/IOC/Trading, alerte doublons.
"""

import os
import sys
import sqlite3
import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = "/home/simon/agent/data/archiviste-index.db"
DOSSIERS_ROOT = "/home/simon/Documents/Dossiers"
LOG_PATH = "/home/simon/agent/logs/archiviste-report.log"
VAULT_PATH = "/home/simon/agent/data/archiviste-vault.json"
TELEGRAM_SCRIPT = "/home/simon/agent/scripts/send-telegram.sh"

CURRENT_YEAR = datetime.now().year

DOSSIER_RULES = {
    f"Impôts_{CURRENT_YEAR}": {
        "categories": ["impot", "facture"],
        "keywords": ["t4", "rl-1", "rl1", "impot", "impôt", "tax", "cotisation",
                     "médical", "médecin", "clinique", "pharmacie", "don", "charité",
                     "reer", "rrsp", "tfsa", "celi", "retraite"],
        "extensions": [".pdf", ".xlsx", ".docx"],
    },
    "IOC": {
        "categories": ["document"],
        "keywords": ["mecfor", "nordco", "spiker", "jordan", "spreader", "kohler",
                     "vallée", "hiab", "ioc", "maintenance", "panne", "soumission",
                     "pièce", "piece", "manuel"],
        "extensions": [".pdf", ".docx", ".xlsx"],
    },
    "Trading": {
        "categories": ["document", "facture"],
        "keywords": ["interactive brokers", "ib", "trading", "position", "gain",
                     "perte", "t5008", "relevé", "statement", "momentum"],
        "extensions": [".pdf", ".xlsx", ".csv"],
    },
}


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def send_telegram(msg):
    """Envoie via script Telegram ou ntfy."""
    try:
        if os.path.exists(TELEGRAM_SCRIPT):
            subprocess.run([TELEGRAM_SCRIPT, msg], timeout=10)
            return
        # Fallback ntfy
        subprocess.run([
            "curl", "-s", "-d", msg,
            "http://localhost:8080/agent-alerts"
        ], timeout=5)
    except Exception as e:
        log(f"⚠️  Telegram fail: {e}")


def human_size(bytes_val):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if bytes_val < 1024:
            return f"{bytes_val:.1f} {unit}"
        bytes_val /= 1024
    return f"{bytes_val:.1f} PB"


def generate_weekly_report(conn):
    """Génère le rapport hebdomadaire complet."""
    now = datetime.now()

    # Stats générales
    total_files, total_size = conn.execute("SELECT COUNT(*), SUM(size) FROM files").fetchone()
    total_size = total_size or 0

    # Nouveaux cette semaine
    week_ago = (now - timedelta(days=7)).isoformat()
    new_week = conn.execute(
        "SELECT COUNT(*) FROM files WHERE first_seen >= ?", (week_ago,)
    ).fetchone()[0]

    # Par catégorie
    by_cat = conn.execute("""
        SELECT category, COUNT(*), SUM(size)
        FROM files GROUP BY category ORDER BY COUNT(*) DESC
    """).fetchall()

    # Doublons
    dupes = conn.execute("""
        SELECT sha256, COUNT(*) as cnt, SUM(size) as total_sz
        FROM files WHERE sha256 IS NOT NULL
        GROUP BY sha256 HAVING cnt > 1
        ORDER BY total_sz DESC LIMIT 10
    """).fetchall()
    dupe_count = len(dupes)
    dupe_waste = sum((d[1] - 1) * (d[2] // d[1]) for d in dupes if d[1] > 0)

    # Vectorisation
    vec_done = conn.execute("SELECT COUNT(*) FROM files WHERE vectorized=1").fetchone()[0]
    vec_pending = conn.execute("SELECT COUNT(*) FROM files WHERE vectorized=0").fetchone()[0]

    # Fichiers fiscaux récents
    tax_recent = conn.execute("""
        SELECT filename, first_seen FROM files
        WHERE category IN ('impot', 'facture')
        AND first_seen >= ?
        ORDER BY first_seen DESC LIMIT 5
    """, (week_ago,)).fetchall()

    # Sources
    by_source = conn.execute("""
        SELECT source, COUNT(*), SUM(size)
        FROM files GROUP BY source ORDER BY COUNT(*) DESC
    """).fetchall()

    # Construction message
    lines = [
        f"📦 **Rapport Archiviste — {now.strftime('%Y-%m-%d')}**",
        "",
        f"🗂 Total: {total_files:,} fichiers ({human_size(total_size)})",
        f"✨ Nouveaux cette semaine: {new_week}",
        f"🔄 Vectorisés: {vec_done:,} | En attente: {vec_pending:,}",
        "",
        "📂 Par catégorie:",
    ]

    for cat, cnt, sz in by_cat[:8]:
        lines.append(f"  {cat:12s}: {cnt:6,} ({human_size(sz or 0)})")

    if by_source:
        lines.append("")
        lines.append("💾 Par source:")
        for src, cnt, sz in by_source:
            lines.append(f"  {src}: {cnt:,} ({human_size(sz or 0)})")

    if dupe_count > 0:
        lines.append("")
        lines.append(f"⚠️  Doublons: {dupe_count} groupes ({human_size(dupe_waste)} gaspillé)")

    if tax_recent:
        lines.append("")
        lines.append("📋 Documents fiscaux récents:")
        for fname, fseen in tax_recent:
            lines.append(f"  • {fname}")

    return "\n".join(lines)


def create_dossier(dossier_name, rules, conn, symlink=True):
    """Crée un dossier thématique avec symlinks vers les fichiers pertinents."""
    dossier_path = os.path.join(DOSSIERS_ROOT, dossier_name)
    os.makedirs(dossier_path, exist_ok=True)

    categories = rules.get("categories", [])
    keywords = rules.get("keywords", [])
    extensions = rules.get("extensions", [])

    found = []

    # Recherche par catégorie
    if categories:
        placeholders = ",".join("?" * len(categories))
        rows = conn.execute(
            f"SELECT id, path, filename, ext FROM files WHERE category IN ({placeholders})",
            categories
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, path, filename, ext FROM files").fetchall()

    for fid, fpath, fname, ext in rows:
        if not os.path.exists(fpath):
            continue
        if extensions and ext not in extensions:
            continue
        name_lower = fname.lower()
        path_lower = fpath.lower()
        if any(kw in name_lower or kw in path_lower for kw in keywords):
            found.append((fpath, fname))

    if not found:
        return 0

    manifest = []
    for fpath, fname in found:
        if symlink:
            link_path = os.path.join(dossier_path, fname)
            # Évite les conflits de nom
            if os.path.exists(link_path) or os.path.islink(link_path):
                base, ext = os.path.splitext(fname)
                link_path = os.path.join(dossier_path, f"{base}_{fpath.replace('/', '_')[-20:]}{ext}")
            try:
                os.symlink(fpath, link_path)
            except Exception:
                pass
        manifest.append({"path": fpath, "filename": fname})

    # Manifest JSON
    manifest_path = os.path.join(dossier_path, "_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({
            "dossier": dossier_name,
            "created": datetime.now().isoformat(),
            "files": manifest,
        }, f, indent=2, ensure_ascii=False)

    log(f"✅ Dossier '{dossier_name}': {len(found)} fichiers trouvés")
    return len(found)


def check_credentials_expiry():
    """Vérifie les credentials qui expirent bientôt."""
    if not os.path.exists(VAULT_PATH):
        return []

    alerts = []
    try:
        with open(VAULT_PATH) as f:
            vault = json.load(f)
        now = datetime.now()
        for key, entry in vault.items():
            exp = entry.get("expires_at")
            if exp:
                exp_dt = datetime.fromisoformat(exp)
                days_left = (exp_dt - now).days
                if days_left < 30:
                    alerts.append(f"⚠️  Credential '{key}' expire dans {days_left}j ({exp})")
    except Exception as e:
        log(f"Vault read error: {e}")
    return alerts


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    verbose = "--verbose" in sys.argv or "-v" in sys.argv

    conn = sqlite3.connect(DB_PATH)

    if cmd == "report":
        report = generate_weekly_report(conn)
        print(report)
        if "--send" in sys.argv:
            send_telegram(report)
            log("Rapport envoyé via Telegram")

    elif cmd == "dossiers":
        log("Création des dossiers thématiques...")
        os.makedirs(DOSSIERS_ROOT, exist_ok=True)
        total = 0
        for dossier_name, rules in DOSSIER_RULES.items():
            count = create_dossier(dossier_name, rules, conn)
            total += count
        log(f"✅ Dossiers créés: {len(DOSSIER_RULES)} ({total} fichiers liés)")

    elif cmd == "alerts":
        # Vérifier les alertes critiques
        alerts = check_credentials_expiry()
        if alerts:
            for a in alerts:
                print(a)
            if "--send" in sys.argv:
                send_telegram("\n".join(alerts))
        else:
            print("✅ Aucune alerte credentials")

    elif cmd == "stats":
        report = generate_weekly_report(conn)
        print(report)

    else:
        print(f"Usage: {sys.argv[0]} [report|dossiers|alerts|stats] [--send] [--verbose]")

    conn.close()


if __name__ == "__main__":
    main()
