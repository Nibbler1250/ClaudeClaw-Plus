#!/usr/bin/env python3
"""
Archiviste — Vectorisation locale incrémentale + Recherche hybride BM25+vectorielle
Utilise sentence-transformers (all-MiniLM-L6-v2) — zéro token API.
Seuls les fichiers non-vectorisés ou modifiés sont traités.

Recherche hybride:
  - Score vectoriel (cosine similarity) × 0.6
  - Score BM25 × 0.4
  - Fusion par Reciprocal Rank Fusion (RRF)
  - Index BM25 persisté dans ~/agent/data/archiviste-bm25-index.pkl
"""

import os
import sys
import sqlite3
import json
import time
import pickle
import re
import numpy as np
from datetime import datetime
from pathlib import Path

DB_PATH = "/home/simon/agent/data/archiviste-index.db"
VECTORS_DIR = "/home/simon/agent/data/archiviste-vectors"
BM25_INDEX_PATH = "/home/simon/agent/data/archiviste-bm25-index.pkl"
LOG_PATH = "/home/simon/agent/logs/archiviste-vectorize.log"
MODEL_NAME = "all-MiniLM-L6-v2"

# Catégories à vectoriser (priorité ordre)
VECTORIZE_CATEGORIES = ["facture", "impot", "document", "config", "code", "archive"]
MAX_TEXT_CHARS = 3000
MAX_BATCH = 50  # fichiers par session (économie CPU/RAM)

# Poids pour la fusion hybride
WEIGHT_VECTOR = 0.6
WEIGHT_BM25 = 0.4
RRF_K = 60  # constante RRF standard

# Niveaux de confiance pour les documents vectorisés.
# Un document marqué 'untrusted_email' ne doit jamais être utilisé comme source
# d'instructions par un LLM downstream — seulement comme données à analyser.
TRUST_LEVELS = {'internal', 'trusted_email', 'untrusted_email'}
DEFAULT_TRUST = 'internal'
SOURCE_TRUST_MARKER = '.source_trust.json'


def find_source_trust(filepath: str, max_levels: int = 6) -> str:
    """
    Cherche un fichier .source_trust.json dans le dossier courant puis
    remonte jusqu'à `max_levels` parents. Retourne le trust level trouvé
    ou DEFAULT_TRUST.
    """
    try:
        folder = os.path.dirname(os.path.abspath(filepath))
        for _ in range(max_levels):
            marker = os.path.join(folder, SOURCE_TRUST_MARKER)
            if os.path.isfile(marker):
                with open(marker) as f:
                    data = json.load(f)
                    level = data.get('source_trust', DEFAULT_TRUST)
                    if level in TRUST_LEVELS:
                        return level
                    return DEFAULT_TRUST
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
    except Exception:
        pass
    return DEFAULT_TRUST


def ensure_source_trust_column(conn: sqlite3.Connection) -> None:
    """Ajoute la colonne source_trust à files si absente (idempotent)."""
    cols = [row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()]
    if 'source_trust' not in cols:
        conn.execute(
            f"ALTER TABLE files ADD COLUMN source_trust TEXT DEFAULT '{DEFAULT_TRUST}'"
        )
        conn.commit()


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


def load_model():
    try:
        from sentence_transformers import SentenceTransformer
        log(f"Chargement modèle {MODEL_NAME}...")
        model = SentenceTransformer(MODEL_NAME)
        log("✅ Modèle chargé")
        return model
    except ImportError:
        log("❌ sentence-transformers non installé — pip3 install sentence-transformers --break-system-packages")
        sys.exit(1)


