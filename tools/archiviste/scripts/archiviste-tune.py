#!/usr/bin/env python3
"""
archiviste-tune.py — Self-tuning orchestrator pour la classification archiviste.

Modes:
  --post-scan          Détecte clusters dans nouveaux fichiers, propose tune via LLM
  --list               Liste les propositions en attente
  --apply N            LLM génère patch + ouvre PR GitHub (review humain requis)
  --skip N [reason]    Marque proposition #N comme skipped
  --reconcile          Check les PRs ouverts: si mergé → pull + reclassify, si fermé → skip
  --history            Affiche les décisions passées
"""

import os
import re
import sys
import json
import time
import sqlite3
import subprocess
import importlib.util
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict


REPO_ROOT = Path("/home/simon/agent")
DB = REPO_ROOT / "data/archiviste-index.db"
INV = REPO_ROOT / "scripts/archiviste-inventory.py"
RECLASSIFY = REPO_ROOT / "scripts/archiviste-reclassify.py"
PROPOSALS = REPO_ROOT / "data/archiviste-tune-proposals.jsonl"
HISTORY = REPO_ROOT / "data/archiviste-tune-history.jsonl"
SEND_TG = REPO_ROOT / "scripts/send-telegram.sh"
INV_REL = INV.relative_to(REPO_ROOT)

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/home/simon/.local/bin/claude")
LLM_MODEL = "claude-sonnet-4-6"
ENV_FILE = Path("/home/simon/agent/.env")


def load_env_file():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


load_env_file()

MIN_CLUSTER_SIZE = 3
NEW_WINDOW_HOURS = int(os.environ.get("TUNE_WINDOW_HOURS", "48"))
PDFTOTEXT_SAMPLE = 3
PDFTOTEXT_MAX_CHARS = 800
LLM_TIMEOUT = 180
MAX_RECLASSIFY_THRESHOLD = 1500
MAX_BUDGET_USD = 0.20


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[tune {ts}] {msg}", flush=True)


def telegram(msg):
    if not SEND_TG.exists():
        log(f"(no telegram script) {msg[:80]}")
        return
    try:
        subprocess.run([str(SEND_TG), msg], check=False, timeout=20)
    except Exception as e:
        log(f"telegram err: {e}")


def load_inventory():
    spec = importlib.util.spec_from_file_location("inv", INV)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def call_llm(prompt, system=None, schema=None, default_on_empty=None):
    cmd = [
        CLAUDE_BIN, "--print",
        "--model", LLM_MODEL,
        "--max-budget-usd", str(MAX_BUDGET_USD),
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
        "--disable-slash-commands",
    ]
    if system:
        cmd += ["--system-prompt", system]
    if schema:
        cmd += ["--json-schema", json.dumps(schema)]
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=LLM_TIMEOUT)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "(no output)").strip()[:400]
        raise RuntimeError(f"claude failed (rc={proc.returncode}): {err}")
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude non-JSON: {proc.stdout[:300]}")
    if schema:
        structured = envelope.get("structured_output")
        if isinstance(structured, dict):
            return structured
    text = envelope.get("result") or envelope.get("text") or ""
    if schema:
        fence = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
        if fence:
            return json.loads(fence.group(1))
        m = re.search(r'\{[\s\S]*\}', text)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        if (not text.strip() or re.search(r'aucune?\s+propos|no\s+proposal|empty', text, re.IGNORECASE)) and default_on_empty is not None:
            log(f"LLM empty/refusal output, using default (raw={text[:80]!r})")
            return default_on_empty
        raise RuntimeError(f"no JSON object in result: {text[:200]!r}")
    return text


