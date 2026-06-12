# archiviste (vendored)

RAG document daemon (hybrid BM25 + vector search, nightly auto-vectorization).
Versioned snapshot of the personal archiviste stack, vendored into `features`.

- `daemon.py` — the search/index daemon.
- `scripts/` — helper tooling (vectorize, reclassify, report, vault, OCR, email ingest).
- `systemd/archiviste-daemon.service` — the service unit (reference; the live
  daemon runs from `~/agent/archiviste/`).

Runtime DATA (index DB, vectors, vault) lives in `~/agent/data/` and is NOT in
this repo. This snapshot is for version control + portability of the code only.
