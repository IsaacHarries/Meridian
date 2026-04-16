#!/usr/bin/env bash
# ── debug-jira-ticket.sh ──────────────────────────────────────────────────────
# Fetches a JIRA ticket with ?expand=names and prints:
#   1. The `names` map (field ID → display name) — shows all custom field IDs
#   2. The resolved fields Meridian extracts (description, AC, stepsToReproduce…)
#   3. Any field whose display name contains keywords like "accept", "criteria",
#      "steps", "reproduce", "behavior", "behaviour"
#
# Usage:
#   JIRA_BASE_URL=https://your-org.atlassian.net \
#   JIRA_EMAIL=you@example.com \
#   JIRA_TOKEN=your-api-token \
#   ./scripts/debug-jira-ticket.sh FJP-7572
#
# Or set the vars in a .env file and source it first.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ISSUE_KEY="${1:-}"
if [[ -z "$ISSUE_KEY" ]]; then
  echo "Usage: $0 <ISSUE-KEY>  (e.g. FJP-7572)" >&2
  exit 1
fi

: "${JIRA_BASE_URL:?Set JIRA_BASE_URL (e.g. https://your-org.atlassian.net)}"
: "${JIRA_EMAIL:?Set JIRA_EMAIL}"
: "${JIRA_TOKEN:?Set JIRA_TOKEN}"

AUTH="$(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64)"
URL="${JIRA_BASE_URL}/rest/api/3/issue/${ISSUE_KEY}?expand=names"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Meridian JIRA Debug — ${ISSUE_KEY}"
echo "  ${URL}"
echo "════════════════════════════════════════════════════════════════"
echo ""

RESPONSE=$(curl -s \
  -H "Authorization: Basic ${AUTH}" \
  -H "Accept: application/json" \
  "${URL}")

# Check for error
if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'fields' in d else 1)" 2>/dev/null; then
  echo "[OK] Received issue response."
else
  echo "[ERROR] JIRA returned an error:"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi

# ── 1. Summary / meta ─────────────────────────────────────────────────────────
echo ""
echo "── Basic fields ─────────────────────────────────────────────────"
echo "$RESPONSE" | python3 - <<'EOF'
import sys, json

d = json.load(sys.stdin)
f = d.get("fields", {})

print(f"  Key:         {d.get('key')}")
print(f"  Summary:     {f.get('summary', '')[:80]}")
print(f"  Issue type:  {f.get('issuetype', {}).get('name')}")
print(f"  Status:      {f.get('status', {}).get('name')}")

desc = f.get("description")
if desc and isinstance(desc, dict):
    # ADF — extract text
    def adf_text(node):
        if not isinstance(node, dict): return ""
        if "text" in node: return node["text"]
        return " ".join(adf_text(c) for c in node.get("content", []))
    text = adf_text(desc).strip()
    print(f"  Description: {text[:120]}{'…' if len(text) > 120 else ''}")
elif desc:
    print(f"  Description: {str(desc)[:120]}")
else:
    print(f"  Description: (none)")
EOF

# ── 2. Names map — all custom field IDs with display names ────────────────────
echo ""
echo "── Names map (customfield_XXXXX → display name) ─────────────────"
echo "$RESPONSE" | python3 - <<'EOF'
import sys, json

d = json.load(sys.stdin)
names = d.get("names", {})
if not names:
    print("  (no names map returned — field discovery will not work)")
else:
    # Sort by field ID
    for fid, fname in sorted(names.items()):
        if fid.startswith("customfield_"):
            print(f"  {fid}  →  {fname}")
EOF

# ── 3. Keyword matches — AC, steps, behavior ──────────────────────────────────
echo ""
echo "── Fields matching AC / steps / behavior keywords ───────────────"
echo "$RESPONSE" | python3 - <<'EOF'
import sys, json

def adf_text(node):
    if not isinstance(node, dict): return ""
    if "text" in node: return node["text"]
    return "\n".join(adf_text(c) for c in node.get("content", []))

def display_value(v):
    if v is None: return "(null)"
    if isinstance(v, str): return v.strip()[:200] or "(empty string)"
    if isinstance(v, dict) and v.get("type") == "doc":
        t = adf_text(v).strip()
        return t[:200] if t else "(ADF doc — no text content)"
    if isinstance(v, (int, float)): return str(v)
    return json.dumps(v)[:200]

keywords = ["accept", "criteria", "steps", "reproduce", "behavior", "behaviour", "expected", "observed"]

d = json.load(sys.stdin)
names = d.get("names", {})
fields = d.get("fields", {})

found = False
for fid, val in fields.items():
    fname = names.get(fid, fid)
    fname_lower = fname.lower()
    fid_lower = fid.lower()
    if any(kw in fname_lower or kw in fid_lower for kw in keywords):
        dv = display_value(val)
        print(f"  {fid}  [{fname}]")
        print(f"    value: {dv}")
        found = True

if not found:
    print("  (no matching fields found — AC may be embedded in the description)")
EOF

# ── 4. What Meridian auto-discovers ──────────────────────────────────────────
echo ""
echo "── Meridian auto-discovery simulation ──────────────────────────"
echo "$RESPONSE" | python3 - <<'EOF'
import sys, json

d = json.load(sys.stdin)
names = d.get("names", {})

# Mirror Meridian's lookup logic (jira.rs get_issue)
name_to_id = {v.lower(): k for k, v in names.items()}

checks = {
    "acceptance_criteria": ["acceptance criteria", "acceptance_criteria"],
    "steps_to_reproduce":  ["steps to reproduce", "steps_to_reproduce"],
    "observed_behavior":   ["observed behavior", "observed behaviour"],
    "expected_behavior":   ["expected behavior", "expected behaviour", "expected result", "expected results"],
}

for semantic, candidates in checks.items():
    found_id = None
    found_name = None
    for candidate in candidates:
        if candidate in name_to_id:
            found_id = name_to_id[candidate]
            found_name = candidate
            break
    if found_id:
        print(f"  ✓ {semantic:30s} → {found_id}  (matched '{found_name}')")
    else:
        print(f"  ✗ {semantic:30s} → NOT FOUND  (tried: {candidates})")

print("")
print("  If a field shows ✗, add its field ID manually in Settings → JIRA Custom Fields")
print("  OR add the content as a heading section in the ticket description.")
EOF

# ── 5. Full field dump (optional) ─────────────────────────────────────────────
echo ""
if [[ "${VERBOSE:-0}" == "1" ]]; then
  echo "── Full field dump (VERBOSE=1) ──────────────────────────────────"
  echo "$RESPONSE" | python3 - <<'EOF'
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
        return t[:300] if t else "(ADF doc — no text)"
    if isinstance(v, (int, float, bool)): return str(v)
    if isinstance(v, list):
        if not v: return "(empty list)"
        return ", ".join(str(display_value(x)) for x in v[:5])
    if isinstance(v, dict):
        for key in ("name", "value", "displayName", "summary", "accountId"):
            if key in v: return f"{{{key}: {v[key]}}}"
    return json.dumps(v)[:300]

d = json.load(sys.stdin)
names = d.get("names", {})
fields = d.get("fields", {})

for fid in sorted(fields.keys()):
    val = fields[fid]
    if val is None or val == [] or val == "": continue
    fname = names.get(fid, fid)
    print(f"  {fid}  [{fname}]")
    print(f"    {display_value(val)}")
EOF
else
  echo "(Run with VERBOSE=1 to dump all non-null fields)"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Done."
echo "════════════════════════════════════════════════════════════════"
echo ""