def extract_text(filepath, ext, max_chars=MAX_TEXT_CHARS):
    """Extrait le texte d'un fichier selon son extension."""
    try:
        # Texte brut
        if ext in {".txt", ".md", ".rst", ".csv", ".log"}:
            with open(filepath, "r", errors="ignore") as f:
                return f.read(max_chars)

        # JSON / YAML / TOML
        if ext in {".json", ".yaml", ".yml", ".toml", ".conf", ".cfg", ".ini"}:
            with open(filepath, "r", errors="ignore") as f:
                return f.read(max_chars)

        # Code source
        if ext in {".py", ".js", ".ts", ".sh", ".go", ".rs", ".java", ".cpp", ".c", ".h"}:
            with open(filepath, "r", errors="ignore") as f:
                return f.read(max_chars)

        # PDF — extraction basique sans dépendances
        if ext == ".pdf":
            try:
                import subprocess
                result = subprocess.run(
                    ["pdftotext", filepath, "-"],
                    capture_output=True, timeout=10
                )
                if result.returncode == 0:
                    return result.stdout.decode("utf-8", errors="ignore")[:max_chars]
            except Exception:
                pass
            return ""

        # Fallback — utilise le nom de fichier + chemin comme texte
        return filepath

    except Exception:
        return filepath


def save_vector(file_id, vector):
    vec_path = os.path.join(VECTORS_DIR, f"{file_id}.npy")
    np.save(vec_path, vector)


def load_vector(file_id):
    vec_path = os.path.join(VECTORS_DIR, f"{file_id}.npy")
    if os.path.exists(vec_path):
        return np.load(vec_path)
    return None


# ─────────────────────────────────────────────
# BM25 Index management
# ─────────────────────────────────────────────

def tokenize(text: str) -> list[str]:
    """Tokenisation simple : minuscules, séparation sur non-alphanumérique."""
    if not text:
        return []
    text = text.lower()
    tokens = re.split(r'[^a-z0-9àâäéèêëîïôöùûüç]+', text)
    return [t for t in tokens if len(t) > 1]


def load_bm25_index() -> dict | None:
    """Charge l'index BM25 persisté. Retourne None si absent."""
    if os.path.exists(BM25_INDEX_PATH):
        try:
            with open(BM25_INDEX_PATH, 'rb') as f:
                return pickle.load(f)
        except Exception:
            return None
    return None


def save_bm25_index(index_data: dict) -> None:
    """Sauvegarde l'index BM25 sur disque."""
    with open(BM25_INDEX_PATH, 'wb') as f:
        pickle.dump(index_data, f)


def build_bm25_index(conn: sqlite3.Connection, exclude_untrusted: bool = False) -> dict:
    """
    Construit un index BM25 en mémoire à partir des métadonnées en DB.
    Retourne un dict avec les structures nécessaires pour scorer.
    """
    try:
        from rank_bm25 import BM25Okapi
    except ImportError:
        return {}

    where = "vectorized=1"
    if exclude_untrusted:
        where += " AND COALESCE(source_trust,'internal') != 'untrusted_email'"

    rows = conn.execute(
        f"SELECT id, filename, path, category, tags FROM files WHERE {where}"
    ).fetchall()

    if not rows:
        return {}

    ids = []
    corpus_tokens = []

    for fid, fname, fpath, cat, tags in rows:
        # Texte indexé = nom fichier + chemin (rapide, sans relire les fichiers)
        text = f"{fname} {fpath or ''} {cat or ''} {tags or ''}"
        tokens = tokenize(text)
        ids.append(fid)
        corpus_tokens.append(tokens if tokens else ['_empty_'])

    bm25 = BM25Okapi(corpus_tokens)

    index_data = {
        'ids': ids,
        'bm25': bm25,
        'built_at': datetime.now().isoformat(),
        'exclude_untrusted': exclude_untrusted,
    }
    return index_data


def bm25_scores_for_query(index_data: dict, query: str) -> dict[int, float]:
    """
    Retourne un dict {file_id: bm25_score} pour la requête donnée.
    """
    if not index_data:
        return {}

    bm25 = index_data.get('bm25')
    ids = index_data.get('ids', [])
    if bm25 is None or not ids:
        return {}

    tokens = tokenize(query)
    if not tokens:
        return {}

    raw_scores = bm25.get_scores(tokens)
    return {fid: float(score) for fid, score in zip(ids, raw_scores)}