def append_jsonl(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def rewrite_proposals(proposals):
    with PROPOSALS.open("w") as f:
        for p in proposals:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")


def tokenize_basename(filename):
    stem = Path(filename).stem.lower()
    parts = re.split(r'[^a-z0-9]+', stem)
    return [p for p in parts if p and not p.isdigit() and len(p) >= 2]


def find_clusters(rows, min_size=MIN_CLUSTER_SIZE):
    by_prefix = defaultdict(list)
    for fid, fname, path, cat in rows:
        toks = tokenize_basename(fname)
        if not toks:
            continue
        prefix = next((t for t in toks if len(t) >= 4), toks[0])
        by_prefix[prefix].append((fid, fname, path, cat))
    return sorted(
        [(prefix, files) for prefix, files in by_prefix.items() if len(files) >= min_size],
        key=lambda x: -len(x[1]),
    )[:15]


def fetch_recent_unclassified(window_hours=NEW_WINDOW_HOURS):
    conn = sqlite3.connect(DB)
    cutoff = (datetime.now() - timedelta(hours=window_hours)).isoformat()
    rows = conn.execute("""
        SELECT id, filename, path, category
        FROM files
        WHERE category IN ('autre', 'document')
          AND last_seen >= ?
    """, (cutoff,)).fetchall()
    conn.close()
    return rows


def pdftotext_sample(path, max_chars=PDFTOTEXT_MAX_CHARS):
    if not path.lower().endswith('.pdf') or not Path(path).exists():
        return ""
    try:
        proc = subprocess.run(
            ["pdftotext", "-q", "-l", "2", path, "-"],
            capture_output=True, text=True, timeout=10
        )
        return proc.stdout[:max_chars].strip()
    except Exception:
        return ""


PROPOSE_SYSTEM = """Tu es l'agent Archiviste, expert en classification documentaire pour Simon Pelletier.
Tu reçois des clusters de fichiers actuellement classés 'autre' ou 'document' qui partagent un préfixe de nom récurrent.
Ta job: identifier lesquels méritent un nouveau keyword (ou nouvelle catégorie) dans la classification.

Catégories existantes: photo, document, musique, archive, db, config, code, facture, impot, autre.
Sub-classifications de 'document' via mots-clés: facture (INVOICE_KEYWORDS), impot (TAX_KEYWORDS).

Catégorie 'impot' = tout ce qui touche fiscalité: T4/T5/RL-1, talon paie, relevés IBKR (CustState), avis cotisation, REER/CELI, déductions, T2125, T776.
Catégorie 'facture' = reçus, invoices, commandes, paiements.

Confidence:
- HIGH: pattern très clair, ≥5 fichiers, contexte sans ambiguïté, keyword spécifique (>=4 chars).
- MEDIUM: pattern probable mais ambigu (2 catégories possibles).
- LOW: à ne pas proposer (incertain ou trop générique).

Règles strictes:
- Ne pas proposer un keyword < 3 chars (faux positifs garantis).
- Ne pas proposer un keyword qui apparaît déjà dans la liste cible.
- Préférer un keyword spécifique (CustState) à un keyword générique (state).

OUTPUT FORMAT (CRITIQUE):
Ta réponse ENTIÈRE doit être UNIQUEMENT un objet JSON valide.
Pas de markdown, pas de texte, pas de tableau, pas d'explication avant ou après.
Si aucun cluster ne mérite d'action, ta réponse est exactement: {"proposals": []}
Sinon ta réponse est: {"proposals": [{...}, {...}]}"""


PROPOSE_SCHEMA = {
    "type": "object",
    "properties": {
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cluster_prefix": {"type": "string"},
                    "action": {"type": "string", "enum": ["add_keyword"]},
                    "keyword": {"type": "string"},
                    "target_list": {"type": "string", "enum": ["TAX_KEYWORDS", "INVOICE_KEYWORDS"]},
                    "target_category": {"type": "string", "enum": ["impot", "facture"]},
                    "sample_files": {"type": "array", "items": {"type": "string"}},
                    "justification": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["cluster_prefix", "action", "keyword", "target_list",
                             "target_category", "justification", "confidence"],
            },
        }
    },
    "required": ["proposals"],
}


def llm_propose(clusters, inv_mod):
    history = read_jsonl(HISTORY)
    skipped = [h for h in history if h.get("decision") == "skipped"][-15:]
    history_summary = "\n".join(
        f"- skipped '{h.get('proposal', {}).get('keyword', '?')}': {h.get('reason', '?')}"
        for h in skipped
    ) or "(aucune)"

    cluster_parts = []
    for prefix, files in clusters:
        sample_files = files[:8]
        sample_paths = [p for _, _, p, _ in files[:PDFTOTEXT_SAMPLE]]
        pdf_extracts = []
        for path in sample_paths:
            text = pdftotext_sample(path)
            if text:
                pdf_extracts.append(f"  contenu de {Path(path).name[:50]}: {text[:300]}...")
        files_str = "\n".join(f"  [{cat}] {fname}" for _, fname, _, cat in sample_files)
        extracts_str = "\n".join(pdf_extracts) if pdf_extracts else "  (pas de contenu PDF lisible)"
        cluster_parts.append(
            f"## Cluster '{prefix}' ({len(files)} fichiers)\n{files_str}\n{extracts_str}"
        )

    prompt = f"""Voici les clusters détectés (ce sont des fichiers récemment ajoutés/modifiés et classés 'autre' ou 'document'):

{chr(10).join(cluster_parts)}

KEYWORDS actuels TAX_KEYWORDS:
{json.dumps(inv_mod.TAX_KEYWORDS, ensure_ascii=False)}

KEYWORDS actuels INVOICE_KEYWORDS:
{json.dumps(inv_mod.INVOICE_KEYWORDS, ensure_ascii=False)}

DÉCISIONS PASSÉES (NE PAS re-proposer ce qui a été refusé pour la même raison):
{history_summary}

Pour chaque cluster qui mérite une action, retourne un objet dans le JSON.
Si aucun cluster ne mérite d'action, retourne {{"proposals": []}}."""

    log(f"LLM call propose: {len(clusters)} clusters, prompt {len(prompt)} chars")
    result = call_llm(prompt, system=PROPOSE_SYSTEM, schema=PROPOSE_SCHEMA,
                      default_on_empty={"proposals": []})
    return result.get("proposals", [])


