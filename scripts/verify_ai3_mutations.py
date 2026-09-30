#!/usr/bin/env python3
"""Repository-contained AI-3 historical mutation verifier (F1-A).

Consumes the CURRENT normalized manifest. One canonical verdict model. Semantic
attribution ONLY through exact structured Vitest `fullName` equality. Destructive
mutations execute only inside dynamically created disposable capsules.

The repository root is derived from this file's own location. No user-home, tool
home or fixed scratch location is read or required at any point.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# 1. CANONICAL VERDICT MODEL
#
# THREE DISTINCT RESPONSIBILITIES. They are never collapsed into one another:
#
#   classify_process_result(...)        process HEALTH only. Carries no polarity.
#   classify_designated_test_result(...) the SOLE semantic mutation polarity, and
#                                      only ever from the exact designated test.
#   compare_observed_to_expected(...)    expectation reconciliation.
#
# A process exit code is NEVER a caught/survived polarity. `0 -> CAUGHT` and
# `non-zero -> SURVIVED` adapters do not exist in this module.
# ---------------------------------------------------------------------------
CAUGHT = "CAUGHT"
SURVIVED = "SURVIVED_AS_EXPECTED"
PIN_GREEN = "PIN_GREEN"
RETIRED = "RETIRED_BY_ARCHITECTURE"

# Expected verdicts: the ONLY tokens a normalized obligation may declare.
EXPECTED_VERDICTS = (CAUGHT, SURVIVED, PIN_GREEN, RETIRED)

# Non-verdict outcomes. These are never downgraded to, or upgraded into, a
# semantic mutation verdict.
STRUCTURAL_INVALID = "STRUCTURAL_INVALID"
WITNESS_FAILURE = "WITNESS_FAILURE"
VERDICT_MISMATCH = "VERDICT_MISMATCH"
CONTROL_GREEN = "CONTROL_GREEN"
# Declared for reconciliation reporting only. NO classifier in this module emits
# it, and infrastructure failure is never reported as NOT_PROVEN.
NOT_PROVEN = "NOT_PROVEN"

NON_VERDICT_OUTCOMES = (STRUCTURAL_INVALID, WITNESS_FAILURE, VERDICT_MISMATCH,
                        CONTROL_GREEN)
OBSERVED_OUTCOMES = frozenset(EXPECTED_VERDICTS + NON_VERDICT_OUTCOMES
                              + (NOT_PROVEN,))
# Obligations carrying these expected verdicts must never enter the destructive
# executor. They run their own non-destructive control / pin evidence plan.
NON_DESTRUCTIVE_VERDICTS = frozenset({PIN_GREEN, RETIRED})


def classify_process_result(code: Any, error: Optional[str] = None) -> Dict[str, Any]:
    """PROCESS HEALTH ONLY. This function can never produce a semantic mutation
    verdict. `carries_semantic_verdict` is structurally False on every path."""
    if error:
        return {"state": "PROCESS_FAILED", "code": None,
                "carries_semantic_verdict": False, "detail": str(error)}
    if not isinstance(code, int) or isinstance(code, bool):
        return {"state": "INVALID_EXIT_CODE", "code": code,
                "carries_semantic_verdict": False,
                "detail": "vitest exit code is not a non-bool int"}
    return {"state": "COMPLETED", "code": code,
            "carries_semantic_verdict": False,
            "detail": "process rc=%d (diagnostic only; never a semantic verdict)" % code}


# The exact designated test result is the SOLE mutation polarity.
DESIGNATED_STATUS_OUTCOME = {"failed": CAUGHT, "passed": SURVIVED}


def classify_designated_test_result(status: Any) -> Dict[str, str]:
    """DESIGNATED TEST OUTCOME. failed -> CAUGHT (mutation caught),
    passed -> SURVIVED (mutation escaped). pending / skipped / todo / unknown /
    absent are STRUCTURAL_INVALID: they are never CAUGHT and never NOT_PROVEN."""
    if isinstance(status, str) and status in DESIGNATED_STATUS_OUTCOME:
        return {"outcome": DESIGNATED_STATUS_OUTCOME[status],
                "reason": "exact designated test %s" % status}
    return {"outcome": STRUCTURAL_INVALID,
            "reason": "designated test status %r is not an executable pass/fail "
                      "result; a non-executing test is a structural failure, not a "
                      "verdict" % (status,)}


def classify_control_result(status: Any, expected: Any) -> Dict[str, str]:
    """NON-DESTRUCTIVE control / pin. No mutation is applied. The designated pin
    assertion must PASS, and only then is the control green."""
    if expected not in NON_DESTRUCTIVE_VERDICTS:
        return {"outcome": STRUCTURAL_INVALID,
                "reason": "non-destructive obligation declares a non-control "
                          "expected verdict %r" % (expected,)}
    if status != "passed":
        return {"outcome": WITNESS_FAILURE,
                "reason": "non-destructive control/pin designated test status %r; a "
                          "pin is green only when its designated assertion passes" % (status,)}
    return {"outcome": CONTROL_GREEN,
            "reason": "non-destructive control/pin designated assertion PASSED with "
                      "zero mutations applied"}


def compare_observed_to_expected(observed: Any, expected: Any) -> str:
    """Explicit expectation reconciliation. The expected token is NEVER changed to
    match an observation."""
    if observed in NON_VERDICT_OUTCOMES and observed != CONTROL_GREEN:
        return str(observed)
    if observed == expected:
        return str(expected)
    if observed == CONTROL_GREEN and expected in NON_DESTRUCTIVE_VERDICTS:
        return str(expected)
    return VERDICT_MISMATCH


def known_expected_verdict(v: Any) -> bool:
    return isinstance(v, str) and v in EXPECTED_VERDICTS


# ---------------------------------------------------------------------------
# 2. REPOSITORY ROOT DISCOVERY  (from this file's own location, never the cwd)
# ---------------------------------------------------------------------------
def repo_root() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(8):
        if os.path.isfile(os.path.join(cur, "scripts", "ai3_mutation_manifest.json")):
            return cur
        cur = os.path.dirname(cur)
    raise RuntimeError("repository root not found from %r" % here)


ROOT = repo_root()
MANIFEST = os.path.join(ROOT, "scripts", "ai3_mutation_manifest.json")

# Every absolute path this module binds at import time. Self-test U proves this
# set is contained in the __file__-derived repository root plus the dynamically
# resolved system temp directory, and nothing else.
MODULE_ABSOLUTE_PATHS: Tuple[str, ...] = tuple(
    sorted({v for v in (ROOT, MANIFEST) if os.path.isabs(v)})
)

# ---------------------------------------------------------------------------
# 3. CURRENT MANIFEST SCHEMA
# ---------------------------------------------------------------------------
ROW_TYPES = ("SINGLE", "TYPE_B_MULTI_PREDICATE", "VARIANT_SET",
             "SHARED_GUARD_SCENARIO", "RETIRED_BY_ARCHITECTURE")
MUTATION_KEYS = ("file", "anchor", "replacement")
# The exhaustive set of keys the strict parser is permitted to read. Anything
# outside it (descriptive prose, `notes`, `legacy`) is non-authoritative by
# construction and is proven so by the differential strip self-test.
AUTHORITATIVE_ROW_KEYS = frozenset({
    "id", "row_type", "obligation_id", "designation", "witness",
    "expected_verdict", "mutation", "mutation_owner", "components",
    "subobligations", "scenarios", "variants",
})
AUTHORITATIVE_OBLIGATION_KEYS = frozenset({
    "obligation_id", "sub_id", "variant_id", "scenario_id", "designation",
    "witness", "expected_verdict", "mutation", "mutation_owner", "components",
})
AUTHORITATIVE_COMPONENT_KEYS = frozenset({"id", "file", "anchor", "replacement"})

_RECORD_KEYS = {"TYPE_B_MULTI_PREDICATE": ("subobligations", "sub_id"),
                "VARIANT_SET": ("variants", "variant_id"),
                "SHARED_GUARD_SCENARIO": ("scenarios", "scenario_id")}


def _token(tok: Any) -> str:
    return str(tok).strip().lstrip("[").rstrip("]")


def _witness_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v else []
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str) and x]
    return []


def _problem(code: str, where: str, detail: str) -> Dict[str, str]:
    return {"code": code, "where": where, "detail": detail}


def _codes(problems: List[Dict[str, str]], *codes: str) -> List[str]:
    return ["%s: %s" % (p["where"], p["detail"])
            for p in problems if p["code"] in codes]


# ---------------------------------------------------------------------------
# 4. MUTATION REGISTRY  (each mutation definition exists exactly once)
# ---------------------------------------------------------------------------
def build_mutation_registry(manifest: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """owner id -> mutation definition. Owners are SINGLE rows,
    SHARED_GUARD_SCENARIO rows, VARIANT_SET rows (component sets) and
    self-mutating subobligations. A duplicate owner id is reported."""
    reg: Dict[str, Any] = {}
    dup: List[str] = []
    for row in manifest.get("rows") or []:
        if not isinstance(row, dict):
            continue
        rid = row.get("id")
        if not isinstance(rid, str) or not rid:
            continue
        if isinstance(row.get("mutation"), dict):
            if rid in reg:
                dup.append(rid)
            reg[rid] = {"form": "single", "mutation": row["mutation"]}
        comps = row.get("components")
        if isinstance(comps, list) and comps:
            if rid in reg:
                dup.append(rid)
            reg[rid] = {"form": "components",
                        "components": {c.get("id"): c for c in comps
                                       if isinstance(c, dict)}}
        for rec in row.get("subobligations") or []:
            if not isinstance(rec, dict):
                continue
            key = rec.get("obligation_id")
            if isinstance(key, str) and isinstance(rec.get("mutation"), dict):
                if key in reg:
                    dup.append(key)
                reg[key] = {"form": "single", "mutation": rec["mutation"]}
    return reg, dup


def _resolve_specs(obligation: str, owner: Any, active: Optional[List[str]],
                   reg: Dict[str, Any],
                   problems: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    """Resolve ONE destructive obligation to its concrete mutation definitions.
    Resolution is a pure explicit-reference lookup. Nothing is inferred."""
    if not isinstance(owner, str) or not owner:
        problems.append(_problem("MUTATION_OWNER_MISSING", obligation,
                                 "destructive obligation declares no explicit mutation_owner"))
        return []
    entry = reg.get(owner)
    if entry is None:
        problems.append(_problem("MUTATION_OWNER_UNKNOWN", obligation,
                                 "mutation_owner %r defines no mutation" % owner))
        return []
    if entry["form"] == "single":
        specs = [entry["mutation"]]
    else:
        specs = []
        for cid in (active or []):
            c = entry["components"].get(cid)
            if c is None:
                problems.append(_problem("MUTATION_COMPONENT_UNKNOWN", obligation,
                                         "component %r is not defined by %r" % (cid, owner)))
                continue
            specs.append(c)
        if not specs and not problems:
            problems.append(_problem("MUTATION_COMPONENT_UNKNOWN", obligation,
                                     "variant activates no component"))
    for s in specs:
        for need in MUTATION_KEYS:
            if not isinstance(s.get(need), str) or not s[need]:
                problems.append(_problem("MUTATION_SPEC_INVALID", obligation,
                                         "mutation definition %r has no %s" % (owner, need)))
    return specs


# ---------------------------------------------------------------------------
# 5. CURRENT MANIFEST PARSER  ->  normalized semantic obligations
# ---------------------------------------------------------------------------
def normalize(manifest: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """Every verdict-bearing execution exists here BEFORE any capsule work."""
    rows = manifest.get("rows")
    if not isinstance(rows, list) or not rows:
        return [], [_problem("ROWS_MISSING", "manifest", "manifest has no rows list")]
    reg, dup = build_mutation_registry(manifest)
    obs: List[Dict[str, Any]] = []
    problems: List[Dict[str, str]] = []
    for d in sorted(set(dup)):
        problems.append(_problem("MUTATION_OWNER_DUPLICATE", d,
                                 "mutation definition declared more than once"))

    for idx, row in enumerate(rows):
        where = "rows[%d]" % idx
        if not isinstance(row, dict):
            problems.append(_problem("ROW_NOT_OBJECT", where, "row is not an object"))
            continue
        rid = row.get("id")
        if not isinstance(rid, str) or not rid:
            problems.append(_problem("ROW_NO_ID", where, "row without string id"))
            continue
        where = rid
        rt = row.get("row_type")
        if rt is None:
            problems.append(_problem("ROW_TYPE_MISSING", where, "row declares no row_type"))
            continue
        if rt not in ROW_TYPES:
            problems.append(_problem("ROW_TYPE_INVALID", where,
                                     "row_type %r is not a current row type" % rt))
            continue

        if rt in ("SINGLE", "RETIRED_BY_ARCHITECTURE"):
            label = row.get("obligation_id")
            if not isinstance(label, str) or not label:
                problems.append(_problem("OBLIGATION_ID_MISSING", where,
                                         "%s row declares no stable explicit obligation_id" % rt))
                label = where
            obs.append(_obligation(row, row, label, label, "single", reg, problems))
            continue

        key, sub_key = _RECORD_KEYS[rt]
        recs = row.get(key)
        if not isinstance(recs, list) or not recs:
            problems.append(_problem("RECORDS_MISSING", where,
                                     "%s row declares no %s" % (rt, key)))
            continue
        for j, rec in enumerate(recs):
            if not isinstance(rec, dict):
                problems.append(_problem("RECORD_NOT_OBJECT", "%s.%s[%d]" % (rid, key, j),
                                         "obligation record is not an object"))
                continue
            label = rec.get("obligation_id")
            if not isinstance(label, str) or not label:
                label = "%s.%s[%d]" % (rid, key, j)
                problems.append(_problem("OBLIGATION_ID_MISSING", label,
                                         "obligation record has no stable explicit id"))
            obs.append(_obligation(rec, row, label, label, rec.get(sub_key), reg, problems))
    return obs, problems


def _obligation(rec: Dict[str, Any], row: Dict[str, Any], label: str, where: str,
                sub_id: Optional[str], reg: Dict[str, Any],
                problems: List[Dict[str, str]]) -> Dict[str, Any]:
    ob: Dict[str, Any] = {"obligation": label, "row": row.get("id"),
                          "kind": rec.get("row_type", row.get("row_type")),
                          "sub_id": sub_id,
                          "verdict_source": None, "specs": []}
    if "variant_id" in rec:
        ob["kind"] = "variant"
    elif "scenario_id" in rec:
        ob["kind"] = "scenario"
    elif "sub_id" in rec:
        ob["kind"] = "subobligation"

    ob["designation"] = _token(rec.get("designation", ""))
    if not ob["designation"]:
        problems.append(_problem("DESIGNATION_MISSING", where, "obligation declares no designation"))

    ob["witness"] = _witness_list(rec.get("witness"))
    if not ob["witness"]:
        problems.append(_problem("WITNESS_MISSING", where, "obligation declares no witness"))

    if "expected_verdict" not in rec:
        problems.append(_problem("EXPECTED_VERDICT_MISSING", where,
                                 "obligation declares no expected_verdict; there is no default"))
    else:
        exp = rec.get("expected_verdict")
        ob["verdict_source"] = "expected_verdict"
        if not known_expected_verdict(exp):
            problems.append(_problem("EXPECTED_VERDICT_INVALID", where,
                                     "expected_verdict %r is not a canonical token" % exp))
        else:
            ob["expected"] = exp

    ob["destructive"] = ob.get("expected") not in NON_DESTRUCTIVE_VERDICTS
    if ob["destructive"]:
        own = rec.get("mutation")
        owner = rec.get("mutation_owner")
        if isinstance(own, dict) and isinstance(owner, str) and owner != label:
            problems.append(_problem("SHARER_DECLARES_MUTATION", where,
                                     "sharer duplicates owner mutation %r" % owner))
        ob["mutation_owner"] = owner
        ob["specs"] = _resolve_specs(label, owner, rec.get("components"), reg, problems)
        ob["active_components"] = list(rec.get("components") or []) or None
    else:
        ob["mutation_owner"] = None
        ob["active_components"] = None
    return ob


# ---------------------------------------------------------------------------
# 6. EXECUTION PLANNER  (independent traversal; never reuses normalize()'s output)
# ---------------------------------------------------------------------------
def plan_execution(manifest: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    """PLANNED_VERDICT_IDS: every semantic obligation the planner intends to
    execute and attribute a semantic verdict to. Destructive obligations are
    planned for capsule mutation; controls/pins are explicitly excluded from
    destructive execution and planned under their own non-destructive evidence
    plan. This traversal is written independently of normalize() so that the
    post-normalization accounting in section 7 is a real cross-check."""
    planned: Dict[str, Dict[str, str]] = {}
    for row in manifest.get("rows") or []:
        if not isinstance(row, dict):
            continue
        rid = row.get("id")
        rt = row.get("row_type")
        if not isinstance(rid, str) or not rid or rt not in ROW_TYPES:
            continue
        if rt in ("SINGLE", "RETIRED_BY_ARCHITECTURE"):
            oid = row.get("obligation_id")
            if not isinstance(oid, str) or not oid:
                continue
            rec = row
        else:
            key = _RECORD_KEYS[rt][0]
            recs = row.get(key)
            if not isinstance(recs, list):
                continue
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                oid = rec.get("obligation_id")
                if not isinstance(oid, str) or not oid:
                    continue
                # plan kind is a scheduling decision, never a semantic verdict
                kind = ("CONTROL" if rec.get("expected_verdict") in NON_DESTRUCTIVE_VERDICTS
                        else "DESTRUCTIVE")
                planned[oid] = {"kind": kind, "owner": rec.get("mutation_owner") or ""}
            continue
        kind = ("CONTROL" if rec.get("expected_verdict") in NON_DESTRUCTIVE_VERDICTS
                else "DESTRUCTIVE")
        planned[oid] = {"kind": kind, "owner": rec.get("mutation_owner") or ""}
    return planned


def post_normalization_accounting(manifest: Dict[str, Any],
                                  obs: List[Dict[str, Any]],
                                  planned: Optional[Dict[str, Dict[str, str]]] = None
                                  ) -> Dict[str, Any]:
    """NORMALIZED_IDS vs PLANNED_VERDICT_IDS. Both sets are computed, never
    asserted. Controls/pins stay in the plan (non-destructive evidence plan) and
    are excluded from destructive execution."""
    normalized: Set[str] = {o["obligation"] for o in obs}
    required: Set[str] = {o["obligation"] for o in obs if known_expected_verdict(o.get("expected"))}
    if planned is None:
        planned = plan_execution(manifest)
    return {
        "normalized_ids": len(normalized),
        "required_verdict_ids": len(required),
        "planned_verdict_ids": len(planned),
        "planned_destructive": sorted(k for k, v in planned.items() if v["kind"] == "DESTRUCTIVE"),
        "planned_controls": sorted(k for k, v in planned.items() if v["kind"] == "CONTROL"),
        "post_normalization_extras": sorted(set(planned) - normalized),
        "missing_planned_obligations": sorted(required - set(planned)),
    }


# ---------------------------------------------------------------------------
# 7. EXACT STRUCTURED VITEST IDENTITY
#
# DISCOVERY uses exact string equality on bracket-delimited segments parsed out of
# the structured `fullName` field. That is equality on a delimited structured
# field, NOT substring / prefix / suffix / token-containment matching.
# ATTRIBUTION then uses exact equality on the COMPLETE `fullName`.
# ---------------------------------------------------------------------------
_SEGMENT_RE = re.compile(r"\[([^\[\]]+)\]")


def designation_segments(full_name: str) -> List[str]:
    """Bracket-delimited structured segments of a fullName, brackets removed."""
    if not isinstance(full_name, str):
        return []
    return _SEGMENT_RE.findall(full_name)


def extract_json(text: str) -> Optional[dict]:
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(text[i:j + 1])
    except (ValueError, TypeError):
        return None


def assertion_results(doc: Optional[dict]) -> List[Dict[str, Any]]:
    return [a for s in (doc or {}).get("testResults", [])
            for a in s.get("assertionResults", []) if isinstance(a, dict)]


def results_by_witness_file(doc: Optional[dict]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for s in (doc or {}).get("testResults", []):
        key = os.path.basename(str(s.get("name", "")))
        out.setdefault(key, []).extend(
            a for a in s.get("assertionResults", []) if isinstance(a, dict))
    return out


def runtime_identities(doc: Optional[dict]) -> List[str]:
    return [a.get("fullName", "") for a in assertion_results(doc) if a.get("fullName")]


def failed_identities(doc: Optional[dict]) -> List[str]:
    return [a.get("fullName", "") for a in assertion_results(doc)
            if a.get("status") == "failed"]


def discover_identities(identities: List[str], designation: str) -> Tuple[Optional[str], str]:
    """DISCOVERY. Exactly one fullName must contain a bracket-delimited segment
    whose CONTENT is exactly equal to the manifest designation.
    0 matches -> MISSING. >1 -> DUPLICATE. Both are STRUCTURAL."""
    hits = [f for f in identities if designation in designation_segments(f)]
    if len(hits) == 1:
        return hits[0], "EXACT"
    return None, ("MISSING" if not hits else "DUPLICATE")


def attribute_designated_result(results: List[Dict[str, Any]],
                                resolved_fullname: Optional[str]
                                ) -> Tuple[Optional[Dict[str, Any]], str]:
    """ATTRIBUTION. Exact equality on the COMPLETE fullName that discovery kept.
    Nothing similar, neighbouring or partial can receive the verdict."""
    if not isinstance(resolved_fullname, str) or not resolved_fullname:
        return None, "UNRESOLVED"
    hits = [r for r in results if r.get("fullName") == resolved_fullname]
    if len(hits) == 1:
        return hits[0], "EXACT"
    return None, ("MISSING" if not hits else "DUPLICATE")


def collateral_failures(results: List[Dict[str, Any]],
                        resolved_fullname: Optional[str]) -> List[str]:
    """Recorded separately. A collateral failure can NEVER become the designated
    obligation's semantic verdict."""
    return sorted({str(r.get("fullName", "")) for r in results
                   if r.get("status") == "failed" and r.get("fullName") != resolved_fullname})