def reciprocal_rank_fusion(
    vec_results: list,
    bm25_scores: dict[int, float],
    all_rows: list,
    top_k: int = 10,
    weight_vec: float = WEIGHT_VECTOR,
    weight_bm25: float = WEIGHT_BM25,
    k: int = RRF_K,
) -> list:
    """
    Fusionne résultats vectoriels et BM25 avec Reciprocal Rank Fusion.

    vec_results: [(score, fpath, fname, cat, tags, trust, fid), ...]
    bm25_scores: {fid: score}
    all_rows: [(fid, fpath, fname, cat, tags, trust), ...] — pour le fallback BM25-only

    Retourne [(rrf_score, fpath, fname, cat, tags, trust), ...]
    """
    # Rang vectoriel (1-indexed)
    vec_rank = {item[6]: (rank + 1) for rank, item in enumerate(vec_results)}

    # Rang BM25 : trier par score décroissant
    bm25_sorted = sorted(bm25_scores.items(), key=lambda x: -x[1])
    bm25_rank = {fid: (rank + 1) for rank, (fid, _) in enumerate(bm25_sorted)}

    # Normaliser les scores BM25 pour la fusion directe (0-1)
    max_bm25 = max(bm25_scores.values()) if bm25_scores else 1.0
    if max_bm25 == 0:
        max_bm25 = 1.0

    # Construire un index id → metadata pour tous les candidats
    meta = {item[6]: item for item in vec_results}
    for fid, fpath, fname, cat, tags, trust in all_rows:
        if fid not in meta:
            meta[fid] = (0.0, fpath, fname, cat, tags, trust, fid)

    # Tous les file_ids candidats (union vec + bm25)
    all_ids = set(vec_rank.keys()) | set(bm25_rank.keys())

    scores = {}
    for fid in all_ids:
        rrf_vec = weight_vec / (k + vec_rank.get(fid, len(vec_results) + k))
        rrf_bm25 = weight_bm25 / (k + bm25_rank.get(fid, len(bm25_sorted) + k))
        scores[fid] = rrf_vec + rrf_bm25

    # Trier et retourner top_k
    top_ids = sorted(scores.items(), key=lambda x: -x[1])[:top_k]

    results = []
    for fid, rrf_score in top_ids:
        item = meta.get(fid)
        if item:
            _, fpath, fname, cat, tags, trust, _ = item
            results.append((rrf_score, fpath, fname, cat, tags, trust))

    return results


# ─────────────────────────────────────────────
# Vectorisation
# ─────────────────────────────────────────────

