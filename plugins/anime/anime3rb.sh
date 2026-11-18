#!/bin/bash
# NAME: anime3rb
# TYPE: anime
# ────────────────────────────────────────────────────────────────
# Source plugin converted from the owner's own Termux script.
# Same site, same extractions — only the endings changed:
# instead of fzf + mpv, each stage PRINTS results in the contract
# format and the core (wizard + download) does the rest.
#   SEARCH   "query"            -> "title | id" lines
#   EPISODES "seriesId"         -> "COUNT n"
#   LINKS    "seriesId" "epRef" -> "label | url" lines
# ────────────────────────────────────────────────────────────────

BASE="http://103.155.92.42"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# ═══ SEARCH: query -> titles ═══════════════════════════════════
do_search() {
  local q="$1"
  local enc
  enc=$(echo "$q" | sed 's/ /%20/g')
  curl -sL -A "$UA" "$BASE/search?query=$enc" \
    | grep -oP '(?<=<a href=")https://103\.155\.92\.42/anime/[^"]+' \
    | sed 's@https://103.155.92.42/anime/@@' \
    | sort -u \
    | while IFS= read -r slug; do
        [ -z "$slug" ] && continue
        title=$(echo "$slug" | sed 's/-/ /g')
        echo "$title | $slug"
      done
}

# ═══ EPISODES: seriesId -> count ═══════════════════════════════
do_episodes() {
  local slug="$1"
  local n
  n=$(curl -sL -A "$UA" "$BASE/anime/$slug" \
      | grep -A1 'عدد الحلقات' | tail -n 1 | sed 's/[^0-9]//g')
  if [ -n "$n" ]; then
    echo "COUNT $n"
  fi
}

# ═══ LINKS: seriesId + episode number -> server links ══════════
do_links() {
  local slug="$1"
  local num="$2"
  curl -sL -A "$UA" "$BASE/watch/$slug/$num" \
    | grep -o 'https://bkvideo.online/v[^"]*' \
    | sed 's/"//g' \
    | awk '!seen[$0]++' \
    | awk '{print "Server " NR " | " $0}'
}

# ── Fixed skeleton part: run the stage the core asked for ──────
case "$1" in
  SEARCH)   do_search "$2" ;;
  EPISODES) do_episodes "$2" ;;
  LINKS)    do_links "$2" "$3" ;;
  *) echo "unknown stage: $1" >&2; exit 1 ;;
esac
