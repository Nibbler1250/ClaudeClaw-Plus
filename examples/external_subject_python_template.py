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


def collect_observations(payload, config):
    # since = payload.get("since")  # ISO datetime string
    return []


def detect_problems(payload, config):
    # observations = payload.get("observations", [])
    return []


def propose_change(payload, config):
    raise NotImplementedError("propose_change not implemented")


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