def vectorize_pending(conn, model, batch_size=MAX_BATCH, verbose=False):
    """Vectorise les fichiers non encore vectorisés ou modifiés, par priorité."""

    ensure_source_trust_column(conn)

    placeholders = ",".join("?" * len(VECTORIZE_CATEGORIES))
    rows = conn.execute(f"""
        SELECT id, path, filename, ext, category FROM files
        WHERE vectorized = 0
        AND category IN ({placeholders})
        AND path IS NOT NULL
        ORDER BY
            CASE category
                WHEN 'impot'    THEN 1
                WHEN 'facture'  THEN 2
                WHEN 'document' THEN 3
                WHEN 'config'   THEN 4
                WHEN 'code'     THEN 5
                ELSE 6
            END
        LIMIT ?
    """, (*VECTORIZE_CATEGORIES, batch_size)).fetchall()

    if not rows:
        log("Aucun fichier en attente de vectorisation.")
        return 0

    log(f"🔄 {len(rows)} fichiers à vectoriser...")
    done = 0
    trust_stats = {'internal': 0, 'untrusted_email': 0, 'trusted_email': 0}
    texts = []
    ids = []
    trust_levels_for_ids = {}

    for fid, fpath, fname, ext, cat in rows:
        if not os.path.exists(fpath):
            conn.execute("UPDATE files SET vectorized=-1 WHERE id=?", (fid,))
            continue
        text = extract_text(fpath, ext)
        if not text:
            text = fname

        # Déterminer le niveau de confiance du document
        trust = find_source_trust(fpath)
        trust_levels_for_ids[fid] = trust
        trust_stats[trust] = trust_stats.get(trust, 0) + 1

        texts.append(text[:MAX_TEXT_CHARS])
        ids.append(fid)

    if not texts:
        conn.commit()
        return 0

    # Encode en batch
    embeddings = model.encode(texts, show_progress_bar=verbose, batch_size=16)
    os.makedirs(VECTORS_DIR, exist_ok=True)

    for fid, vec in zip(ids, embeddings):
        save_vector(fid, vec)
        trust = trust_levels_for_ids.get(fid, DEFAULT_TRUST)
        conn.execute(
            "UPDATE files SET vectorized=1, source_trust=? WHERE id=?",
            (trust, fid),
        )
        done += 1

    conn.commit()
    log(f"✅ {done} fichiers vectorisés")
    if trust_stats.get('untrusted_email', 0) > 0:
        log(
            f"   ⚠️  {trust_stats['untrusted_email']} document(s) marqué(s) 'untrusted_email' "
            f"— le LLM downstream doit les traiter comme données, pas instructions"
        )

    # Invalider le cache BM25 après vectorisation
    if os.path.exists(BM25_INDEX_PATH):
        os.remove(BM25_INDEX_PATH)
        log("🗑️  Cache BM25 invalidé (rebuild au prochain --search)")

    return done


# ─────────────────────────────────────────────
# Recherche hybride
# ─────────────────────────────────────────────

def search(conn, model, query, top_k=10, categories=None, exclude_untrusted=False):
    """
    Recherche hybride BM25 + vectorielle avec Reciprocal Rank Fusion.

    Retourne une liste de tuples (score, fpath, fname, cat, tags, source_trust).
    Si exclude_untrusted=True, filtre les documents marqués 'untrusted_email'.

    Fusion: score_vecteur × 0.6 + score_bm25 × 0.4 via RRF.
    """
    ensure_source_trust_column(conn)
    log(f"🔍 Recherche hybride: '{query}'")

    query_vec = model.encode([query])[0]

    where_clauses = ["vectorized=1"]
    params = []
    if categories:
        where_clauses.append(
            f"category IN ({','.join('?' * len(categories))})"
        )
        params.extend(categories)
    if exclude_untrusted:
        where_clauses.append("COALESCE(source_trust,'internal') != 'untrusted_email'")

    sql = (
        "SELECT id, path, filename, category, tags, COALESCE(source_trust,'internal') "
        "FROM files WHERE " + " AND ".join(where_clauses)
    )
    rows = conn.execute(sql, params).fetchall()

    if not rows:
        log("Aucun vecteur disponible.")
        return []

    # ── Étape 1 : scores vectoriels ──────────────────────────────────────
    vec_results = []
    for fid, fpath, fname, cat, tags, trust in rows:
        vec = load_vector(fid)
        if vec is None:
            continue
        norm = np.linalg.norm(query_vec) * np.linalg.norm(vec)
        if norm == 0:
            continue
        score = float(np.dot(query_vec, vec) / norm)
        vec_results.append((score, fpath, fname, cat, tags, trust, fid))

    vec_results.sort(key=lambda x: -x[0])

    # ── Étape 2 : scores BM25 ────────────────────────────────────────────
    bm25_available = False
    try:
        from rank_bm25 import BM25Okapi
        bm25_available = True
    except ImportError:
        pass

    if not bm25_available:
        # Fallback purement vectoriel si rank_bm25 absent
        log("⚠️  rank_bm25 absent — recherche vectorielle seule")
        results = [(s, fp, fn, c, t, tr) for s, fp, fn, c, t, tr, _ in vec_results]
        return results[:top_k]

    # Charger ou reconstruire l'index BM25
    index_data = load_bm25_index()
    rebuild_needed = (
        index_data is None
        or index_data.get('exclude_untrusted') != exclude_untrusted
    )
    if rebuild_needed:
        log("🔨 Construction index BM25...")
        index_data = build_bm25_index(conn, exclude_untrusted=exclude_untrusted)
        if index_data:
            save_bm25_index(index_data)
            log(f"✅ Index BM25 construit ({len(index_data.get('ids', []))} docs)")

    bm25_scores = bm25_scores_for_query(index_data, query)

    if not bm25_scores:
        # BM25 vide → fallback vectoriel
        results = [(s, fp, fn, c, t, tr) for s, fp, fn, c, t, tr, _ in vec_results]
        return results[:top_k]

    # ── Étape 3 : RRF fusion ─────────────────────────────────────────────
    all_rows_meta = [(fid, fpath, fname, cat, tags, trust) for fid, fpath, fname, cat, tags, trust in rows]
    results = reciprocal_rank_fusion(
        vec_results, bm25_scores, all_rows_meta, top_k=top_k
    )

    log(f"✅ {len(results)} résultats hybrides (BM25×{WEIGHT_BM25} + vec×{WEIGHT_VECTOR})")
    return results