def cmd_post_scan():
    log("Mode --post-scan")
    if not INV.exists():
        log(f"❌ inventory.py absent: {INV}"); sys.exit(1)
    inv_mod = load_inventory()
    rows = fetch_recent_unclassified()
    log(f"  {len(rows)} fichiers récents (<{NEW_WINDOW_HOURS}h) en 'autre'/'document'")
    if not rows:
        log("  rien à analyser"); return
    clusters = find_clusters(rows)
    log(f"  {len(clusters)} clusters >= {MIN_CLUSTER_SIZE} fichiers")
    if not clusters:
        log("  pas de cluster significatif"); return
    for prefix, files in clusters[:5]:
        log(f"    cluster '{prefix}': {len(files)} fichiers (sample: {files[0][1][:50]})")

    try:
        proposals = llm_propose(clusters, inv_mod)
    except Exception as e:
        log(f"❌ LLM call failed: {e}")
        telegram(f"⚠️ Archiviste tune: LLM échec — {str(e)[:200]}")
        return

    log(f"  LLM propose {len(proposals)} action(s)")
    saved = []
    existing_kws = set(k.lower() for k in inv_mod.TAX_KEYWORDS + inv_mod.INVOICE_KEYWORDS)
    for p in proposals:
        if p.get("confidence") == "low":
            log(f"    skip low conf: {p.get('keyword')}"); continue
        kw = (p.get("keyword") or "").lower()
        if not kw or len(kw) < 3:
            log(f"    skip too-short keyword: '{kw}'"); continue
        if kw in existing_kws:
            log(f"    skip duplicate keyword: '{kw}'"); continue
        p["_id"] = int(time.time() * 1000) + len(saved)
        p["_status"] = "pending"
        p["_created"] = datetime.now().isoformat()
        append_jsonl(PROPOSALS, p)
        saved.append(p)

    if not saved:
        log("  aucune proposition retenue après filtrage"); return

    msg_lines = [f"🗂️ *Archiviste tune* — {len(saved)} proposition(s):", ""]
    for p in saved:
        conf = p.get("confidence", "?").upper()
        kw = p.get("keyword", "?")
        target = p.get("target_category", "?")
        just = (p.get("justification") or "")[:180]
        msg_lines.append(f"`#{p['_id']}` [{conf}] +`{kw}` → *{target}*")
        msg_lines.append(f"_{just}_")
        msg_lines.append(f"`tune --apply {p['_id']}` ou `--skip {p['_id']}`")
        msg_lines.append("")
    telegram("\n".join(msg_lines))
    log(f"  ✅ {len(saved)} propositions sauvées dans {PROPOSALS}")


def cmd_list():
    proposals = [p for p in read_jsonl(PROPOSALS) if p.get("_status") == "pending"]
    if not proposals:
        print("Aucune proposition en attente.")
        return
    print(f"{len(proposals)} proposition(s) en attente:\n")
    for p in proposals:
        print(f"  #{p['_id']} [{p.get('confidence', '?').upper()}] +{p.get('keyword')} → {p.get('target_category')}")
        print(f"    {(p.get('justification') or '')[:120]}")
        print(f"    samples: {p.get('sample_files', [])[:3]}\n")


