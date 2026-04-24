#!/usr/bin/env bash
# ── debug-jira-ticket.sh ──────────────────────────────────────────────────────
# Fetches a JIRA ticket with ?expand=names and prints:
#   1. Basic fields (summary, type, description snippet)
#   2. Names map (customfield_XXXXX → display name)
#   3. Keyword-matched fields (AC, steps, behavior…) with their values
#   4. Auto-discovery simulation — mirrors exactly what Meridian does
#
# Uses the same env vars already defined in ~/.zshrc:
#   JIRA_EMAIL        (Atlassian account email)
#   JIRA_API_TOKEN    (your Atlassian API token)
#   JIRA_BASE_URL     (optional — defaults to https://bdbi.atlassian.net)
#
# Usage:
#   ./scripts/debug-jira-ticket.sh FJP-7572
#   VERBOSE=1 ./scripts/debug-jira-ticket.sh FJP-7572   # dump all non-null fields
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ISSUE_KEY="${1:-}"
if [[ -z "$ISSUE_KEY" ]]; then
  echo "Usage: $0 <ISSUE-KEY>  (e.g. FJP-7572)" >&2
  exit 1
fi

JIRA_BASE_URL="${JIRA_BASE_URL:-https://bdbi.atlassian.net}"
: "${JIRA_EMAIL:?JIRA_EMAIL not set — should be defined in ~/.zshrc}"
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN not set — should be defined in ~/.zshrc}"

AUTH="$(printf '%s:%s' "${JIRA_EMAIL}" "${JIRA_API_TOKEN}" | base64)"
URL="${JIRA_BASE_URL}/rest/api/3/issue/${ISSUE_KEY}?expand=names"

# Use the corporate CA bundle if setup-certs has been run, otherwise system default
CURL_OPTS=(-s -H "Authorization: Basic ${AUTH}" -H "Accept: application/json")
if [[ -f "$HOME/.certs/all.pem" ]]; then
  CURL_OPTS+=(--cacert "$HOME/.certs/all.pem")
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Meridian JIRA Debug — ${ISSUE_KEY}"
echo "  ${URL}"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Save response to a temp file so we can read it multiple times without
# the pipe+heredoc conflict (can't pipe $VAR and use <<'EOF' to the same process).
TMP=$(mktemp /tmp/meridian-jira-debug.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT

HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o "$TMP" -w "%{http_code}" "${URL}")

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[ERROR] JIRA returned HTTP ${HTTP_STATUS}"
  python3 -m json.tool "$TMP" 2>/dev/null || cat "$TMP"
  exit 1
fi

if ! python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if 'fields' in d else 1)" "$TMP" 2>/dev/null; then
  echo "[ERROR] Response does not contain a 'fields' key:"
  cat "$TMP"
  exit 1
fi

echo "[OK] HTTP ${HTTP_STATUS} — received issue response."

# ── 1. Basic fields ───────────────────────────────────────────────────────────
echo ""
echo "── Basic fields ─────────────────────────────────────────────────"
python3 - "$TMP" <<'PYEOF'
import sys, json

def adf_text(node):
    if not isinstance(node, dict): return ""
    if "text" in node: return node["text"]
    return "\n".join(adf_text(c) for c in node.get("content", []))

d = json.load(open(sys.argv[1]))
f = d.get("fields", {})

print(f"  Key:         {d.get('key')}")
print(f"  Summary:     {f.get('summary', '')[:80]}")
print(f"  Issue type:  {f.get('issuetype', {}).get('name')}")
print(f"  Status:      {f.get('status', {}).get('name')}")

desc = f.get("description")
if isinstance(desc, dict):
    text = adf_text(desc).strip()
    print(f"  Description: {text[:120]}{'…' if len(text) > 120 else ''}")
elif desc:
    print(f"  Description: {str(desc)[:120]}")
else:
    print(f"  Description: (none)")
PYEOF

# ── 2. Names map ──────────────────────────────────────────────────────────────
echo ""
echo "── Names map (customfield_XXXXX → display name) ─────────────────"
python3 - "$TMP" <<'PYEOF'
import sys, json

d = json.load(open(sys.argv[1]))
names = d.get("names", {})
if not names:
    print("  (no names map returned — field auto-discovery will not work)")
else:
    for fid, fname in sorted(names.items()):
        if fid.startswith("customfield_"):
            print(f"  {fid}  →  {fname}")
PYEOF

# ── 3. Keyword matches ────────────────────────────────────────────────────────
echo ""
echo "── Fields matching AC / steps / behavior keywords ───────────────"
python3 - "$TMP" <<'PYEOF'
import sys, json

def adf_text(node):
    if not isinstance(node, dict): return ""
    if "text" in node: return node["text"]
    return "\n".join(adf_text(c) for c in node.get("content", []))