def stats(conn):
    total = conn.execute("SELECT COUNT(*) FROM files WHERE vectorized=1").fetchone()[0]
    placeholders = ",".join("?" * len(VECTORIZE_CATEGORIES))
    pending = conn.execute(
        f"SELECT COUNT(*) FROM files WHERE vectorized=0 AND category IN ({placeholders})",
        VECTORIZE_CATEGORIES,
    ).fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM files WHERE vectorized=-1").fetchone()[0]
    by_cat = conn.execute("""
        SELECT category, COUNT(*) FROM files WHERE vectorized=1
        GROUP BY category ORDER BY COUNT(*) DESC
    """).fetchall()
    return total, pending, failed, by_cat


def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    search_query = None
    if "--search" in sys.argv:
        idx = sys.argv.index("--search")
        if idx + 1 < len(sys.argv):
            search_query = sys.argv[idx + 1]

    conn = sqlite3.connect(DB_PATH)

    if search_query:
        model = load_model()
        exclude_untrusted = "--trusted-only" in sys.argv
        results = search(conn, model, search_query, exclude_untrusted=exclude_untrusted)
        print(f"\n🔍 Résultats pour '{search_query}':")
        for score, fpath, fname, cat, tags, trust in results:
            trust_tag = '' if trust == 'internal' else f' [{trust}]'
            print(f"  [{score:.4f}] {fname} ({cat}){trust_tag} — {fpath}")
        conn.close()
        return

    if "--stats" in sys.argv:
        total, pending, failed, by_cat = stats(conn)
        print(f"\n📊 Vectorisation:")
        print(f"  Vectorisés : {total:,}")
        print(f"  En attente : {pending:,}")
        print(f"  Échoués    : {failed:,}")
        print(f"\n  Par catégorie:")
        for cat, cnt in by_cat:
            print(f"    {cat:15s}: {cnt:,}")
        conn.close()
        return

    if "--rebuild-bm25" in sys.argv:
        # Force rebuild de l'index BM25
        if os.path.exists(BM25_INDEX_PATH):
            os.remove(BM25_INDEX_PATH)
        log("🔨 Rebuild index BM25 forcé...")
        index_data = build_bm25_index(conn)
        if index_data:
            save_bm25_index(index_data)
            log(f"✅ Index BM25 reconstruit ({len(index_data.get('ids', []))} docs)")
        else:
            log("❌ Aucun doc à indexer")
        conn.close()
        return

    model = load_model()
    done = vectorize_pending(conn, model, verbose=verbose)
    total, pending, failed, _ = stats(conn)
    log(f"📊 Total vectorisés: {total} | En attente: {pending} | Échoués: {failed}")
    conn.close()


if __name__ == "__main__":
    main()