def cmd_skip(pid, reason="user-skip"):
    pid = int(pid)
    proposals = read_jsonl(PROPOSALS)
    for p in proposals:
        if p["_id"] == pid and p.get("_status") == "pending":
            p["_status"] = "skipped"
            p["_skipped_at"] = datetime.now().isoformat()
            p["_skip_reason"] = reason
            append_jsonl(HISTORY, {
                "decision": "skipped", "proposal": p,
                "reason": reason, "ts": datetime.now().isoformat()
            })
            rewrite_proposals(proposals)
            print(f"✅ Proposition #{pid} marquée skipped.")
            return
    print(f"❌ Proposition #{pid} non trouvée ou déjà traitée.")


PATCH_SYSTEM = """Tu génères un patch Python EXACT pour modifier la liste TAX_KEYWORDS ou INVOICE_KEYWORDS dans archiviste-inventory.py.
Tu réponds UNIQUEMENT avec le JSON {"old_string": "...", "new_string": "..."} où:
- old_string est un fragment EXACT du fichier (avec assez de contexte pour être unique)
- new_string est ce qu'on met à la place (avec le keyword ajouté)
Préserve l'indentation (4 spaces), les virgules, les quotes ('...'), et la sous-section commentaire (# ...) si elle existe."""

PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "old_string": {"type": "string"},
        "new_string": {"type": "string"},
    },
    "required": ["old_string", "new_string"],
}


def git_run(*args, check=True, capture=False):
    """Run a git command in REPO_ROOT, returning CompletedProcess."""
    return subprocess.run(
        ["git", *args], cwd=REPO_ROOT, check=check,
        capture_output=capture, text=True, timeout=60,
    )


def gh_run(*args, check=True):
    """Run gh CLI in REPO_ROOT (env already has GITHUB_TOKEN from .env load)."""
    return subprocess.run(
        ["gh", *args], cwd=REPO_ROOT, check=check,
        capture_output=True, text=True, timeout=60,
    )


def slugify(s, max_len=30):
    s = re.sub(r'[^a-z0-9-]+', '-', (s or "").lower()).strip('-')
    return s[:max_len] or "tune"


