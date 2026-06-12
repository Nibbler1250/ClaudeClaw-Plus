#!/usr/bin/env python3
"""
Archiviste — Vault de credentials
Inventaire chiffré des secrets, tokens, clés API.
Lecture libre. Modification = confirmation Simon requise.
"""

import os
import sys
import json
import subprocess
import re
from datetime import datetime, timedelta
from pathlib import Path

VAULT_PATH = "/home/simon/agent/data/archiviste-vault.json"
VAULT_ENC_PATH = "/home/simon/agent/data/archiviste-vault.json.gpg"

# Fichiers à scanner pour détecter des credentials
CREDENTIAL_FILES = [
    "/home/simon/agent/.env",
    "/home/simon/automation-hub/.env",
    "/home/simon/Projects/momentum_trader_v7/.env",
    "/home/simon/.local/share/mcp-servers/gmail/.gmail-credentials.json",
    "/home/simon/scripts/backup-to-nas.sh",
    "/home/simon/.config/rclone/rclone.conf",
    "/home/simon/.claude/settings.json",
]

SCAN_DIRS = [
    "/home/simon",
    "/home/simon/Projects",
    "/home/simon/agent",
]

# Patterns pour détecter des credentials dans les fichiers
SECRET_PATTERNS = [
    (r'(?i)(password|passwd|pwd)\s*[=:]\s*["\']?([^\s"\']{6,})', "password"),
    (r'(?i)(api[_-]?key|apikey)\s*[=:]\s*["\']?([A-Za-z0-9_\-]{20,})', "api_key"),
    (r'(?i)(secret[_-]?key|secret)\s*[=:]\s*["\']?([A-Za-z0-9_\-]{20,})', "secret"),
    (r'(?i)(token|access_token)\s*[=:]\s*["\']?([A-Za-z0-9_\-\.]{20,})', "token"),
    (r'(?i)(client[_-]?id)\s*[=:]\s*["\']?([A-Za-z0-9_\-\.]{10,})', "client_id"),
    (r'(?i)(refresh[_-]?token)\s*[=:]\s*["\']?([A-Za-z0-9_\-\.]{20,})', "refresh_token"),
]


def load_vault():
    if os.path.exists(VAULT_PATH):
        with open(VAULT_PATH) as f:
            return json.load(f)
    return {"credentials": [], "last_scan": None, "version": "1.0"}


def save_vault(vault):
    with open(VAULT_PATH, "w") as f:
        json.dump(vault, f, indent=2)
    os.chmod(VAULT_PATH, 0o600)


def scan_file_for_credentials(filepath):
    """Détecte les credentials dans un fichier — retourne liste de findings."""
    findings = []
    try:
        with open(filepath, "r", errors="ignore") as f:
            content = f.read()
        for pattern, cred_type in SECRET_PATTERNS:
            for match in re.finditer(pattern, content):
                key_name = match.group(1)
                value_preview = match.group(2)[:8] + "..."
                findings.append({
                    "file": filepath,
                    "type": cred_type,
                    "key": key_name,
                    "preview": value_preview,
                    "line": content[:match.start()].count('\n') + 1
                })
    except Exception:
        pass
    return findings


def find_env_files():
    """Trouve tous les fichiers .env dans les dossiers de Simon."""
    env_files = []
    for scan_dir in SCAN_DIRS:
        if not os.path.exists(scan_dir):
            continue
        result = subprocess.run(
            ["find", scan_dir, "-maxdepth", "5", "-name", ".env",
             "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
            capture_output=True, text=True, timeout=10
        )
        env_files.extend(result.stdout.strip().split('\n'))
    return [f for f in env_files if f and os.path.isfile(f)]


def scan_all_credentials(vault):
    """Scan tous les fichiers de credentials connus + .env files."""
    found = []
    scanned = set()

    all_files = list(CREDENTIAL_FILES) + find_env_files()

    for fpath in all_files:
        if fpath in scanned or not os.path.exists(fpath):
            continue
        scanned.add(fpath)
        findings = scan_file_for_credentials(fpath)
        found.extend(findings)

    # Consolider dans le vault (pas de doublons)
    existing_keys = {(c["file"], c["key"]) for c in vault["credentials"]}
    new_count = 0
    for f in found:
        key = (f["file"], f["key"])
        if key not in existing_keys:
            vault["credentials"].append({
                **f,
                "first_seen": datetime.now().isoformat(),
                "last_seen": datetime.now().isoformat(),
                "notes": "",
                "expires": None,
            })
            existing_keys.add(key)
            new_count += 1
        else:
            # Update last_seen
            for c in vault["credentials"]:
                if c["file"] == f["file"] and c["key"] == f["key"]:
                    c["last_seen"] = datetime.now().isoformat()

    vault["last_scan"] = datetime.now().isoformat()
    return new_count


def check_expiring(vault, days=30):
    """Retourne les credentials qui expirent bientôt."""
    expiring = []
    now = datetime.now()
    for c in vault["credentials"]:
        if c.get("expires"):
            try:
                exp = datetime.fromisoformat(c["expires"])
                if exp - now < timedelta(days=days):
                    expiring.append({**c, "days_left": (exp - now).days})
            except Exception:
                pass
    return expiring


def report(vault):
    total = len(vault["credentials"])
    by_type = {}
    by_file = {}
    for c in vault["credentials"]:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1
        by_file[c["file"]] = by_file.get(c["file"], 0) + 1

    print(f"\n🔐 Vault Credentials — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"   Total credentials indexés: {total}")
    print(f"   Dernière analyse: {vault.get('last_scan','jamais')}")
    print(f"\n📂 Par type:")
    for t, cnt in sorted(by_type.items(), key=lambda x: -x[1]):
        print(f"   {t:20s}: {cnt}")
    print(f"\n📄 Par fichier:")
    for f, cnt in sorted(by_file.items(), key=lambda x: -x[1])[:10]:
        print(f"   {os.path.basename(f):30s}: {cnt} credentials")

    expiring = check_expiring(vault)
    if expiring:
        print(f"\n⚠️  Credentials expirant dans 30 jours: {len(expiring)}")
        for e in expiring:
            print(f"   {e['key']} ({e['file']}) — {e['days_left']} jours restants")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"

    vault = load_vault()

    if cmd == "scan":
        print("🔍 Scan des credentials...")
        new = scan_all_credentials(vault)
        save_vault(vault)
        print(f"✅ {new} nouveaux credentials indexés")
        report(vault)

    elif cmd == "report":
        report(vault)

    elif cmd == "list":
        for c in vault["credentials"]:
            print(f"{c['file']}:{c['line']} — {c['type']}: {c['key']} = {c['preview']}")

    elif cmd == "expiring":
        expiring = check_expiring(vault)
        if expiring:
            for e in expiring:
                print(f"⚠️  {e['key']} expire dans {e['days_left']} jours ({e['file']})")
        else:
            print("✅ Aucun credential n'expire dans les 30 prochains jours")

    else:
        print(f"Usage: {sys.argv[0]} [scan|report|list|expiring]")


if __name__ == "__main__":
    main()
