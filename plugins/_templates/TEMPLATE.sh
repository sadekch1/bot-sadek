#!/bin/bash
# NAME: my-source
# TYPE: anime
# ────────────────────────────────────────────────────────────────
#  THE UNIFIED SKELETON — copy this file, rename it, fill the
#  three stages. The header (NAME/TYPE) and the dispatcher at the
#  bottom never change. TYPE is one of: anime | series | movie |
#  kdrama — it decides which bot command (.anime/.series/...)
#  will use this source.
#
#  The core calls your script like this:
#    script.sh SEARCH   "the query"
#    script.sh EPISODES "seriesId-from-search"
#    script.sh LINKS    "seriesId" "episodeRef"
#
#  What each stage must PRINT (nothing else on stdout!):
#    SEARCH   -> one line per result:   title | id
#                (optional 3rd field:   title | id | posterUrl)
#    EPISODES -> either one line:       COUNT 24
#                or one line per ep:    epId | label
#    LINKS    -> one line per link:     label | url
#                (optional 3rd field:   label | url | referer)
#  Debug messages go to stderr (echo "..." >&2), never stdout.
# ────────────────────────────────────────────────────────────────

BASE="https://example.com"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# ═══ SEARCH: query -> titles ═══════════════════════════════════
# Your site's logic here: fetch the search page, extract results,
# print "title | id" for each.
do_search() {
  local q="$1"
  # curl -sL -A "$UA" "$BASE/search?q=$q" | ... your extraction ...
  :
}

# ═══ EPISODES: seriesId -> episodes ════════════════════════════
# Either print "COUNT n" (when episodes are just numbered 1..n)
# or print "epId | label" lines.
do_episodes() {
  local id="$1"
  :
}

# ═══ LINKS: seriesId + episodeRef -> links ═════════════════════
# Print "label | url" lines. The url may be a direct file, an
# .m3u8, or an embed page — the core download service resolves
# embeds and handles the rest.
do_links() {
  local id="$1"
  local ep="$2"
  :
}

# ── Fixed skeleton part: run the stage the core asked for ──────
case "$1" in
  SEARCH)   do_search "$2" ;;
  EPISODES) do_episodes "$2" ;;
  LINKS)    do_links "$2" "$3" ;;
  *) echo "unknown stage: $1" >&2; exit 1 ;;
esac