def cmd_apply(pid):
    pid = int(pid)
    proposals = read_jsonl(PROPOSALS)
    target = next((p for p in proposals if p["_id"] == pid and p.get("_status") == "pending"), None)
    if not target:
        print(f"❌ Proposition #{pid} non trouvée ou déjà traitée."); return

    log(f"Apply #{pid}: +{target.get('keyword')} → {target.get('target_category')}")

    # 1. Vérifier working tree propre pour inventory.py
    proc = git_run("status", "--porcelain", str(INV_REL), capture=True)
    if proc.stdout.strip():
        log(f"❌ {INV_REL} a des changements non-committés: {proc.stdout.strip()}")
        telegram(f"❌ Tune #{pid} abort: inventory.py non-committé. Commit/stash d'abord.")
        return

    # 2. Vérifier qu'on est sur main
    proc = git_run("rev-parse", "--abbrev-ref", "HEAD", capture=True)
    current_branch = proc.stdout.strip()
    if current_branch != "main":
        log(f"❌ Pas sur main (currently '{current_branch}')")
        telegram(f"❌ Tune #{pid} abort: branche actuelle '{current_branch}' (faut être sur main)")
        return

    # 3. LLM génère patch
    src = INV.read_text()
    patch_prompt = f"""Voici archiviste-inventory.py:

```python
{src}
```

Ajoute le keyword `{target.get('keyword')}` dans la liste {target.get('target_list')}.
Justification: {target.get('justification')}
Catégorie cible: {target.get('target_category')}

Génère le diff EXACT (old_string + new_string). old_string doit être unique dans le fichier."""

    try:
        patch = call_llm(patch_prompt, system=PATCH_SYSTEM, schema=PATCH_SCHEMA)
    except Exception as e:
        log(f"❌ LLM patch failed: {e}")
        telegram(f"❌ Tune #{pid} échec LLM: {str(e)[:200]}"); return

    old_s = patch.get("old_string", "")
    new_s = patch.get("new_string", "")
    if not old_s or old_s not in src:
        log(f"❌ Patch invalide: old_string absent du fichier")
        telegram(f"❌ Tune #{pid} échec: old_string absent du fichier"); return
    if src.count(old_s) > 1:
        log(f"❌ Patch ambigu: old_string apparaît {src.count(old_s)} fois")
        telegram(f"❌ Tune #{pid} échec: patch ambigu"); return

    new_src = src.replace(old_s, new_s)

    # 4. Appliquer patch en working tree
    INV.write_text(new_src)
    log(f"  Patch appliqué ({len(new_s) - len(old_s):+d} chars)")

    # 5. Dry-run reclassify (pour estimer impact, mettre dans PR body)
    proc = subprocess.run(["python3", str(RECLASSIFY)], capture_output=True, text=True, timeout=120)
    m = re.search(r'Changements détectés:\s*(\d+)', proc.stdout)
    n_changes = int(m.group(1)) if m else 0
    log(f"  Dry-run: {n_changes} fichiers changeraient")

    # Capture le summary pour PR body
    dryrun_summary = proc.stdout

    if n_changes > MAX_RECLASSIFY_THRESHOLD:
        log(f"❌ Trop de changements ({n_changes} > {MAX_RECLASSIFY_THRESHOLD}), revert")
        INV.write_text(src)  # revert working tree
        telegram(f"❌ Tune #{pid} revert: {n_changes} reclassif > seuil {MAX_RECLASSIFY_THRESHOLD}")
        return

    # 6. Créer branche + commit + push + PR
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    kw_slug = slugify(target.get('keyword', 'tune'))
    branch = f"tune/archiviste-{kw_slug}-{ts}"

    try:
        git_run("checkout", "-b", branch)
        git_run("add", str(INV_REL))
        commit_msg = (
            f"tune(archiviste): add `{target.get('keyword')}` to {target.get('target_list')}\n\n"
            f"Catégorie cible: {target.get('target_category')}\n"
            f"Confidence LLM: {target.get('confidence')}\n"
            f"Justification: {target.get('justification')}\n"
            f"Impact estimé: {n_changes} fichier(s) reclassifiés après merge.\n"
            f"\nProposal #{pid} (auto-generated)"
        )
        git_run("commit", "-m", commit_msg)
        git_run("push", "-u", "origin", branch)
    except subprocess.CalledProcessError as e:
        log(f"❌ Git failed: {e}")
        # Try to revert and switch back to main
        git_run("checkout", "main", check=False)
        git_run("branch", "-D", branch, check=False)
        INV.write_text(src)
        telegram(f"❌ Tune #{pid} échec git: {str(e)[:150]}")
        return

    # 7. PR body
    samples = target.get('sample_files', [])[:8]
    samples_md = "\n".join(f"- `{s}`" for s in samples) or "(aucun sample fourni)"
    pr_title = f"tune(archiviste): +`{target.get('keyword')}` → `{target.get('target_category')}`"
    pr_body = f"""## Proposition automatique d'archiviste-tune

| Champ | Valeur |
|---|---|
| Keyword | `{target.get('keyword')}` |
| Liste cible | `{target.get('target_list')}` |
| Catégorie cible | `{target.get('target_category')}` |
| Confidence LLM | **{target.get('confidence')}** |
| Cluster prefix | `{target.get('cluster_prefix', '?')}` |
| Proposal ID | #{pid} |

### Justification
{target.get('justification')}

### Échantillons du cluster
{samples_md}

### Impact estimé après merge
**{n_changes}** fichier(s) seront reclassifiés en `{target.get('target_category')}`.

```
{dryrun_summary[-1500:]}
```

### Workflow après merge
```bash
ssh prodesk
cd ~/agent
python3 scripts/archiviste-tune.py --reconcile
```
Cela pull main, applique reclassify sur la DB, et update le statut de proposal #{pid}.

### Si refusé
Close ce PR sans merger; `--reconcile` détectera le close et marquera la proposition comme skipped."""

    try:
        proc = gh_run("pr", "create", "--title", pr_title, "--body", pr_body, "--base", "main", "--head", branch)
        pr_url = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
        log(f"  ✅ PR créé: {pr_url}")
    except subprocess.CalledProcessError as e:
        log(f"❌ gh pr create failed: {e.stderr[:300]}")
        telegram(f"❌ Tune #{pid} branche pushée mais PR échoué: {str(e.stderr)[:150]}")
        git_run("checkout", "main", check=False)
        return

    # 8. Switch back to main
    git_run("checkout", "main", check=False)

    # 9. Update proposal
    for p in proposals:
        if p["_id"] == pid:
            p["_status"] = "pr_opened"
            p["_pr_url"] = pr_url
            p["_pr_branch"] = branch
            p["_pr_opened_at"] = datetime.now().isoformat()
            p["_n_reclassified_estimate"] = n_changes
            p["_patch"] = patch
    rewrite_proposals(proposals)

    telegram(
        f"🔀 *Tune #{pid} → PR ouvert*\n"
        f"+`{target.get('keyword')}` → `{target.get('target_category')}` "
        f"(~{n_changes} fichiers)\n"
        f"{pr_url}\n\n"
        f"Merge sur GitHub puis `--reconcile`"
    )


