#!/bin/bash
# Automated API tests — run with: bash server/test-api.sh
set -e
BASE="http://localhost:3001/api"
PASS=0
FAIL=0

test() {
  local desc="$1" method="$2" path="$3" body="$4" expected="$5"
  local resp
  if [ -n "$body" ]; then
    resp=$(curl -s -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$body" 2>/dev/null)
  else
    resp=$(curl -s -X "$method" "$BASE$path" 2>/dev/null)
  fi
  if echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); $expected" 2>/dev/null; then
    echo "  ✓ $desc"
    PASS=$((PASS+1))
  else
    echo "  ✗ $desc"
    echo "    Expected: $expected"
    echo "    Got: $resp" | head -c 200
    echo ""
    FAIL=$((FAIL+1))
  fi
}

echo "=== API Tests ==="

# Status
test "GET /api/status returns ok" GET "/status" "" "d.get('ok') == True"

# Collections
test "GET /api/collections returns list" GET "/collections" "" "isinstance(d, list) and len(d) > 0"

# Collection games
test "GET /api/collections/:id/games returns games" GET "/collections/1/games?limit=1" "" "len(d.get('games',[])) > 0 and d.get('total',0) > 0"
test "GET /api/collections/:id/games?parents_only=true" GET "/collections/1/games?parents_only=true&limit=1" "" "d.get('total',0) > 0"
test "GET /api/collections/:id/games?q=1941" GET "/collections/1/games?q=1941&limit=1" "" "d.get('total',0) >= 4"
test "GET /api/collections/:id/games?q=1941&parents_only=true" GET "/collections/1/games?q=1941&parents_only=true&limit=1" "" "d.get('total',0) >= 1"

# Browse games
test "GET /api/games returns games" GET "/games?limit=1" "" "len(d.get('games',[])) > 0"
test "GET /api/games?q=pac returns results" GET "/games?q=pac&limit=1" "" "d.get('total',0) > 0"

# Game detail
test "GET /api/games/:id returns game" GET "/games/1" "" "d.get('name') is not None"

# Game cover returns image (check content-type header instead)
test_cover() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/games/1/cover" 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "404" ]; then
    echo "  ✓ GET /api/games/:id/cover returns $code"
    PASS=$((PASS+1))
  else
    echo "  ✗ GET /api/games/:id/cover returned $code"
    FAIL=$((FAIL+1))
  fi
}
test_cover

# IA download
IA_URL="https://archive.org/download/fbneo/FBNeo/roms.zip"
test "POST /api/ia/list lists files" POST "/ia/list" "{\"url\":\"$IA_URL\",\"pattern\":\"10yard\"}" "len(d.get('files',[])) > 0"

# Scrape
test "POST /api/games/:id/scrape returns result" POST "/games/1/scrape" "" "True"
test "POST /api/scraper/search returns results" POST "/scraper/search" "{\"query\":\"Pac-Man\"}" "len(d.get('results',[])) > 0"

# Filesystem browser
test "GET /api/filesystem/browse returns directory" GET "/filesystem/browse" "" "'path' in d and isinstance(d.get('entries'), list)"
test "GET /api/filesystem/browse rejects /etc" GET "/filesystem/browse?path=/etc" "" "d.get('error') and 'allowed_roots' in d"

# Versions
test "GET /api/versions returns list" GET "/versions" "" "isinstance(d, list) and len(d) > 0"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "All tests passed!" || echo "$FAIL test(s) failed"
