#!/usr/bin/env python3
"""
Template for writing a skills-tuner subject as an external process (Python).

Usage from TS:
    new ExternalProcessSubject({
        name: 'my-python-subject',
        command: ['python3', '/path/to/this/file.py'],
        config: { ... }
    })

Protocol (stdio):
    stdin:  {"method": "<name>", "payload": {...}, "config": {...}}
    stdout: {"result": <data>}  OR  {"error": "<message>"}

Methods to implement:
    - collect_observations: payload.since (ISO date) -> list[Observation]
    - detect_problems: payload.observations -> list[Cluster]
    - propose_change: payload.cluster -> Proposal
    - apply: payload.proposal + payload.alternative_id -> Patch
    - validate: payload.patch -> ValidationResult
"""
import json
import sys
import subprocess

# ── v2 Proposer — failure-mode taxonomy ──────────────────────────────────────
# Replace these with failure modes specific to your domain.
# Examples:
#   cron/automation: "wrong-schedule | missed-dependency | stale-success-rate | schedule-conflict"
#   voice/intent:    "wrong-intent | missing-slot | ambiguous-trigger | over-eager-match"
#   trading/ML:      "stale-signal | parameter-drift | overfitted-threshold | regime-mismatch"
FAILURE_MODES = (
    "wrong-trigger | vague-instructions | missing-edge-case | "
    "wrong-tool-selection | ambiguous-output | over-eager-activation | "
    "under-specified-scope | format-mismatch"
)

# ── v2 system prompt — all 6 checklist properties ────────────────────────────
# 1. Named-taxonomy diagnosis step
# 2. Cosmetic-variant ban
# 3. Specific-label requirement (change not form)
# 4. Tradeoff = improvement + new risk (both halves)
# 5. First-char-[ constraint (no prose preamble)
# 6. Language hint (from config.language)
_PROPOSER_SYSTEM = """\
You are improving a tunable subject configuration based on user feedback signals.

Procedure:
1. Diagnose the failure pattern. Pick exactly one from: {failure_modes}. State the category and root cause in one sentence.
2. Propose 3 alternatives that EACH address the diagnosis with a DIFFERENT strategy. \
Reject cosmetic-only variants — whitespace, header reordering, or copy-only changes do NOT count as distinct angles.
3. Each label must describe the change being made (e.g. 'Add retry on transient timeout'), not the form ('Concise version').
4. Each tradeoff must state what becomes better AND what new risk this introduces \
(e.g. 'Catches missed events but increases latency per observation window').

Constraints:
- diff_or_content must be the COMPLETE revised content ready to apply to disk.
- Reply ONLY with a JSON array of 3 objects: [{{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."}}, ...].
- The VERY FIRST character of your reply MUST be "[" — no prose, no markdown, no preamble before the array.
- Write 'label' and 'tradeoff' in {language}.\
"""


def _extract_json_array(text: str) -> str:
    """Pick the substring from first '[' to last ']' to survive prose preamble."""
    text = text.strip()
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        return text[start:end + 1]
    return text


def _call_llm(system: str, user: str, model: str = "claude-sonnet-4-6", _max_tokens: int = 4000) -> str:
    """
    Call the LLM via the claude CLI. Mirrors the TS-side ClaudeCliBackend:
    --print for non-interactive mode, --model for routing,
    --append-system-prompt so the system text reaches Claude as the system
    role, user content via stdin to dodge the argv length limit on long
    prompts.

    Note: the claude CLI does NOT accept --max-tokens — token limits are
    governed implicitly by the model. The argument is kept here only for
    API parity with callers that pass one in. Override by passing
    config["llm_command"] for a different binary or API adapter.
    """
    result = subprocess.run(
        ["claude", "--print", "--model", model, "--append-system-prompt", system],
        input=user, capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"LLM call failed: {result.stderr[:300]}")
    return result.stdout


def collect_observations(payload, config):
    # since = payload.get("since")  # ISO datetime string
    return []


def detect_problems(payload, config):
    # observations = payload.get("observations", [])
    return []


def propose_change(payload, config):
    cluster = payload.get("cluster", {})
    language = config.get("language", "en")
    model = config.get("proposer_model", "claude-sonnet-4-6")

    observations = cluster.get("observations", [])
    evidence = "\n".join(
        f"- [{o.get('signal_type', '?')}] {o.get('verbatim', '')}"
        for o in observations[:6]
    )
    frequency = cluster.get("frequency", len(observations))
    sentiment = cluster.get("sentiment", "negative")
    subjects_touched = cluster.get("subjects_touched", [])
    subject_label = subjects_touched[0] if subjects_touched else "unknown"

    system = _PROPOSER_SYSTEM.format(failure_modes=FAILURE_MODES, language=language)
    user = (
        f"Subject: {subject_label}\n"
        f"Signals (frequency={frequency}, sentiment={sentiment}):\n{evidence}\n\n"
        "Identify the failure pattern in one sentence, then propose 3 behavior-changing alternatives."
    )

    raw = _call_llm(system, user, model=model)
    alternatives = json.loads(_extract_json_array(raw))

    cluster_id = cluster.get("id", "unknown")
    return {
        "id": 0,
        "cluster_id": cluster_id,
        "subject": cluster.get("subject", "external"),
        "kind": "patch",
        "target_path": config.get("target_path", ""),
        "alternatives": [
            {
                "id": a.get("id", str(i)),
                "label": a.get("label", ""),
                "diff_or_content": a.get("diff_or_content", ""),
                "tradeoff": a.get("tradeoff", ""),
            }
            for i, a in enumerate(alternatives[:3])
        ],
        "pattern_signature": f"external:{subject_label}:patch",
        "created_at": None,
    }


def apply(payload, config):
    raise NotImplementedError("apply not implemented")


def validate(payload, config):
    return {"valid": True}


DISPATCH = {
    "collect_observations": collect_observations,
    "detect_problems": detect_problems,
    "propose_change": propose_change,
    "apply": apply,
    "validate": validate,
}

if __name__ == "__main__":
    try:
        req = json.loads(sys.stdin.read())
        method = req["method"]
        if method not in DISPATCH:
            print(json.dumps({"error": f"unknown method: {method}"}))
            sys.exit(0)
        result = DISPATCH[method](req.get("payload", {}), req.get("config", {}))
        print(json.dumps({"result": result}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
