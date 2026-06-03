#!/usr/bin/env bash
# Aggregate captured wedge dossiers → surface the common factor (the cause).
# Usage: claudeclaw-wedge-summary.sh [dossier_root]
set -u
ROOT="${1:-$HOME/.claude/claudeclaw/wedge-dossiers}"

mapfile -t DIRS < <(ls -1dt "$ROOT"/*/ 2>/dev/null)
[ "${#DIRS[@]}" -eq 0 ] && { echo "no dossiers in $ROOT"; exit 0; }

api_present() {  # yes iff a real ss row (starts with ESTAB) to :443 exists.
  # The descriptive header "-- ESTABLISHED to :443 …" starts with "--", so
  # anchoring on ^ESTAB excludes it; :4632 (bus IPC) is normal and ignored.
  grep -E '^ESTAB' "$1" 2>/dev/null | grep -qE ':443\b' && echo yes || echo no
}

echo "=== ${#DIRS[@]} wedge dossier(s) in $ROOT ==="
printf '%-19s  %-16s  %-7s  %-6s  %-7s  %s\n' WHEN MAIN_WCHAN API_SOCK EVENTS COMPACT GAP_s
for d in "${DIRS[@]}"; do
  f="$d/dossier.txt"; [ -f "$f" ] || continue
  when=$(grep -m1 '^captured_at:'  "$f" | awk '{print $2}')
  wchan=$(grep -m1 '^main/wchan:'  "$f" | awk '{print $2}')
  events=$(grep -m1 'size_bytes:'  "$f" | grep -oE 'events: [0-9]+' | awk '{print $2}')
  compact=$(grep -m1 'compaction_events_in_session:' "$f" | awk '{print $2}')
  gap=$(grep -m1 'age_s:'          "$f" | grep -oE 'age_s: [0-9]+' | awk '{print $2}')
  printf '%-19s  %-16s  %-7s  %-6s  %-7s  %s\n' \
    "${when:0:19}" "${wchan:-?}" "$(api_present "$f")" "${events:-?}" "${compact:-?}" "${gap:-?}"
done

echo
echo "=== common factor: main_wchan tally ==="
for d in "${DIRS[@]}"; do grep -m1 '^main/wchan:' "$d/dossier.txt" 2>/dev/null | awk '{print $2}'; done \
  | sort | uniq -c | sort -rn

echo "=== API-socket tally (yes ⇒ API/stream hang suspect · no ⇒ CLI lost-prompt suspect) ==="
for d in "${DIRS[@]}"; do api_present "$d/dossier.txt"; done | sort | uniq -c | sort -rn

echo
echo "Read a full dossier: cat \"${DIRS[0]}dossier.txt\""