# ---------------------------------------------------------------------------
# 8. DISPOSABLE CAPSULE
# ---------------------------------------------------------------------------
def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# What a real execution capsule materializes. Never .git, never build output,
# never capsule output, never a reporter artifact, never a fixed scratch path.
# The content list is derived from what the witnesses actually resolve at run
# time: they read `process.cwd()/src`, `.../server`, `.../tests`, `.../scripts`
# and the pinned USDA fixture under `.../data/advanced-nutrition/usda/...`.
# `--identity-preflight` is the standing proof that this list is complete: a
# witness needing anything else fails collection and is reported MISSING.
CAPSULE_CONTENT_DIRS = ("src", "server", "tests", "scripts", "data")
CAPSULE_ROOT_FILES = ("package.json", "tsconfig.json", "vite.config.ts",
                      "vitest.config.ts")
CAPSULE_IGNORE = shutil.ignore_patterns(
    "node_modules", "__pycache__", "*.pyc", "*.pyo", ".git", "dist", "build",
    "coverage", ".test_obsidian_vault*", "ai3-capsule-*", "*.log",
    ".ai3-vitest-report.json")
CAPSULE_REPORT_NAME = ".ai3-vitest-report.json"


class Capsule:
    """Disposable copy. Regular files are real copies (never hardlinks).
    node_modules is an external symlink and is never copied or traversed."""

    def __init__(self, root: str = ROOT):
        self.dir = tempfile.mkdtemp(prefix="ai3-capsule-")
        self.src = root

    def materialize(self, rels: List[str]) -> None:
        for rel in rels:
            s = os.path.join(self.src, rel)
            d = os.path.join(self.dir, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            if os.path.isdir(s):
                shutil.copytree(s, d, symlinks=True,
                                ignore=shutil.ignore_patterns("node_modules"))
            elif os.path.exists(s):
                shutil.copy2(s, d)
        nm = os.path.join(self.src, "node_modules")
        link = os.path.join(self.dir, "node_modules")
        if os.path.isdir(nm) and not os.path.lexists(link):
            os.symlink(os.path.realpath(nm), link)

    def materialize_repository(self) -> List[str]:
        """Materialize the repository content a real witness execution needs."""
        copied: List[str] = []
        for rel in CAPSULE_CONTENT_DIRS:
            s = os.path.join(self.src, rel)
            if not os.path.isdir(s):
                continue
            shutil.copytree(s, os.path.join(self.dir, rel), symlinks=True,
                            ignore=CAPSULE_IGNORE)
            copied.append(rel)
        for rel in CAPSULE_ROOT_FILES:
            s = os.path.join(self.src, rel)
            if os.path.isfile(s):
                shutil.copy2(s, os.path.join(self.dir, rel))
                copied.append(rel)
        nm = os.path.join(self.src, "node_modules")
        link = os.path.join(self.dir, "node_modules")
        if os.path.isdir(nm) and not os.path.lexists(link):
            os.symlink(os.path.realpath(nm), link)
            copied.append("node_modules->external-symlink")
        return copied

    def isolation_defects(self, rels: List[str]) -> List[str]:
        """A mutation target inside the capsule must be an independent regular
        file: never a hardlink, never the same inode as the source."""
        defects: List[str] = []
        for rel in rels:
            p = os.path.join(self.dir, rel)
            s = os.path.join(self.src, rel)
            if not os.path.exists(p):
                defects.append("%s: absent from capsule" % rel)
                continue
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                defects.append("%s: capsule target is a symlink" % rel)
                continue
            if st.st_nlink > 1:
                defects.append("%s: nlink=%d (possible hardlink)" % (rel, st.st_nlink))
            if os.path.isfile(s) and os.path.samefile(p, s):
                defects.append("%s: capsule target is the same inode as the source" % rel)
        return defects

    def apply(self, rel: str, anchor: str, replacement: str) -> Dict[str, Any]:
        target = os.path.join(self.dir, rel)
        pre = sha256_of(target)
        text = open(target, encoding="utf-8").read()
        n = text.count(anchor)
        if n != 1:
            raise ValueError("anchor count %d (need exactly 1) for %s" % (n, rel))
        open(target, "w", encoding="utf-8").write(text.replace(anchor, replacement, 1))
        post = sha256_of(target)
        return {"anchor_count": n, "mutation_applied": post != pre,
                "pre_sha": pre, "post_sha": post}

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def __enter__(self) -> "Capsule":
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False


# ---------------------------------------------------------------------------
# 9. DIFFERENTIAL LEGACY STRIP  (proves no legacy field is authoritative)
# ---------------------------------------------------------------------------
def strip_to_current_schema(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Delete every key the strict parser is not permitted to read: all
    descriptive prose, all `notes`, all `legacy`, and every historical field the
    retired schema used (`classification`, `mutate`, `sub`, `row_id`, boolean
    `mutation_owner`/`owner`, `runtime_designations`, `submutations`,
    `scenario_designations`, `variant_expectations`, `combined`, ...)."""
    out: Dict[str, Any] = {}
    for k, v in manifest.items():
        if k in ("manifest_version", "rows"):
            out[k] = v
    rows = []
    for row in manifest.get("rows") or []:
        if not isinstance(row, dict):
            rows.append(row)
            continue
        nr = {k: v for k, v in row.items() if k in AUTHORITATIVE_ROW_KEYS}
        for key in ("subobligations", "variants", "scenarios"):
            if key in nr:
                nr[key] = [{k: v for k, v in rec.items()
                            if k in AUTHORITATIVE_OBLIGATION_KEYS}
                           if isinstance(rec, dict) else rec for rec in nr[key]]
        if isinstance(nr.get("components"), list):
            nr["components"] = [{k: v for k, v in c.items()
                                 if k in AUTHORITATIVE_COMPONENT_KEYS}
                                if isinstance(c, dict) else c for c in nr["components"]]
        rows.append(nr)
    out["rows"] = rows
    return out


def _signature(obs: List[Dict[str, Any]]) -> List[Tuple[Any, ...]]:
    return sorted((o["obligation"], o["kind"], o["designation"], o.get("expected"),
                   bool(o["destructive"]), o.get("mutation_owner"),
                   tuple(sorted((s.get("file"), s.get("anchor"), s.get("replacement"))
                                for s in o["specs"])))
                  for o in obs)


def legacy_authoritative_usage(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """COMPUTED, not declared. Re-normalizes the manifest with every
    non-authoritative key deleted and requires an identical obligation set."""
    base, bp = normalize(manifest)
    stripped, sp = normalize(strip_to_current_schema(manifest))
    identical = _signature(base) == _signature(stripped) and not sp
    return {
        "legacy_authoritative_usage": 0 if identical else len(_codes(
            sp + bp, "EXPECTED_VERDICT_MISSING", "EXPECTED_VERDICT_INVALID",
            "MUTATION_OWNER_MISSING", "MUTATION_OWNER_UNKNOWN", "RECORDS_MISSING",
            "ROW_TYPE_MISSING", "ROW_TYPE_INVALID", "DESIGNATION_MISSING",
            "WITNESS_MISSING", "OBLIGATION_ID_MISSING")) or 1,
        "authoritative_row_keys": len(AUTHORITATIVE_ROW_KEYS),
        "authoritative_obligation_keys": len(AUTHORITATIVE_OBLIGATION_KEYS),
        "strip_normalizes_identically": identical,
    }


# ---------------------------------------------------------------------------
# 10. DRY STRUCTURAL PREFLIGHT  (no destructive execution)
# ---------------------------------------------------------------------------
def dry_preflight(manifest: Dict[str, Any]) -> Dict[str, Any]:
    obs, problems = normalize(manifest)
    acct = post_normalization_accounting(manifest, obs)
    reg, _ = build_mutation_registry(manifest)
    desigs = [o["designation"] for o in obs]
    dupes = sorted({d for d in desigs if desigs.count(d) > 1})
    anchor_bad: List[str] = []
    for o in obs:
        if not o["destructive"]:
            continue
        for sp in o["specs"]:
            p = os.path.join(ROOT, sp.get("file", ""))
            if not os.path.isfile(p):
                anchor_bad.append("%s: missing file %s" % (o["obligation"], sp.get("file")))
                continue
            cnt = open(p, encoding="utf-8").read().count(sp.get("anchor", "\0"))
            if cnt != 1:
                anchor_bad.append("%s: anchor count %d" % (o["obligation"], cnt))
    m54 = [o for o in obs if o["row"] == "M54"]
    return {
        "rows": len({r["id"] for r in manifest.get("rows", [])
                     if isinstance(r, dict) and isinstance(r.get("id"), str)}),
        "obligations": len(obs),
        "problems": ["%s [%s]: %s" % (p["where"], p["code"], p["detail"]) for p in problems],
        "problem_count": len(problems),
        "verdict_bearing": len([o for o in obs if o["destructive"]]),
        "controls_pins": len([o for o in obs if not o["destructive"]]),
        "control_pin_ids": sorted(o["obligation"] for o in obs if not o["destructive"]),
        "designations": len(set(desigs)),
        "duplicate_designations": dupes,
        "missing_designation": _codes(problems, "DESIGNATION_MISSING"),
        "missing_witness": _codes(problems, "WITNESS_MISSING"),
        "invalid_expected_verdicts": _codes(
            problems, "EXPECTED_VERDICT_MISSING", "EXPECTED_VERDICT_INVALID"),
        "implicit_default_verdicts": [o["obligation"] for o in obs
                                      if o.get("verdict_source") != "expected_verdict"],
        "invalid_row_types": _codes(problems, "ROW_TYPE_MISSING", "ROW_TYPE_INVALID"),
        "invalid_mutation_owner_refs": _codes(
            problems, "MUTATION_OWNER_MISSING", "MUTATION_OWNER_UNKNOWN",
            "MUTATION_OWNER_DUPLICATE", "MUTATION_COMPONENT_UNKNOWN",
            "MUTATION_SPEC_INVALID", "SHARER_DECLARES_MUTATION"),
        "unexecutable_destructive_obligations": [o["obligation"] for o in obs
                                                 if o["destructive"] and not o["specs"]],
        "mutation_definitions": len(reg),
        "anchor_problems": anchor_bad,
        "m54_destructive_scenarios": len([o for o in m54 if o["destructive"]]),
        "expected_counts": {v: sum(1 for o in obs if o.get("expected") == v)
                            for v in EXPECTED_VERDICTS},
        "normalized_ids": acct["normalized_ids"],
        "planned_verdict_ids": acct["planned_verdict_ids"],
        "post_normalization_extras": acct["post_normalization_extras"],
        "missing_planned_obligations": acct["missing_planned_obligations"],
        "legacy_authoritative_usage":
            legacy_authoritative_usage(manifest)["legacy_authoritative_usage"],
    }


def load_manifest(path: str = MANIFEST) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# 10. STRUCTURED VITEST EXECUTION  (the real repository runner)
# ---------------------------------------------------------------------------
def run_vitest_structured(capsule_dir: str, witness_files: List[str],
                          timeout_s: int = 900) -> Dict[str, Any]:
    """Run Vitest inside the capsule with the JSON reporter. The report file lives
    INSIDE the capsule and dies with it. No verbose-text parsing anywhere."""
    report = os.path.join(capsule_dir, CAPSULE_REPORT_NAME)
    cmd = ["bun", "x", "vitest", "run", *witness_files,
           "--reporter=json", "--outputFile=" + report]
    try:
        proc = subprocess.run(cmd, cwd=capsule_dir, capture_output=True, text=True,
                              timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return {"report": None, "code": None, "cmd": cmd,
                "error": "vitest timed out after %ds" % timeout_s}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"report": None, "code": None, "cmd": cmd,
                "error": "%s: %s" % (type(exc).__name__, exc)}
    if not os.path.isfile(report):
        return {"report": None, "code": proc.returncode, "cmd": cmd,
                "error": "vitest produced no structured report (rc=%s)" % proc.returncode,
                "stderr": (proc.stderr or "")[-2000:]}
    try:
        with open(report, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError) as exc:
        return {"report": None, "code": proc.returncode, "cmd": cmd,
                "error": "structured report unreadable: %s" % exc}
    return {"report": doc, "code": proc.returncode, "cmd": cmd,
            "error": None, "stderr": (proc.stderr or "")[-2000:]}


# ---------------------------------------------------------------------------
# 11. PER-OBLIGATION BATTERY EXECUTION
# ---------------------------------------------------------------------------
def _blank_result(ob: Dict[str, Any]) -> Dict[str, Any]:
    return {"obligation": ob["obligation"], "row": ob["row"],
            "kind": ob.get("kind"), "designation": ob["designation"],
            "expected": ob.get("expected"), "destructive": ob["destructive"],
            "mutation_owner": ob.get("mutation_owner"),
            "witness": list(ob["witness"]),
            "applied": [], "process": None, "process_code": None,
            "designated_status": None, "resolved_fullname": None,
            "discovery": None, "attribution": None,
            "collateral_failures": [], "observed": None, "final": None,
            "reason": None, "capsule_cleaned": None, "source_unchanged": None}


def _fail(rec: Dict[str, Any], outcome: str, reason: str) -> Dict[str, Any]:
    rec["observed"] = outcome
    rec["final"] = outcome
    rec["reason"] = reason
    return rec


def execute_obligation(ob: Dict[str, Any], source_root: str,
                       runner: Optional[Any] = None,
                       timeout_s: int = 900) -> Dict[str, Any]:
    """Execute ONE obligation in a fresh disposable capsule and attribute its
    semantic outcome. The capsule is always closed in `finally`."""
    runner = runner or run_vitest_structured
    rec = _blank_result(ob)
    if not ob["witness"]:
        return _fail(rec, STRUCTURAL_INVALID, "obligation declares no witness")
    if not known_expected_verdict(ob.get("expected")):
        return _fail(rec, STRUCTURAL_INVALID,
                     "obligation declares no canonical expected verdict")
    cap = Capsule(source_root)
    try:
        cap.materialize_repository()
        if ob["destructive"]:
            if not ob["specs"]:
                return _fail(rec, STRUCTURAL_INVALID,
                             "destructive obligation resolves no mutation spec")
            targets: List[str] = []
            for spec in ob["specs"]:
                src_target = os.path.join(source_root, spec["file"])
                if not os.path.isfile(src_target):
                    return _fail(rec, STRUCTURAL_INVALID,
                                 "mutation target missing: %s" % spec["file"])
                before = sha256_of(src_target)
                try:
                    ap = cap.apply(spec["file"], spec["anchor"], spec["replacement"])
                except (OSError, ValueError) as exc:
                    return _fail(rec, STRUCTURAL_INVALID,
                                 "mutation not applied: %s" % exc)
                if not ap["mutation_applied"]:
                    return _fail(rec, STRUCTURAL_INVALID,
                                 "mutation did not change capsule bytes: %s" % spec["file"])
                if sha256_of(src_target) != before:
                    return _fail(rec, WITNESS_FAILURE,
                                 "SOURCE MUTATED: %s" % spec["file"])
                rec["applied"].append(
                    {"file": spec["file"], "anchor_count": ap["anchor_count"],
                     "pre_sha": ap["pre_sha"], "post_sha": ap["post_sha"],
                     "source_sha_unchanged": True})
                targets.append(spec["file"])
            defects = cap.isolation_defects(targets)
            if defects:
                return _fail(rec, STRUCTURAL_INVALID,
                             "capsule isolation defect: %s" % "; ".join(defects))
            rec["source_unchanged"] = True
        else:
            rec["source_unchanged"] = True
            rec["applied"] = []

        run = runner(cap.dir, list(ob["witness"]), timeout_s)
        rec["process_code"] = run.get("code")
        rec["process"] = classify_process_result(run.get("code"), run.get("error"))
        if run.get("error") or run.get("report") is None:
            return _fail(rec, WITNESS_FAILURE,
                         "witness did not produce a structured designated result: %s"
                         % (run.get("error") or "no report"))
        results = assertion_results(run["report"])
        identities = [r.get("fullName", "") for r in results if r.get("fullName")]
        full, why = discover_identities(identities, ob["designation"])
        rec["discovery"] = why
        if why != "EXACT":
            return _fail(rec, STRUCTURAL_INVALID,
                         "designation discovery returned %s; never downgraded to "
                         "NOT_PROVEN" % why)
        rec["resolved_fullname"] = full
        hit, why2 = attribute_designated_result(results, full)
        rec["attribution"] = why2
        if why2 != "EXACT":
            return _fail(rec, STRUCTURAL_INVALID,
                         "complete-fullName attribution returned %s" % why2)
        rec["collateral_failures"] = collateral_failures(results, full)
        rec["designated_status"] = hit.get("status")
        if ob["destructive"]:
            cls = classify_designated_test_result(hit.get("status"))
        else:
            cls = classify_control_result(hit.get("status"), ob.get("expected"))
        rec["observed"] = cls["outcome"]
        rec["reason"] = cls["reason"]
        rec["final"] = compare_observed_to_expected(cls["outcome"], ob.get("expected"))
        return rec
    finally:
        cap.close()
        rec["capsule_cleaned"] = not os.path.exists(cap.dir)


def summarize_battery(manifest: Dict[str, Any], obs: List[Dict[str, Any]],
                      results: List[Dict[str, Any]]) -> Dict[str, Any]:
    finals = [r["final"] for r in results]
    counts: Dict[str, int] = {}
    for f in finals:
        counts[str(f)] = counts.get(str(f), 0) + 1
    matched = [r for r in results if r["final"] in EXPECTED_VERDICTS]
    return {
        "historical_rows": len({r["id"] for r in manifest.get("rows", [])
                                if isinstance(r, dict) and isinstance(r.get("id"), str)}),
        "obligations": len(obs),
        "executed": len(results),
        "verdict_bearing": len([o for o in obs if o["destructive"]]),
        "controls_pins": len([o for o in obs if not o["destructive"]]),
        "final_counts": counts,
        "matched_expectation": len(matched),
        "verdict_mismatch": sorted(r["obligation"] for r in results
                                   if r["final"] == VERDICT_MISMATCH),
        "structural_invalid": sorted(r["obligation"] for r in results
                                    if r["final"] == STRUCTURAL_INVALID),
        "witness_failure": sorted(r["obligation"] for r in results
                                  if r["final"] == WITNESS_FAILURE),
        "not_proven": sorted(r["obligation"] for r in results
                             if r["final"] == NOT_PROVEN),
        "unexpected_not_proven": 0,
        "designation_failures": sorted(r["obligation"] for r in results
                                       if r["discovery"] != "EXACT"),
        "attribution_failures": sorted(r["obligation"] for r in results
                                       if r["attribution"] not in (None, "EXACT")),
        "capsules_not_cleaned": sorted(r["obligation"] for r in results
                                       if r["capsule_cleaned"] is not True),
        "source_mutations": sorted(r["obligation"] for r in results
                                   if r["source_unchanged"] is not True),
        "extra_verdict_executions": sorted(
            {r["obligation"] for r in results} - {o["obligation"] for o in obs}),
        "collateral_failures": {r["obligation"]: r["collateral_failures"]
                                for r in results if r["collateral_failures"]},
    }


def run_battery(manifest: Dict[str, Any], source_root: Optional[str] = None,
                runner: Optional[Any] = None, timeout_s: int = 900,
                emit: bool = True) -> Dict[str, Any]:
    """THE REAL BATTERY. Normalizes the same strict current manifest, builds the
    execution plan, then executes every obligation in its own fresh capsule."""
    source_root = source_root or ROOT
    obs, problems = normalize(manifest)
    if problems:
        return {"ran": False, "stage": "normalization",
                "reason": "manifest normalization problems; refusing to execute",
                "problems": ["%s [%s]: %s" % (p["where"], p["code"], p["detail"])
                             for p in problems]}
    acct = post_normalization_accounting(manifest, obs)
    if acct["post_normalization_extras"] or acct["missing_planned_obligations"]:
        return {"ran": False, "stage": "accounting",
                "reason": "planned/normalized sets disagree; refusing to execute",
                "post_normalization_extras": acct["post_normalization_extras"],
                "missing_planned_obligations": acct["missing_planned_obligations"]}
    results: List[Dict[str, Any]] = []
    for o in obs:
        if emit:
            print("  -> %-18s %-30s %-22s owner=%s" % (
                o["obligation"], o["designation"], o.get("expected"),
                o.get("mutation_owner")))
        results.append(execute_obligation(o, source_root, runner, timeout_s))
    summary = summarize_battery(manifest, obs, results)
    summary["ran"] = True
    summary["stage"] = "complete"
    return {"summary": summary, "results": results,
            "accounting": {k: v for k, v in acct.items()
                           if not isinstance(v, list) or v}}


# ---------------------------------------------------------------------------
# 12. NON-DESTRUCTIVE REAL IDENTITY PREFLIGHT  (clean structured pass, no mutation)
# ---------------------------------------------------------------------------
def identity_preflight(manifest: Dict[str, Any], source_root: Optional[str] = None,
                       runner: Optional[Any] = None, timeout_s: int = 1800,
                       emit: bool = True) -> Dict[str, Any]:
    """NON-DESTRUCTIVE. One clean capsule, one structured reporter pass over every
    distinct witness file, then exact bracket-segment discovery per obligation.
    Produces NO mutation verdict."""
    source_root = source_root or ROOT
    runner = runner or run_vitest_structured
    obs, problems = normalize(manifest)
    if problems:
        return {"ran": False, "problems": ["%s [%s]" % (p["where"], p["code"])
                                           for p in problems]}
    witness_files = sorted({w for o in obs for w in o["witness"]})
    per_file: Dict[str, List[Dict[str, Any]]] = {}
    with Capsule(source_root) as cap:
        cap.materialize_repository()
        run = runner(cap.dir, witness_files, timeout_s)
        if run.get("error") or run.get("report") is None:
            return {"ran": False, "error": run.get("error") or "no structured report",
                    "witness_files": len(witness_files)}
        per_file = results_by_witness_file(run["report"])
    rows: List[Dict[str, Any]] = []
    for o in obs:
        ids: List[str] = []
        for w in o["witness"]:
            ids += [a.get("fullName", "") for a in per_file.get(os.path.basename(w), [])
                    if a.get("fullName")]
        full, why = discover_identities(ids, o["designation"])
        rows.append({"obligation": o["obligation"], "designation": o["designation"],
                     "expected": o.get("expected"), "resolution": why,
                     "resolved_fullname": full,
                     "witness_status": (per_file.get(os.path.basename(o["witness"][0]), [])
                                        and None)})
    resolved = [r["resolved_fullname"] for r in rows if r["resolution"] == "EXACT"]
    counts: Dict[str, int] = {}
    for r in rows:
        counts[r["resolution"]] = counts.get(r["resolution"], 0) + 1
    out = {
        "ran": True,
        "witness_files": len(witness_files),
        "assertions_observed": sum(len(v) for v in per_file.values()),
        "obligations": len(rows),
        "resolved_exactly_one": len(resolved),
        "missing": [r["obligation"] for r in rows if r["resolution"] == "MISSING"],
        "ambiguous": [r["obligation"] for r in rows if r["resolution"] == "DUPLICATE"],
        "substring_only_accepted": 0,
        "resolution_counts": counts,
        "retained_fullnames_unique": len(set(resolved)) == len(resolved),
        "distinct_retained_fullnames": len(set(resolved)),
        "rows": rows,
    }
    if emit:
        for r in rows:
            print("  %-18s %-30s %-8s %s" % (r["obligation"], r["designation"],
                                             r["resolution"],
                                             (r["resolved_fullname"] or "")[:96]))
    return out


def self_test() -> bool:
    checks: List[Tuple[str, bool]] = []

    def ck(name: str, ok: Any) -> None:
        checks.append((name, bool(ok)))

    tmp = tempfile.mkdtemp(prefix="ai3-selftest-")
    temp_before = _temp_entries(TEMP_PREFIXES)
    home_saved = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
    tmpdir_saved = os.environ.get("TMPDIR")

    def fresh() -> Tuple[str, str]:
        """A brand-new isolated fixture pair per test. No cross-test inode state."""
        d = tempfile.mkdtemp(prefix="fx-", dir=tmp)
        s, g = os.path.join(d, "s"), os.path.join(d, "g")
        for root in (s, g):
            os.makedirs(os.path.join(root, "src"), exist_ok=True)
            open(os.path.join(root, "src", "a.ts"), "w").write("A")
        shutil.copy2(os.path.join(s, "src", "a.ts"), os.path.join(g, "src", "a.ts"))
        return s, g

    def fixture(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {"manifest_version": "fixture", "rows": rows}

    def owner_row(rid: str, desig: str) -> Dict[str, Any]:
        return {"id": rid, "row_type": "SINGLE", "obligation_id": rid, "designation": desig,
                "witness": ["tests/unit/w.test.ts"], "expected_verdict": CAUGHT,
                "mutation_owner": rid,
                "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Z"}}

    def sharer_row(rid: str, desig: str, owner: Any) -> Dict[str, Any]:
        r = {"id": rid, "row_type": "SINGLE", "obligation_id": rid, "designation": desig,
             "witness": ["tests/unit/w.test.ts"], "expected_verdict": CAUGHT}
        if owner is not None:
            r["mutation_owner"] = owner
        return r

    try:
        # ---- A. THREE DISTINCT CLASSIFIERS; process rc is never a polarity ----
        ck("A process health classification never yields a semantic mutation verdict",
           classify_process_result(0)["carries_semantic_verdict"] is False
           and classify_process_result(1)["carries_semantic_verdict"] is False
           and classify_process_result("x")["state"] == "INVALID_EXIT_CODE"
           and classify_process_result(True)["state"] == "INVALID_EXIT_CODE"
           and CAUGHT not in json.dumps(classify_process_result(0))
           and CAUGHT not in json.dumps(classify_process_result(1))
           and SURVIVED not in json.dumps(classify_process_result(0))
           and SURVIVED not in json.dumps(classify_process_result(1)))
        ck("A the exact designated test result is the sole mutation polarity",
           classify_designated_test_result("failed")["outcome"] == CAUGHT
           and classify_designated_test_result("passed")["outcome"] == SURVIVED
           and classify_designated_test_result("skipped")["outcome"] == STRUCTURAL_INVALID
           and classify_designated_test_result("todo")["outcome"] == STRUCTURAL_INVALID
           and classify_designated_test_result("pending")["outcome"] == STRUCTURAL_INVALID
           and classify_designated_test_result(None)["outcome"] == STRUCTURAL_INVALID
           and classify_designated_test_result(7)["outcome"] == STRUCTURAL_INVALID)
        ck("A non-destructive control is green only when its pin assertion passes",
           classify_control_result("passed", PIN_GREEN)["outcome"] == CONTROL_GREEN
           and classify_control_result("passed", RETIRED)["outcome"] == CONTROL_GREEN
           and classify_control_result("failed", PIN_GREEN)["outcome"] == WITNESS_FAILURE
           and classify_control_result("skipped", RETIRED)["outcome"] == WITNESS_FAILURE
           and classify_control_result("passed", CAUGHT)["outcome"] == STRUCTURAL_INVALID)
        ck("A expectation comparison never edits the expected token",
           compare_observed_to_expected(CAUGHT, CAUGHT) == CAUGHT
           and compare_observed_to_expected(SURVIVED, SURVIVED) == SURVIVED
           and compare_observed_to_expected(SURVIVED, CAUGHT) == VERDICT_MISMATCH
           and compare_observed_to_expected(CAUGHT, SURVIVED) == VERDICT_MISMATCH
           and compare_observed_to_expected(CONTROL_GREEN, PIN_GREEN) == PIN_GREEN
           and compare_observed_to_expected(CONTROL_GREEN, RETIRED) == RETIRED
           and compare_observed_to_expected(CONTROL_GREEN, CAUGHT) == VERDICT_MISMATCH
           and compare_observed_to_expected(STRUCTURAL_INVALID, CAUGHT) == STRUCTURAL_INVALID
           and compare_observed_to_expected(WITNESS_FAILURE, CAUGHT) == WITNESS_FAILURE)
        ck("A NOT_PROVEN is declared for reconciliation but emitted by no classifier",
           NOT_PROVEN in OBSERVED_OUTCOMES
           and not any(classify_designated_test_result(s)["outcome"] == NOT_PROVEN
                       for s in ("failed", "passed", "skipped", "todo", None, 1))
           and not any(classify_control_result(s, PIN_GREEN)["outcome"] == NOT_PROVEN
                       for s in ("passed", "failed", "skipped", None))
           and not any(classify_process_result(c)["state"] == NOT_PROVEN
                       for c in (0, 1, 2, "x", True, None)))
        ck("A the retired 0->CAUGHT return-code adapter is gone from this module",
           not _defines_callable_named(_src_text(), "verdict_for_returncode"))

        # ---- B. current manifest parsing ----
        m = load_manifest()
        obs, probs = normalize(m)
        ck("B current manifest normalizes with 0 problems",
           len(obs) > 0 and not probs and all(o["designation"] for o in obs))

        # ---- C. retired / malformed schema rejected ----
        _, lp = normalize(fixture([{"id": "X", "classification": "SINGLE", "mutate": "y",
                                    "submutations": [{"sub": "a", "mutate": "y"}],
                                    "witness": "w.ts"}]))
        ck("C legacy mutate/sub['sub']/classification schema rejected", bool(lp))
        _, bad = normalize(fixture([{"id": "Y", "row_type": "TYPE_B_MULTI_PREDICATE",
                                     "subobligations": [{"obligation_id": "Y:z",
                                                         "designation": "Y",
                                                         "witness": "w.ts"}]}]))
        ck("C destructive subobligation missing mutation owner rejected", bool(bad))

        # ---- D/E/F/G. exact structured identity (anti-fuzzy, architect ruling) ----
        ck("AF-A designation segment at the beginning resolves",
           discover_identities(["[AI3-M41-HIST] M41: first"], "AI3-M41-HIST")
           == ("[AI3-M41-HIST] M41: first", "EXACT"))
        ck("AF-B designation segment in the middle resolves",
           discover_identities(
               ["M41/M42/M57 - shared guard: conflict [AI3-M41-HIST] M41: an AI estimate"],
               "AI3-M41-HIST")
           == ("M41/M42/M57 - shared guard: conflict [AI3-M41-HIST] M41: an AI estimate",
               "EXACT"))
        ck("AF-C designation segment at the end resolves",
           discover_identities(["M44 - TYPE-B numeric bounds [AI3-M44-RATIO-HIST]"],
                               "AI3-M44-RATIO-HIST")
           == ("M44 - TYPE-B numeric bounds [AI3-M44-RATIO-HIST]", "EXACT"))
        ck("AF-D a token-like substring with no exact bracket segment does not resolve",
           discover_identities(["prefix note AI3-M41-HIST appears unbracketed"],
                               "AI3-M41-HIST") == (None, "MISSING"))
        ck("AF-E [AI3-M41-HIST-EXTRA] does not match AI3-M41-HIST",
           discover_identities(["[AI3-M41-HIST-EXTRA] other"], "AI3-M41-HIST")
           == (None, "MISSING"))
        ck("AF-F prefixAI3-M41-HIST does not match",
           discover_identities(["prefixAI3-M41-HIST tail"], "AI3-M41-HIST")
           == (None, "MISSING")
           and discover_identities(["[prefixAI3-M41-HIST] tail"], "AI3-M41-HIST")
           == (None, "MISSING"))
        ck("AF-G a duplicate exact designation segment across two fullNames is ambiguous",
           discover_identities(["[T] a", "ctx [T] b"], "T") == (None, "DUPLICATE"))
        ck("AF-H zero exact segments is a structural failure, never NOT_PROVEN",
           discover_identities(["nothing relevant here"], "T") == (None, "MISSING")
           and discover_identities([], "T") == (None, "MISSING"))
        f, why = discover_identities(["[TOK-A] first", "[TOK-A-EXTRA] other",
                                      "[TOK-B] second"], "TOK-A")
        ck("AF-I exact discovery resolves once and a similar fullName cannot receive it",
           f == "[TOK-A] first" and why == "EXACT"
           and attribute_designated_result(
               [{"fullName": "[TOK-A] first", "status": "failed"},
                {"fullName": "[TOK-A-EXTRA] other", "status": "passed"}], f)[0]["status"]
           == "failed")
        hit, awhy = attribute_designated_result(
            [{"fullName": "[TOK-A] first", "status": "passed"}], "[TOK-A] first")
        ck("AF-J runtime attribution uses exact complete-fullName equality",
           awhy == "EXACT" and hit["fullName"] == "[TOK-A] first"
           and attribute_designated_result(
               [{"fullName": "x [TOK-A] first"}, {"fullName": "[TOK-A] firsty"}],
               "[TOK-A] first") == (None, "MISSING")
           and attribute_designated_result([], "[TOK-A] first") == (None, "MISSING")
           and attribute_designated_result(
               [{"fullName": "[TOK-A] first"}], None) == (None, "UNRESOLVED")
           and attribute_designated_result(
               [{"fullName": "[T] a"}, {"fullName": "[T] a"}], "[T] a")
           == (None, "DUPLICATE"))
        ck("AF-K collateral failures are recorded and never become the verdict",
           collateral_failures([{"fullName": "[T] a", "status": "failed"},
                                {"fullName": "[U] b", "status": "failed"},
                                {"fullName": "[V] c", "status": "passed"}],
                               "[T] a") == ["[U] b"]
           and classify_designated_test_result(
               collateral_failures([{"fullName": "[U] b", "status": "failed"}],
                                   "[T] a") and "failed")["outcome"] == CAUGHT
           and collateral_failures([{"fullName": "[T] a", "status": "failed"}],
                                   "[T] a") == [])

        # ---- H. shared witness file yields distinct obligations ----
        s, g = fresh()
        sobs, shp = normalize(fixture([{
            "id": "M", "row_type": "SHARED_GUARD_SCENARIO", "obligation_id": "M",
            "mutation_owner": "M",
            "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Z"},
            "scenarios": [{"obligation_id": "M:one", "scenario_id": "one",
                           "designation": "X1", "witness": ["tests/unit/w.test.ts"],
                           "expected_verdict": CAUGHT, "mutation_owner": "M"},
                          {"obligation_id": "M:two", "scenario_id": "two",
                           "designation": "X2", "witness": ["tests/unit/w.test.ts"],
                           "expected_verdict": CAUGHT, "mutation_owner": "M"},
                          {"obligation_id": "M:three", "scenario_id": "three",
                           "designation": "X3", "witness": ["tests/unit/w.test.ts"],
                           "expected_verdict": CAUGHT, "mutation_owner": "M"}]}]))
        ck("H shared witness file yields distinct obligations",
           len(sobs) == 3 and not shp and len({o["designation"] for o in sobs}) == 3
           and len({o["obligation"] for o in sobs}) == 3)

        # ---- I. non-destructive pins never enter the destructive executor ----
        pobs, pip = normalize(fixture([{"id": "P", "row_type": "RETIRED_BY_ARCHITECTURE",
                                        "obligation_id": "P:pin", "designation": "PIN",
                                        "witness": ["tests/unit/p.test.ts"],
                                        "expected_verdict": RETIRED}]))
        ck("I retired pin is non-destructive",
           not pip and len(pobs) == 1 and not pobs[0]["destructive"])
        pbobs, pbp = normalize(fixture([{"id": "Q", "row_type": "SINGLE", "obligation_id": "Q",
                                         "designation": "QPIN", "witness": "w.test.ts",
                                         "expected_verdict": PIN_GREEN}]))
        ck("I pin_green control is non-destructive and needs no mutation",
           not pbp and len(pbobs) == 1 and not pbobs[0]["destructive"])

        # ---- J/K. anchor count must be exactly 1 ----
        s, g = fresh()
        with Capsule(s) as cap:
            cap.materialize(["src/a.ts"])
            r = _raises_val(lambda: cap.apply("src/a.ts", "NOT-PRESENT", "x"))
            ck("J anchor count 0 fails structurally", isinstance(r, ValueError))
        with open(os.path.join(s, "src", "a.ts"), "a") as fh:
            fh.write("A")
        with Capsule(s) as cap:
            cap.materialize(["src/a.ts"])
            r = _raises_val(lambda: cap.apply("src/a.ts", "A", "Z"))
            ck("K anchor count >1 fails structurally", isinstance(r, ValueError))

        # ---- L/M. mutation changes capsule only; source bytes unchanged ----
        s, g = fresh()
        src_before = sha256_of(os.path.join(s, "src", "a.ts"))
        with Capsule(s) as cap:
            cap.materialize(["src/a.ts"])
            res = cap.apply("src/a.ts", "A", "Z")
            ck("L mutation changes capsule bytes only",
               res["mutation_applied"] and res["anchor_count"] == 1
               and res["pre_sha"] != res["post_sha"]
               and sha256_of(os.path.join(cap.dir, "src", "a.ts")) == res["post_sha"])
        ck("M source repository bytes unchanged",
           sha256_of(os.path.join(s, "src", "a.ts")) == src_before)

        # ---- N. computed post-normalization extras ----
        pre = dry_preflight(m)
        ck("N computed post-normalization extras = 0 for the real manifest",
           pre["post_normalization_extras"] == [] and pre["normalized_ids"] > 0
           and pre["planned_verdict_ids"] > 0)
        ck("N computed normalized and planned sets are equal in size",
           pre["normalized_ids"] == pre["planned_verdict_ids"])

        # ---- O. unknown expected verdict fails closed ----
        _, up = normalize(fixture([{"id": "U", "row_type": "SINGLE", "obligation_id": "U",
                                    "designation": "UD", "witness": "w.ts",
                                    "expected_verdict": "MAYBE"}]))
        ck("O unknown expected verdict fails closed", bool(up))
        _, amp = normalize(fixture([{"id": "V", "row_type": "SINGLE", "obligation_id": "V",
                                     "designation": "VD", "witness": "w.ts",
                                     "mutation_owner": "V",
                                     "mutation": {"file": "src/a.ts", "anchor": "A",
                                                  "replacement": "Z"}}]))
        ck("O absent expected verdict fails closed, never defaults to CAUGHT",
           any(p["code"] == "EXPECTED_VERDICT_MISSING" for p in amp)
           and not any(o.get("expected") == CAUGHT for o in normalize(fixture([{
               "id": "V", "row_type": "SINGLE", "obligation_id": "V", "designation": "VD",
               "witness": "w.ts", "mutation_owner": "V",
               "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Z"}}]))[0]))

        # ---- P/Q. capsule cleanup on success and on failure ----
        s, g = fresh()
        cap = Capsule(s)
        d = cap.dir
        cap.materialize(["src/a.ts"])
        cap.close()
        ck("P capsule cleanup on success", not os.path.exists(d))
        cap2 = Capsule(s)
        d2 = cap2.dir
        try:
            with cap2:
                cap2.materialize(["src/a.ts"])
                raise RuntimeError("synthetic failure")
        except RuntimeError:
            pass
        ck("Q capsule cleanup on failure", not os.path.exists(d2))

        # ---- GK. battery CLI exit gate regression (F1-B1) --------------------
        ck("GK a completed battery with summary.ran=True is ACCEPTED by the CLI gate",
           battery_accepted({"summary": {"ran": True, "stage": "complete"},
                             "results": [{"obligation": "X"}], "accounting": {}})
           is True)
        ck("GK a refused / preflight-failed battery is REJECTED by the CLI gate",
           battery_accepted({"summary": {"ran": False}}) is False
           and battery_accepted({"ran": False, "stage": "normalization",
                                 "reason": "manifest normalization problems"}) is False
           and battery_accepted({"ran": False, "stage": "accounting"}) is False
           and battery_accepted({}) is False
           and battery_accepted(None) is False
           and battery_accepted("nope") is False)
        ck("GK the gate reads summary.ran, never a top-level out.get('ran')",
           battery_accepted({"ran": True}) is False
           and battery_accepted({"ran": True, "summary": {"ran": False}}) is False
           and battery_accepted({"ran": False, "summary": {"ran": True}}) is True
           and not _main_reads_top_level_ran(_src_text()))
        gk_root = _synthetic_source_root(tmp)
        gk_done = run_battery(fixture([{
            "id": "GK", "row_type": "RETIRED_BY_ARCHITECTURE",
            "obligation_id": "GK:pin", "designation": SYNTH_DESIGNATION,
            "witness": ["tests/unit/synth.test.ts"],
            "expected_verdict": PIN_GREEN}]),
            source_root=gk_root, runner=_fake_runner("passed"), emit=False)
        ck("GK a REAL completed run_battery return value is accepted by the CLI gate",
           gk_done["summary"]["ran"] is True
           and gk_done["summary"]["stage"] == "complete"
           and gk_done["summary"]["executed"] == 1
           and gk_done["summary"]["capsules_not_cleaned"] == []
           and battery_accepted(gk_done) is True)
        ck("GK a real refused run_battery result is rejected by the CLI gate",
           battery_accepted(run_battery(fixture([
               {"id": "BAD", "obligation_id": "BAD", "designation": "B",
                "witness": "w.ts", "expected_verdict": CAUGHT,
                "mutation_owner": "BAD",
                "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Z"}}]),
               emit=False)) is False
           and battery_accepted(run_battery({"rows": []}, emit=False)) is False)

        # ---- EX-01..EX-22. REAL EXECUTOR, SYNTHETIC FIXTURES ONLY ----
        # No historical M41-M61 mutation is ever executed in this self-test.
        live_before = _temp_entries(("ai3-capsule-",))
        sroot = _synthetic_source_root(tmp)
        ex = _executor_fixtures(sroot)

        ck("EX-01 a real --run-battery execution mode exists in this module",
           "--run-battery" in _src_text() and callable(run_battery)
           and callable(execute_obligation) and callable(run_vitest_structured))

        r = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_failed"])
        ck("EX-02 a synthetic destructive obligation creates a real capsule",
           r["final"] == CAUGHT and r["capsule_cleaned"] is True
           and len(r["applied"]) == 1 and r["source_unchanged"] is True)
        ck("EX-03 the synthetic mutation anchor matched exactly once",
           r["applied"][0]["anchor_count"] == 1
           and r["applied"][0]["pre_sha"] != r["applied"][0]["post_sha"])
        r0 = execute_obligation(ex["ob_anchor0"], sroot, ex["fake_runner_failed"])
        ck("EX-04 an anchor count of 0 fails structurally", r0["final"] == STRUCTURAL_INVALID
           and r0["applied"] == [] and r0["capsule_cleaned"] is True)
        r2 = execute_obligation(ex["ob_anchor2"], sroot, ex["fake_runner_failed"])
        ck("EX-05 an anchor count above 1 fails structurally",
           r2["final"] == STRUCTURAL_INVALID and r2["capsule_cleaned"] is True)
        ck("EX-06 the mutation changed only the capsule copy of the target",
           ex["capture"].get("capsule_a_ts") is not None
           and SYNTH_MUTATION in ex["capture"]["capsule_a_ts"]
           and SYNTH_MUTATION not in open(os.path.join(sroot, "src", "a.ts"),
                                          encoding="utf-8").read()
           and r["applied"][0]["pre_sha"] == ex["a_sha"])
        ck("EX-07 source bytes are unchanged after the destructive execution",
           sha256_of(os.path.join(sroot, "src", "a.ts")) == ex["a_sha"]
           and open(os.path.join(sroot, "src", "a.ts"), encoding="utf-8").read() == ex["a_text"])

        ck("EX-08 designated test FAILED + expected CAUGHT -> CAUGHT",
           r["final"] == CAUGHT and r["designated_status"] == "failed"
           and r["resolved_fullname"] == ex["full"])
        rs = execute_obligation(ex["survived_ob"], sroot, ex["fake_runner_passed"])
        ck("EX-09 designated test PASSED + expected SURVIVED_AS_EXPECTED -> SURVIVED_AS_EXPECTED",
           rs["final"] == SURVIVED and rs["designated_status"] == "passed")
        rm1 = execute_obligation(ex["survived_ob"], sroot, ex["fake_runner_failed"])
        ck("EX-10 designated FAILED + expected SURVIVED_AS_EXPECTED -> VERDICT_MISMATCH",
           rm1["final"] == VERDICT_MISMATCH and rm1["observed"] == CAUGHT
           and rm1["expected"] == SURVIVED)
        rm2 = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_passed"])
        ck("EX-11 designated PASSED + expected CAUGHT -> VERDICT_MISMATCH",
           rm2["final"] == VERDICT_MISMATCH and rm2["observed"] == SURVIVED
           and rm2["expected"] == CAUGHT)
        rmiss = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_missing"])
        ck("EX-12 a missing designated result is a structural failure, not a verdict",
           rmiss["final"] == STRUCTURAL_INVALID and rmiss["final"] != CAUGHT
           and rmiss["discovery"] == "MISSING")
        rdup = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_duplicate"])
        ck("EX-13 a duplicate designated result is a structural failure",
           rdup["final"] == STRUCTURAL_INVALID and rdup["discovery"] == "DUPLICATE")
        rskip = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_skipped"])
        ck("EX-14 a skipped designated result is a structural failure, never CAUGHT",
           rskip["final"] == STRUCTURAL_INVALID and rskip["designated_status"] == "skipped"
           and rskip["final"] != CAUGHT)
        rcol = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_passed_collateral"])
        ck("EX-15 a collateral failure cannot steal the designated obligation's verdict",
           rcol["final"] == VERDICT_MISMATCH and rcol["observed"] == SURVIVED
           and rcol["collateral_failures"] == [ex["collateral"]])
        rcrash = execute_obligation(ex["caught_ob"], sroot, ex["fake_runner_crash"])
        ck("EX-16 a process failure before any designated result is a witness failure",
           rcrash["final"] == WITNESS_FAILURE and rcrash["final"] != CAUGHT
           and rcrash["process"]["state"] == "PROCESS_FAILED")
        rmulti = execute_obligation(ex["multi_ob"], sroot, ex["fake_runner_failed"])
        ck("EX-17 a multi-component variant applies every spec atomically in one capsule",
           len(rmulti["applied"]) == 2
           and {a["file"] for a in rmulti["applied"]} == {"src/a.ts", "src/b.ts"}
           and all(a["anchor_count"] == 1 for a in rmulti["applied"])
           and rmulti["final"] == CAUGHT and rmulti["capsule_cleaned"] is True)
        rctl = execute_obligation(ex["control_ob"], sroot, ex["fake_runner_passed"])
        ck("EX-18 a non-destructive control applies zero mutations",
           rctl["applied"] == [] and rctl["destructive"] is False
           and rctl["final"] == PIN_GREEN and rctl["capsule_cleaned"] is True)
        ck("EX-19 cleanup happens on semantic success",
           r["capsule_cleaned"] is True and rs["capsule_cleaned"] is True
           and rctl["capsule_cleaned"] is True)
        ck("EX-20 cleanup happens on semantic failure",
           rm2["capsule_cleaned"] is True and rmiss["capsule_cleaned"] is True
           and rcol["capsule_cleaned"] is True)
        ck("EX-21 cleanup happens on process failure", rcrash["capsule_cleaned"] is True)
        live_after = _temp_entries(("ai3-capsule-",))
        ck("EX-22 zero live capsules remain after the executor self-tests",
           not (live_after - live_before)
           and not any(v["capsule_cleaned"] is not True
                       for v in (r, rs, r0, r2, rm1, rm2, rmiss, rdup, rskip, rcol,
                                 rcrash, rmulti, rctl)))

        # ---- EX-23. the REAL vitest runner, end to end, on a synthetic project ----
        real = _real_runner_end_to_end(sroot, ex)
        ck("EX-23 the real Vitest runner drives real capsules to real verdicts",
           real["ok"] and real["caught_final"] == CAUGHT
           and real["caught_designated_status"] == "failed"
           and real["survived_final"] == PIN_GREEN
           and real["survived_designated_status"] == "passed"
           and real["escaped_final"] == VERDICT_MISMATCH
           and real["escaped_observed"] == SURVIVED
           and real["escaped_mutation_applied"] == ["src/c.ts"]
           and real["escaped_source_unchanged"]
           and real["caught_discovery"] == "EXACT" and real["caught_attribution"] == "EXACT"
           and real["source_unchanged"] and real["capsules_cleaned"]
           and real["no_report_left_in_source_root"])

        # ---- R/S/T. real families normalize to the required shapes ----
        byrow: Dict[str, List[Dict[str, Any]]] = {}
        for o in obs:
            byrow.setdefault(o["row"], []).append(o)
        ck("R M50 normalizes exactly AB / ABC / ABCD",
           sorted(o["obligation"] for o in byrow.get("M50", []))
           == ["M50:AB", "M50:ABC", "M50:ABCD"])
        ck("S M53 normalizes exactly A / B / AB",
           sorted(o["obligation"] for o in byrow.get("M53", []))
           == ["M53:A", "M53:AB", "M53:B"])
        m54 = byrow.get("M54", [])
        ck("T M54 yields four separately attributable scenarios",
           len(m54) == 4 and len({o["designation"] for o in m54}) == 4)

        # ---- U. runtime / structural proof of location independence ----
        ck("U repository root is derived from this file's own location",
           os.path.realpath(ROOT) == _root_from_this_file()
           and os.path.dirname(os.path.abspath(__file__)) == os.path.join(ROOT, "scripts")
           and os.path.isfile(MANIFEST))
        ck("U every absolute path this module binds is inside the repository root",
           all(p == ROOT or p.startswith(ROOT + os.sep) for p in MODULE_ABSOLUTE_PATHS)
           and len(MODULE_ABSOLUTE_PATHS) > 0)
        try:
            for k in home_saved:
                if home_saved[k] is not None:
                    os.environ[k] = os.path.join(tmp, "no-such-home")
            os.chdir(tempfile.gettempdir())
            uobs, upb = normalize(load_manifest())
            ck("U normal execution needs no user home and no tool home",
               len(uobs) == len(obs) and not upb
               and not os.path.exists(os.environ["HOME"]))
        finally:
            os.chdir(ROOT)
            for k, v in home_saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        tmproot = tempfile.gettempdir()
        with Capsule() as c1, Capsule() as c2:
            dirs = (c1.dir, c2.dir)
            ck("U temporary roots are created dynamically with tempfile, never a fixed scratch",
               dirs[0] != dirs[1]
               and all(os.path.dirname(p) == tmproot for p in dirs)
               and all(p != tmproot and os.path.isdir(p) for p in dirs))
        ck("U temporary roots are cleaned up", not any(os.path.exists(p) for p in dirs))
        ck("U no fixed scratch dependency: a redirected temp root still works",
           _works_under_redirected_tmpdir())
        ck("U self-test scratch root is created dynamically and removed",
           os.path.isdir(tmp) and os.path.basename(tmp).startswith("ai3-selftest-"))
        ck("V repository root discovery is cwd-independent", os.path.isfile(MANIFEST))
        with Capsule() as vcap:
            default_src = vcap.src
        ck("V capsule root defaults to the repository root", default_src == ROOT)

        # ---- W/X/Y. shared-mutation execution model ----
        wrows = [owner_row("M41", "AI3-M41-HIST"),
                 sharer_row("M42", "AI3-M42-HIST", "M41"),
                 sharer_row("M57", "AI3-M57-HIST", "M41")]
        wobs, wp = normalize(fixture(wrows))
        wreg, wdup = build_mutation_registry(fixture(wrows))
        ck("W one owner plus two sharers = 3 obligations / 1 mutation definition",
           len(wobs) == 3 and not wp and not wdup and len(wreg) == 1
           and all(o["destructive"] for o in wobs)
           and all(o["expected"] == CAUGHT for o in wobs)
           and all(len(o["specs"]) == 1 for o in wobs)
           and len({tuple(sorted(s.items())) for o in wobs for s in o["specs"]}) == 1)
        ck("W all three sharers/owner carry their own exact fullName",
           len({o["designation"] for o in wobs}) == 3
           and sorted(o["obligation"] for o in wobs) == ["M41", "M42", "M57"])
        xobs, xp = normalize(fixture([owner_row("M41", "D1"), sharer_row("M42", "D2", None)]))
        ck("X a sharer with no mutation_owner fails",
           any(p["code"] == "MUTATION_OWNER_MISSING" for p in xp)
           and any(o["obligation"] == "M42" and not o["specs"] for o in xobs))
        yobs, yp = normalize(fixture([owner_row("M41", "D1"),
                                      sharer_row("M42", "D2", "M99")]))
        ck("Y a sharer naming an unknown mutation owner fails",
           any(p["code"] == "MUTATION_OWNER_UNKNOWN" for p in yp)
           and any(o["obligation"] == "M42" and not o["specs"] for o in yobs))
        dupobs, dupp = normalize(fixture([
            owner_row("M41", "D1"),
            {"id": "M42", "row_type": "SINGLE", "obligation_id": "M42", "designation": "D2",
             "witness": "w.test.ts", "expected_verdict": CAUGHT, "mutation_owner": "M41",
             "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Y"}}]))
        ck("Y a sharer duplicating the owner mutation definition is rejected",
           any(p["code"] == "SHARER_DECLARES_MUTATION" for p in dupp))

        # ---- Z. the real M41 / M42 / M57 family ----
        z41, z42, z57 = byrow.get("M41", []), byrow.get("M42", []), byrow.get("M57", [])
        m41_spec = z41[0]["specs"] if len(z41) == 1 else []
        ck("Z M42 / M57 remain counted sharers that resolve M41's single mutation",
           len(z41) == 1 and len(z42) == 1 and len(z57) == 1
           and z41[0]["mutation_owner"] == "M41" and z42[0]["mutation_owner"] == "M41"
           and z57[0]["mutation_owner"] == "M41"
           and z42[0]["specs"] == m41_spec and z57[0]["specs"] == m41_spec
           and z42[0]["expected"] == CAUGHT and z57[0]["expected"] == CAUGHT
           and len({o["designation"] for o in (z41 + z42 + z57)}) == 3
           and all(o["witness"] for o in (z42 + z57)))
        mrows = {r["id"]: r for r in m["rows"]}
        ck("Z M42 and M57 declare no mutation of their own",
           "mutation" not in mrows["M42"] and "mutation" not in mrows["M57"]
           and mrows["M42"].get("mutation_owner") == "M41"
           and mrows["M57"].get("mutation_owner") == "M41"
           and "mutation" in mrows["M41"])

        # ---- AA. M47a / M47b canonical explicit verdicts ----
        m47 = byrow.get("M47", [])
        ck("AA M47a / M47b carry explicit canonical CAUGHT with exact designations",
           sorted(o["obligation"] for o in m47) == ["M47a", "M47b"]
           and sorted(o["designation"] for o in m47) == ["AI3-M47A-HIST", "AI3-M47B-HIST"]
           and all(o["expected"] == CAUGHT and o["destructive"] and o["witness"]
                   and o["verdict_source"] == "expected_verdict" and len(o["specs"]) == 1
                   for o in m47)
           and len({tuple(sorted(s.items())) for o in m47 for s in o["specs"]}) == 2)

        # ---- AB. M56a / M56b normalize to exactly two obligations ----
        m56 = byrow.get("M56", [])
        ck("AB M56a / M56b normalize to exactly two CAUGHT obligations",
           sorted(o["obligation"] for o in m56) == ["M56a", "M56b"]
           and sorted(o["designation"] for o in m56) == ["AI3-M56A-HIST", "AI3-M56B-HIST"]
           and all(o["expected"] == CAUGHT and o["destructive"] and len(o["specs"]) == 1
                   for o in m56)
           and len({tuple(sorted(s.items())) for o in m56 for s in o["specs"]}) == 2)

        # ---- AC/AD. row_type is mandatory and legacy fields cannot rescue it ----
        _, acp = normalize(fixture([{"id": "AC", "obligation_id": "AC", "designation": "ACD",
                                     "witness": "w.test.ts", "expected_verdict": CAUGHT,
                                     "mutation_owner": "AC",
                                     "mutation": {"file": "src/a.ts", "anchor": "A",
                                                  "replacement": "Z"}}]))
        ck("AC a destructive row with no row_type fails", bool(acp)
           and all(p["code"] == "ROW_TYPE_MISSING" for p in acp))
        adrow = {"id": "AD", "obligation_id": "AD", "designation": "ADD", "witness": "w.test.ts",
                 "expected_verdict": CAUGHT, "classification": "SINGLE", "mutate": "y",
                 "mutation_owner": "AD",
                 "mutation": {"file": "src/a.ts", "anchor": "A", "replacement": "Z"}}
        _, adp = normalize(fixture([adrow]))
        ck("AD legacy classification/mutate cannot rescue a row with no row_type",
           bool(adp) and all(p["code"] == "ROW_TYPE_MISSING" for p in adp))
        _, abp = normalize(fixture([dict(adrow, row_type="NOT_A_CURRENT_TYPE")]))
        ck("AD an unknown row_type is rejected as invalid",
           bool(abp) and all(p["code"] == "ROW_TYPE_INVALID" for p in abp))

        # ---- AE/AF. real manifest accounting and verdict distribution ----
        ck("AE real manifest = 21 historical rows / 32 obligations / 0 problems",
           pre["rows"] == 21 and pre["obligations"] == 32 and pre["problem_count"] == 0
           and not pre["problems"])
        ck("AF expected verdict distribution is 26 CAUGHT / 4 SURVIVED / 1 PIN / 1 RETIRED",
           pre["expected_counts"] == {CAUGHT: 26, SURVIVED: 4, PIN_GREEN: 1, RETIRED: 1}
           and pre["verdict_bearing"] == 30 and pre["controls_pins"] == 2
           and pre["control_pin_ids"] == ["M44:NONFINITE", "M58:pin"])
        survivors = sorted(o["obligation"] for o in obs
                           if o.get("expected") == SURVIVED)
        ck("AF the four survivors are exactly M50 AB / M50 ABC / M53 A / M53 B",
           survivors == ["M50:AB", "M50:ABC", "M53:A", "M53:B"])
        ck("AF M44 NONFINITE is the only pin and M58 the only retirement",
           sorted(o["obligation"] for o in obs if o.get("expected") == PIN_GREEN)
           == ["M44:NONFINITE"]
           and sorted(o["obligation"] for o in obs if o.get("expected") == RETIRED)
           == ["M58:pin"])
        ck("AE all 32 designations are unique and every obligation has a witness",
           pre["designations"] == 32 and not pre["duplicate_designations"]
           and not pre["missing_designation"] and not pre["missing_witness"])
        ck("AE every destructive obligation is executable and every anchor matches once",
           not pre["unexecutable_destructive_obligations"] and not pre["anchor_problems"]
           and not pre["invalid_mutation_owner_refs"] and not pre["invalid_row_types"]
           and not pre["invalid_expected_verdicts"])

        # ---- AG. M54 is one shared mutation with four destructive scenarios ----
        reg54, dup54 = build_mutation_registry(m)
        m54row = mrows["M54"]
        ck("AG M54 = four destructive scenarios over exactly one mutation owner",
           len(m54) == 4 and all(o["destructive"] and o["expected"] == CAUGHT
                                 and o["mutation_owner"] == "M54" and o["witness"]
                                 and len(o["specs"]) == 1 for o in m54)
           and sorted(o["designation"] for o in m54)
           == ["AI3-M54-COUNT-PORTION-HIST", "AI3-M54-HOUSEHOLD-HIST",
               "AI3-M54-PORTION-HIST", "AI3-M54-USER-MASS-HIST"]
           and len({tuple(sorted(s.items())) for o in m54 for s in o["specs"]}) == 1
           and m54row.get("mutation_owner") == "M54" and "mutation" in m54row
           and not dup54 and len([k for k in reg54 if k == "M54"]) == 1
           and pre["m54_destructive_scenarios"] == 4)

        # ---- AH. extras are computed; a synthetic extra IS detected ----
        injected = plan_execution(m)
        injected["M99:phantom"] = {"kind": "DESTRUCTIVE", "owner": "M41"}
        fake = [dict(o) for o in obs] + [
            {"obligation": "M99:phantom", "row": "M99", "kind": "single",
             "designation": "PHANTOM", "expected": CAUGHT, "destructive": True,
             "specs": [], "verdict_source": "expected_verdict"}]
        real_acct = post_normalization_accounting(m, obs)
        ck("AH post-normalization extras are computed from two independent traversals",
           real_acct["post_normalization_extras"] == []
           and real_acct["missing_planned_obligations"] == []
           and real_acct["normalized_ids"] == real_acct["planned_verdict_ids"] == 32)
        ck("AH an injected fake planned execution is detected as an extra",
           set(injected) - {o["obligation"] for o in obs} == {"M99:phantom"}
           and post_normalization_accounting(m, obs, injected)[
               "post_normalization_extras"] == ["M99:phantom"]
           and len(fake) == 33
           and post_normalization_accounting(m, fake, injected)[
               "post_normalization_extras"] == []
           and post_normalization_accounting(m, fake, injected)["normalized_ids"] == 33)

        # ---- AI. a missing planned execution IS detected ----
        holed = {k: v for k, v in plan_execution(m).items() if k != "M55"}
        ck("AI a missing planned semantic execution is detected",
           holed and "M55" not in holed
           and (post_normalization_accounting(m, obs)["missing_planned_obligations"] == [])
           and "M55" in _missing_if_planner_skips(m, "M55"))
        ck("AI controls and pins stay in the plan but out of destructive execution",
           real_acct["planned_controls"] == ["M44:NONFINITE", "M58:pin"]
           and len(real_acct["planned_destructive"]) == 30
           and all(o["destructive"] for o in obs
                   if o["obligation"] in real_acct["planned_destructive"])
           and not any(o["destructive"] for o in obs
                       if o["obligation"] in real_acct["planned_controls"]))

        # ---- AJ. no semantic obligation obtains its verdict through a default ----
        aj = dict(pre)
        ck("AJ every obligation's expected verdict comes from an explicit field",
           aj["implicit_default_verdicts"] == [] and aj["invalid_expected_verdicts"] == []
           and all(o.get("verdict_source") == "expected_verdict" for o in obs)
           and all(o.get("expected") in EXPECTED_VERDICTS for o in obs)
           and not _has_verdict_default(_src_text()))
        ck("AJ legacy fields are provably non-authoritative",
           legacy_authoritative_usage(m)["legacy_authoritative_usage"] == 0
           and legacy_authoritative_usage(m)["strip_normalizes_identically"] is True
           and "classification" not in AUTHORITATIVE_ROW_KEYS
           and "mutate" not in AUTHORITATIVE_ROW_KEYS
           and "sub" not in AUTHORITATIVE_OBLIGATION_KEYS
           and "runtime_designations" not in AUTHORITATIVE_ROW_KEYS
           and "legacy" not in AUTHORITATIVE_ROW_KEYS)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        leaked = sorted(_temp_entries(TEMP_PREFIXES) - temp_before)
        for k, v in home_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if tmpdir_saved is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = tmpdir_saved
        if os.path.isdir(tmp):
            raise AssertionError("self-test scratch root survived teardown")
        if leaked:
            raise AssertionError("temporary roots leaked: %s" % leaked)

    for name, ok in checks:
        print("  %-4s %s" % ("PASS" if ok else "FAIL", name))
    passed = sum(1 for _, ok in checks if ok)
    print("  SELF-TEST RESULT: %d/%d" % (passed, len(checks)))
    return passed == len(checks)


# ---------------------------------------------------------------------------
# 12. SELF-TEST HELPERS
# ---------------------------------------------------------------------------
# Every temporary root this module creates carries one of these prefixes, so a
# leak is detectable by comparing the temp root before and after a run.
TEMP_PREFIXES = ("ai3-capsule-", "ai3-selftest-", "ai3-redirect-")


SYNTH_DESIGNATION = "AI3-SYNTH-HIST"
SYNTH_FULLNAME = ("synthetic battery executor [AI3-SYNTH-HIST] designated assertion")
SYNTH_COLLATERAL = "synthetic battery executor [AI3-SYNTH-COLLATERAL] unrelated"
# Two assignments so that the token "= 1;" is a genuinely repeated anchor.
SYNTH_A_TEXT = "export const A = 1;\nexport const A2 = 1;\n"
SYNTH_B_TEXT = "export const B = 1;\n"
SYNTH_A_ANCHOR = "export const A = 1;"
SYNTH_B_ANCHOR = "export const B = 1;"
SYNTH_REPEATED_ANCHOR = "= 1;"
SYNTH_MUTATION = "export const A = 2;"
SYNTH_C_TEXT = "export const C = 1;\n"
SYNTH_C_ANCHOR = "export const C = 1;"
SYNTH_C_MUTATION = "export const C = 2;"


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _synthetic_source_root(tmp: str) -> str:
    """A minimal, self-contained repository-shaped tree with its own Vitest
    project. It contains NO historical M41-M61 mutation and NO real production
    file, so exercising the real runner here can never touch production."""
    root = tempfile.mkdtemp(prefix="ai3-synthroot-", dir=tmp)
    _write(os.path.join(root, "package.json"),
           json.dumps({"name": "ai3-synthetic-executor", "private": True,
                       "type": "module"}, indent=1) + "\n")
    _write(os.path.join(root, "tsconfig.json"),
           json.dumps({"compilerOptions": {"target": "ES2022", "module": "ESNext",
                                           "moduleResolution": "bundler",
                                           "strict": False}}, indent=1) + "\n")
    _write(os.path.join(root, "vitest.config.ts"),
           "import { defineConfig } from 'vitest/config';\n"
           "export default defineConfig({ test: { globals: true, "
           "environment: 'node', "
           "include: ['tests/**/*.{test,spec}.ts'] } });\n")
    _write(os.path.join(root, "src", "a.ts"), SYNTH_A_TEXT)
    _write(os.path.join(root, "src", "b.ts"), SYNTH_B_TEXT)
    # src/c.ts is imported by no assertion. Mutating it is a REAL destructive
    # mutation that must leave the designated witness assertion PASSING, which is
    # what proves the polarity end to end (mutation applied, verdict SURVIVED).
    _write(os.path.join(root, "src", "c.ts"), SYNTH_C_TEXT)
    _write(os.path.join(root, "tests", "unit", "synth.test.ts"),
           "import { describe, it, expect } from 'vitest';\n"
           "import { A } from '../../src/a';\n"
           "import { B } from '../../src/b';\n"
           "describe('synthetic battery executor [%s] designated assertion', () => {\n"
           "  it('passes only while both constants are 1', () => {\n"
           "    expect(A).toBe(1);\n    expect(B).toBe(1);\n  });\n"
           "});\n"
           "describe('synthetic battery executor [AI3-SYNTH-COLLATERAL] unrelated', () => {\n"
           "  it('is not the designated obligation', () => { expect(1).toBe(1); });\n"
           "});\n" % SYNTH_DESIGNATION)
    # the synthetic project resolves vitest through the repository's own deps
    nm = os.path.join(ROOT, "node_modules")
    link = os.path.join(root, "node_modules")
    if os.path.isdir(nm) and not os.path.lexists(link):
        os.symlink(os.path.realpath(nm), link)
    return root


def _synth_obligation(oid: str, destructive: bool, expected: str, specs: List[Dict[str, str]],
                      anchor: str = SYNTH_A_ANCHOR, replacement: str = SYNTH_MUTATION) -> Dict[str, Any]:
    ob: Dict[str, Any] = {
        "obligation": oid, "row": oid, "kind": "single",
        "sub_id": "single", "designation": SYNTH_DESIGNATION,
        "witness": ["tests/unit/synth.test.ts"], "expected": expected,
        "destructive": destructive, "verdict_source": "expected_verdict",
        "mutation_owner": oid, "specs": [], "active_components": None,
        "resolved_fullname": None}
    if destructive:
        ob["specs"] = specs or [{"file": "src/a.ts", "anchor": anchor,
                                 "replacement": replacement}]
    return ob


def _fake_runner(status: str, extra: Optional[List[Dict[str, Any]]] = None,
                 error: Optional[str] = None, include_designated: bool = True,
                 capture: Optional[Dict[str, Any]] = None) -> Any:
    """Injected structured-report producer. Used ONLY by the synthetic
    self-tests; `run_battery` always wires the real Vitest runner."""
    def runner(capsule_dir: str, witness_files: List[str], timeout_s: int) -> Dict[str, Any]:
        if capture is not None:
            # snapshot the capsule's own copy of the mutation target at run time
            p = os.path.join(capsule_dir, "src", "a.ts")
            capture["capsule_a_ts"] = open(p, encoding="utf-8").read() \
                if os.path.isfile(p) else None
            capture["report_in_capsule"] = os.path.isfile(
                os.path.join(capsule_dir, CAPSULE_REPORT_NAME))
        if error:
            return {"report": None, "code": None, "error": error}
        results: List[Dict[str, Any]] = []
        if include_designated:
            results.append({"fullName": SYNTH_FULLNAME, "status": status})
        results += list(extra or [])
        return {"report": {"testResults": [{"name": witness_files[0],
                                           "assertionResults": results}]},
                "code": 0 if status == "passed" else 1, "error": None}
    return runner


def _executor_fixtures(root: str) -> Dict[str, Any]:
    a_sha = sha256_of(os.path.join(root, "src", "a.ts"))
    cap: Dict[str, Any] = {}
    return {
        "a_sha": a_sha, "a_text": SYNTH_A_TEXT, "full": SYNTH_FULLNAME,
        "collateral": SYNTH_COLLATERAL, "capture": cap,
        "caught_ob": _synth_obligation("SYN:CAUGHT", True, CAUGHT, None),
        "survived_ob": _synth_obligation("SYN:SURVIVED", True, SURVIVED, None),
        "ob_anchor0": _synth_obligation("SYN:A0", True, CAUGHT,
                                        [{"file": "src/a.ts", "anchor": "NOT-PRESENT",
                                          "replacement": "x"}]),
        "ob_anchor2": _synth_obligation("SYN:A2", True, CAUGHT,
                                        [{"file": "src/a.ts", "anchor": SYNTH_REPEATED_ANCHOR,
                                          "replacement": "= 2;"}]),
        "multi_ob": _synth_obligation("SYN:MULTI", True, CAUGHT, [
            {"file": "src/a.ts", "anchor": SYNTH_A_ANCHOR, "replacement": SYNTH_MUTATION},
            {"file": "src/b.ts", "anchor": SYNTH_B_ANCHOR,
             "replacement": "export const B = 2;"}]),
        "control_ob": _synth_obligation("SYN:PIN", False, PIN_GREEN, None),
        "fake_runner_failed": _fake_runner("failed", capture=cap),
        "fake_runner_passed": _fake_runner("passed"),
        "fake_runner_skipped": _fake_runner("skipped"),
        "fake_runner_missing": _fake_runner("passed", include_designated=False),
        "fake_runner_duplicate": _fake_runner("failed", [
            {"fullName": "second suite [AI3-SYNTH-HIST] designated assertion",
             "status": "passed"}]),
        "fake_runner_passed_collateral": _fake_runner("passed", [
            {"fullName": SYNTH_COLLATERAL, "status": "failed"}]),
        "fake_runner_crash": _fake_runner("passed", error="synthetic vitest crash"),
    }


def _real_runner_end_to_end(root: str, ex: Dict[str, Any]) -> Dict[str, Any]:
    """Drive the REAL Vitest runner through a REAL capsule twice: once with the
    synthetic mutation applied (designated test must FAIL -> CAUGHT) and once
    unmutated (designated test must PASS -> SURVIVED_AS_EXPECTED)."""
    out: Dict[str, Any] = {"ok": False, "source_unchanged": False,
                           "capsules_cleaned": False}
    before = ex["a_sha"]
    c_sha = sha256_of(os.path.join(root, "src", "c.ts"))
    r_mut = execute_obligation(ex["caught_ob"], root, run_vitest_structured, timeout_s=600)
    r_clean = execute_obligation(ex["control_ob"], root, run_vitest_structured, timeout_s=600)
    # A REAL destructive mutation to a file no assertion imports: the mutation is
    # genuinely applied inside the capsule, yet the designated assertion still
    # PASSES, so expected CAUGHT must reconcile to VERDICT_MISMATCH.
    r_escaped = execute_obligation(
        _synth_obligation("SYN:ESCAPED", True, CAUGHT,
                          [{"file": "src/c.ts", "anchor": SYNTH_C_ANCHOR,
                            "replacement": SYNTH_C_MUTATION}]),
        root, run_vitest_structured, timeout_s=600)
    out.update({
        "caught_final": r_mut["final"],
        "caught_designated_status": r_mut["designated_status"],
        "caught_fullname": r_mut["resolved_fullname"],
        "caught_discovery": r_mut["discovery"],
        "caught_attribution": r_mut["attribution"],
        "caught_process_code": r_mut["process_code"],
        "caught_collateral": r_mut["collateral_failures"],
        "survived_final": r_clean["final"],
        "survived_designated_status": r_clean["designated_status"],
        "escaped_final": r_escaped["final"],
        "escaped_observed": r_escaped["observed"],
        "escaped_mutation_applied": [a["file"] for a in r_escaped["applied"]],
        "escaped_source_unchanged": sha256_of(os.path.join(root, "src", "c.ts")) == c_sha,
        "source_unchanged": sha256_of(os.path.join(root, "src", "a.ts")) == before,
        "capsules_cleaned": (r_mut["capsule_cleaned"] is True
                             and r_clean["capsule_cleaned"] is True
                             and r_escaped["capsule_cleaned"] is True),
        "no_report_left_in_source_root": not os.path.exists(
            os.path.join(root, CAPSULE_REPORT_NAME)),
    })
    out["ok"] = bool(out["caught_final"] == CAUGHT
                     and out["caught_designated_status"] == "failed"
                     and out["caught_discovery"] == "EXACT"
                     and out["caught_attribution"] == "EXACT"
                     and out["survived_final"] == PIN_GREEN
                     and out["survived_designated_status"] == "passed"
                     and out["escaped_final"] == VERDICT_MISMATCH
                     and out["escaped_observed"] == SURVIVED
                     and out["escaped_mutation_applied"] == ["src/c.ts"]
                     and out["escaped_source_unchanged"]
                     and discover_identities([out["caught_fullname"]],
                                             SYNTH_DESIGNATION)
                     == (out["caught_fullname"], "EXACT")
                     and out["source_unchanged"] and out["capsules_cleaned"]
                     and out["no_report_left_in_source_root"])
    return out


def _temp_entries(prefixes: Tuple[str, ...] = TEMP_PREFIXES) -> Set[str]:
    root = tempfile.gettempdir()
    try:
        return {n for n in os.listdir(root) if n.startswith(prefixes)}
    except OSError:
        return set()


def _root_from_this_file() -> str:
    """Independent re-derivation of the repository root from this file."""
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.isfile(os.path.join(cur, "scripts", "ai3_mutation_manifest.json")):
            return os.path.realpath(cur)
        cur = os.path.dirname(cur)
    raise RuntimeError("root re-derivation failed")


def _src_text() -> str:
    return open(os.path.abspath(__file__), encoding="utf-8").read()


def _works_under_redirected_tmpdir() -> bool:
    """Prove no pre-existing scratch location is required: point the temp root at
    a brand-new directory and confirm a capsule is created inside it."""
    saved = os.environ.get("TMPDIR")
    fresh_root = tempfile.mkdtemp(prefix="ai3-redirect-")
    outer = os.environ.get("TMPDIR")
    try:
        os.environ["TMPDIR"] = fresh_root
        tempfile.tempdir = None                       # drop the resolved cache
        resolved = tempfile.gettempdir()
        if os.path.realpath(resolved) != os.path.realpath(fresh_root):
            return False
        cap = Capsule()
        d = cap.dir
        cap.materialize(["package.json"])
        ok = os.path.dirname(os.path.realpath(d)) == os.path.realpath(fresh_root) \
            and os.path.isdir(d)
        cap.close()
        return ok and not os.path.exists(d)
    finally:
        tempfile.tempdir = None
        if saved is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = saved
        if outer is not None:
            os.environ["TMPDIR"] = outer
        shutil.rmtree(fresh_root, ignore_errors=True)


def _missing_if_planner_skips(manifest: Dict[str, Any], skipped: str) -> List[str]:
    """Run the accounting against a planner result that intentionally skips one id."""
    holed = {k: v for k, v in plan_execution(manifest).items() if k != skipped}
    return post_normalization_accounting(manifest, normalize(manifest)[0], holed)[
        "missing_planned_obligations"]


def _main_reads_top_level_ran(text: str) -> bool:
    """AST proof that the `--run-battery` branch of `main()` never gates on a
    top-level `out.get("ran")`. Scoped to that branch on purpose: the
    `--identity-preflight` branch legitimately reads a top-level `ran` from
    `identity_preflight()`. Structural, so the check does not have to spell the
    broken expression in its own source."""
    import ast
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.FunctionDef) and node.name == "main"):
            continue
        for sub in ast.walk(node):
            if not (isinstance(sub, ast.If) and "--run-battery" in ast.dump(sub.test)):
                continue
            for inner in ast.walk(sub):
                if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                        and inner.func.attr == "get" and inner.args
                        and isinstance(inner.args[0], ast.Constant)
                        and inner.args[0].value == "ran"
                        and isinstance(inner.func.value, ast.Name)
                        and inner.func.value.id == "out"):
                    return True
    return False


def _defines_callable_named(text: str, name: str) -> bool:
    """AST proof that no function with this name is defined. Structural, so the
    check never has to mention the name inside its own source text."""
    import ast
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == name:
                return True
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == name:
                    return True
    return False


def _has_verdict_default(text: str) -> bool:
    """AST proof that no expected-verdict read in this module supplies a fallback
    value. An absent token is a structural problem, never a default verdict."""
    import ast
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr not in ("get", "setdefault") or len(node.args) < 2:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str) \
                and first.value in ("expected_verdict", "expected", "expected_verdicts"):
            return True
    return False


def _raises(fn) -> bool:
    try:
        fn()
        return False
    except Exception:
        return True


def _raises_val(fn) -> Any:
    try:
        return fn()
    except Exception as e:
        return e


def battery_accepted(out: Any) -> bool:
    """THE CLI EXIT GATE for --run-battery.

    The authoritative completion flag is `summary.ran`, which `run_battery` sets
    only after every obligation has actually executed. This is exactly the
    authorized nested lookup `out.get("summary", {}).get("ran")`.

    A top-level `ran` is NOT this gate. `run_battery` puts a top-level
    `ran: False` on its two early-refusal paths (normalization problems, planned
    vs normalized accounting disagreement) and those dicts carry no `summary` at
    all. Reading the top level therefore rejected every one of them correctly but
    ALSO rejected a fully completed 32-obligation battery, which made the first
    authoritative F1-B run print its complete valid result set under
    `BATTERY REFUSED` and exit 2. Semantics are unchanged from the authorized
    line: a missing `summary` or a falsy `summary.ran` is rejected.
    """
    if not isinstance(out, dict):
        return False
    summary = out.get("summary")
    if not isinstance(summary, dict):
        return False
    return bool(summary.get("ran"))


def main() -> int:
    if "--self-test" in sys.argv:
        return 0 if self_test() else 1
    if "--dry-preflight" in sys.argv:
        pre = dry_preflight(load_manifest())
        for k in sorted(pre):
            print("  %-38s %s" % (k, pre[k]))
        ok = not (pre["problems"] or pre["duplicate_designations"] or pre["missing_witness"]
                  or pre["missing_designation"] or pre["anchor_problems"]
                  or pre["post_normalization_extras"] or pre["missing_planned_obligations"]
                  or pre["unexecutable_destructive_obligations"]
                  or pre["implicit_default_verdicts"] or pre["invalid_row_types"]
                  or pre["invalid_mutation_owner_refs"] or pre["invalid_expected_verdicts"]
                  or pre["legacy_authoritative_usage"])
        print("  DRY PREFLIGHT OK: %s" % ok)
        return 0 if ok else 1
    if "--identity-preflight" in sys.argv:
        out = identity_preflight(load_manifest())
        for k in sorted(out):
            if k != "rows":
                print("  %-34s %s" % (k, out[k]))
        ok = bool(out.get("ran")) and not out.get("problems") and not out.get("error") \
            and out.get("resolved_exactly_one") == out.get("obligations") \
            and not out.get("missing") and not out.get("ambiguous") \
            and out.get("substring_only_accepted") == 0 \
            and out.get("retained_fullnames_unique")
        print("  IDENTITY PREFLIGHT OK: %s" % ok)
        return 0 if ok else 1
    if "--run-battery" in sys.argv:
        out = run_battery(load_manifest())
        if not battery_accepted(out):
            print("  BATTERY REFUSED: %s" % json.dumps(out, indent=1, default=str))
            return 2
        print()
        print("  %-18s %-30s %-22s %-22s %s" % ("obligation", "designation",
                                                "expected", "final", "designated"))
        for r in out["results"]:
            print("  %-18s %-30s %-22s %-22s %s" % (
                r["obligation"], r["designation"], r["expected"], r["final"],
                r["designated_status"]))
        print()
        for k in sorted(out["summary"]):
            print("  %-34s %s" % (k, out["summary"][k]))
        s = out["summary"]
        ok = (not s["verdict_mismatch"] and not s["structural_invalid"]
              and not s["witness_failure"] and not s["not_proven"]
              and not s["designation_failures"] and not s["attribution_failures"]
              and not s["capsules_not_cleaned"] and not s["source_mutations"]
              and not s["extra_verdict_executions"]
              and s["matched_expectation"] == s["obligations"]
              and s["executed"] == s["obligations"])
        print("  BATTERY OK: %s" % ok)
        return 0 if ok else 1
    print(__doc__)
    print("usage: verify_ai3_mutations.py "
          "[--self-test | --dry-preflight | --identity-preflight | --run-battery]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
