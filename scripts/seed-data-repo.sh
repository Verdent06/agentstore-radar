#!/usr/bin/env bash
# One-time copy of snapshot files from the public repo's git history into a
# data-repo checkout. After the destination has any snapshot, this script
# does not read public history again (so a later public-history rewrite is safe).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <public-repo-dir> <data-repo-dir>" >&2
  exit 2
fi

PUBLIC_DIR=$(cd "$1" && pwd)
DATA_REPO=$(cd "$2" && pwd)
DEST="$DATA_REPO/data"
MARKER="$DEST/.migrated-from-public"

already_seeded() {
  [[ -f "$MARKER" ]] && return 0
  find "$DEST/normalized" -mindepth 2 -maxdepth 2 -name manifest.json 2>/dev/null | grep -q .
}

if already_seeded; then
  echo "seed: data repo already has snapshots; not reading public git history"
  exit 0
fi

cd "$PUBLIC_DIR"
SHA=$(git rev-list -n 1 --all -- data/normalized 2>/dev/null || true)
if [[ -z "${SHA}" ]]; then
  echo "seed: no public data/normalized history found"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if ! git archive "$SHA" data 2>/dev/null | tar -x -C "$TMP"; then
  echo "seed: git archive of $SHA failed" >&2
  exit 1
fi
if [[ ! -d "$TMP/data" ]]; then
  echo "seed: archive $SHA had no data/ tree"
  exit 0
fi

mkdir -p "$DEST"
cp -a "$TMP/data/." "$DEST/"
printf '%s\n' "$SHA" > "$MARKER"
echo "seed: copied data/ from public commit $SHA into $DEST"
if [[ -d "$DEST/normalized" ]]; then
  echo "seed: snapshot dates now: $(find "$DEST/normalized" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tr '\n' ' ')"
fi