def display_value(v):
    if v is None: return "(null)"
    if isinstance(v, str): return v.strip()[:300] or "(empty string)"
    if isinstance(v, dict) and v.get("type") == "doc":
        t = adf_text(v).strip()
        return t[:300] if t else "(ADF doc — no text extracted)"
    if isinstance(v, (int, float)): return str(v)
    return json.dumps(v)[:300]

keywords = ["accept", "criteria", "steps", "reproduce", "behavior", "behaviour", "expected", "observed"]

d = json.load(open(sys.argv[1]))
names = d.get("names", {})
fields = d.get("fields", {})

found = False
for fid, val in sorted(fields.items()):
    fname = names.get(fid, fid)
    if any(kw in fname.lower() for kw in keywords):
        dv = display_value(val)
        print(f"  {fid}  [{fname}]")
        print(f"    value: {dv}")
        found = True

if not found:
    print("  (no matching fields found)")
PYEOF

# ── 4. Auto-discovery simulation ──────────────────────────────────────────────
echo ""
echo "── Meridian auto-discovery simulation ───────────────────────────"
python3 - "$TMP" <<'PYEOF'
import sys, json

def adf_text(node):
    if not isinstance(node, dict): return ""
    if "text" in node: return node["text"]
    return "\n".join(adf_text(c) for c in node.get("content", []))

d = json.load(open(sys.argv[1]))
names = d.get("names", {})
fields_data = d.get("fields", {})

name_to_id = {v.lower(): k for k, v in names.items()}

checks = {
    "acceptance_criteria": ["acceptance criteria", "acceptance_criteria"],
    "steps_to_reproduce":  ["steps to reproduce", "steps_to_reproduce"],
    "observed_behavior":   ["observed behavior", "observed behaviour"],
    "expected_behavior":   ["expected behavior", "expected behaviour", "expected result", "expected results"],
}

print("  Field resolution:")
for semantic, candidates in checks.items():
    found_id = None
    found_name = None
    for candidate in candidates:
        if candidate in name_to_id:
            found_id = name_to_id[candidate]
            found_name = candidate
            break
    if found_id:
        raw_val = fields_data.get(found_id)
        if isinstance(raw_val, dict) and raw_val.get("type") == "doc":
            extracted = adf_text(raw_val).strip()
        elif isinstance(raw_val, str):
            extracted = raw_val.strip()
        else:
            extracted = json.dumps(raw_val) if raw_val is not None else None

        if extracted:
            preview = extracted[:100] + ("…" if len(extracted) > 100 else "")
            print(f"  ✓ {semantic:30s} → {found_id}  (matched '{found_name}')")
            print(f"      value: {preview}")
        else:
            print(f"  ⚠ {semantic:30s} → {found_id}  (matched '{found_name}') but VALUE IS EMPTY/NULL")
    else:
        print(f"  ✗ {semantic:30s} → NOT FOUND  (tried: {candidates})")

print("")
print("  ✗ = field ID not auto-discovered. Check the Names map above for the")
print("      actual display name and add it to jira.rs or Settings → Custom Fields.")
print("  ⚠ = field ID found but contains no value for this ticket.")
PYEOF

# ── 5. Full field dump (VERBOSE=1) ────────────────────────────────────────────
echo ""
if [[ "${VERBOSE:-0}" == "1" ]]; then
  echo "── Full field dump (VERBOSE=1) ──────────────────────────────────"
  python3 - "$TMP" <<'PYEOF'
import sys, json

def adf_text(node):
    if not isinstance(node, dict): return ""
    if "text" in node: return node["text"]
    return "\n".join(adf_text(c) for c in node.get("content", []))

def display_value(v):
    if v is None: return None
    if isinstance(v, str): return v.strip()[:300] or None
    if isinstance(v, dict) and v.get("type") == "doc":
        t = adf_text(v).strip()
        return t[:300] if t else None
    if isinstance(v, (int, float, bool)): return str(v)
    if isinstance(v, list):
        if not v: return None
        return ", ".join(str(display_value(x) or "") for x in v[:5])
    if isinstance(v, dict):
        for key in ("name", "value", "displayName", "summary", "accountId"):
            if key in v and v[key]: return f"{{{key}: {v[key]}}}"
    return json.dumps(v)[:300]

d = json.load(open(sys.argv[1]))
names = d.get("names", {})
fields = d.get("fields", {})

for fid in sorted(fields.keys()):
    dv = display_value(fields[fid])
    if not dv: continue
    fname = names.get(fid, fid)
    print(f"  {fid}  [{fname}]")
    print(f"    {dv}")
PYEOF
else
  echo "(Run with VERBOSE=1 to dump all non-null fields)"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Done."
echo "════════════════════════════════════════════════════════════════"
echo ""

