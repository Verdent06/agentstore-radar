#!/usr/bin/env bash
# Copy snapshot files from the public repo's git history into a data-repo
# checkout. Never overwrites files that already exist in the destination
# (so a later public commit cannot clobber private history).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <public-repo-dir> <data-repo-dir>" >&2
  exit 2
fi

PUBLIC_DIR=$(cd "$1" && pwd)
DATA_REPO=$(cd "$2" && pwd)
DEST="$DATA_REPO/data"

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
# --ignore-existing keeps dates already in the private repo intact and
# still picks up new files (e.g. a later public collect that added github/).
cp -an "$TMP/data/." "$DEST/"
echo "seed: copied missing files from public commit $SHA into $DEST"
if [[ -d "$DEST/normalized" ]]; then
  echo "seed: snapshot dates now: $(find "$DEST/normalized" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tr '\n' ' ')"
fi