def cmd_reconcile():
    """Vérifie les PRs ouverts: si MERGED → pull + reclassify, si CLOSED → skip."""
    log("Mode --reconcile")
    proposals = read_jsonl(PROPOSALS)
    pr_pending = [p for p in proposals if p.get("_status") == "pr_opened"]
    if not pr_pending:
        log("Aucun PR en attente de réconciliation"); return

    log(f"  {len(pr_pending)} PR(s) à vérifier")

    # Pull main d'abord
    try:
        git_run("checkout", "main")
        git_run("pull", "origin", "main")
    except subprocess.CalledProcessError as e:
        log(f"❌ git pull failed: {e}")
        telegram(f"❌ Reconcile: git pull main failed")
        return

    any_merged = False
    for p in pr_pending:
        pid = p["_id"]
        pr_url = p.get("_pr_url", "")
        if not pr_url:
            log(f"  #{pid}: pas d'URL PR, skip"); continue
        try:
            proc = gh_run("pr", "view", pr_url, "--json", "state,mergedAt,number")
            data = json.loads(proc.stdout)
        except (subprocess.CalledProcessError, json.JSONDecodeError) as e:
            log(f"  #{pid}: gh pr view failed ({e})"); continue
        state = data.get("state")
        log(f"  #{pid} PR#{data.get('number')}: state={state}")

        branch = p.get("_pr_branch", "")
        if state == "MERGED":
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            db_backup = DB.with_name(f"{DB.name}.pre-tune-{ts}.bak")
            db_backup.write_bytes(DB.read_bytes())
            log(f"    Backup DB → {db_backup.name}")
            proc = subprocess.run(["python3", str(RECLASSIFY), "--apply"],
                                  capture_output=True, text=True, timeout=180)
            m = re.search(r'Changements détectés:\s*(\d+)', proc.stdout)
            n = int(m.group(1)) if m else 0
            log(f"    ✅ Reclassify --apply: {n} fichiers")
            p["_status"] = "applied"
            p["_applied_at"] = datetime.now().isoformat()
            p["_n_reclassified"] = n
            append_jsonl(HISTORY, {
                "decision": "applied", "proposal": p,
                "n_reclassified": n, "ts": datetime.now().isoformat()
            })
            telegram(f"✅ *Tune #{pid} merged + reclassifié*\n+`{p.get('keyword')}` → `{p.get('target_category')}` ({n} fichiers)")
            any_merged = True
            if branch:
                git_run("push", "origin", "--delete", branch, check=False)
                git_run("branch", "-D", branch, check=False)

        elif state == "CLOSED":
            log(f"    PR fermé sans merge → skip")
            p["_status"] = "skipped"
            p["_skip_reason"] = "PR closed without merge"
            p["_skipped_at"] = datetime.now().isoformat()
            append_jsonl(HISTORY, {
                "decision": "skipped", "proposal": p,
                "reason": "PR closed without merge", "ts": datetime.now().isoformat()
            })
            telegram(f"⏭️ Tune #{pid} skipped (PR closed)")
            if branch:
                git_run("push", "origin", "--delete", branch, check=False)
                git_run("branch", "-D", branch, check=False)

    rewrite_proposals(proposals)
    if not any_merged:
        log("Rien de mergé depuis dernier reconcile")


def cmd_history():
    history = read_jsonl(HISTORY)
    if not history:
        print("Aucune décision passée."); return
    for h in history[-30:]:
        ts = h.get("ts", "")[:16]
        dec = h.get("decision", "?")
        kw = h.get("proposal", {}).get("keyword", "?")
        n = h.get("n_reclassified", "")
        extra = f"({n} reclassif)" if n else ""
        reason = h.get("reason", "")
        print(f"  {ts}  {dec:<8} +{kw:<20} {extra} {reason}")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return
    cmd = args[0]
    if cmd == "--post-scan":
        cmd_post_scan()
    elif cmd == "--list":
        cmd_list()
    elif cmd == "--apply" and len(args) >= 2:
        cmd_apply(args[1])
    elif cmd == "--skip" and len(args) >= 2:
        reason = " ".join(args[2:]) if len(args) > 2 else "user-skip"
        cmd_skip(args[1], reason)
    elif cmd == "--reconcile":
        cmd_reconcile()
    elif cmd == "--history":
        cmd_history()
    else:
        print(__doc__); sys.exit(1)


if __name__ == "__main__":
    main()
