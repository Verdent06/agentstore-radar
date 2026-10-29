#!/usr/bin/env bash
# Commit snapshot files in the private data repo and push with pull --rebase retries.
# Refuses to commit zero-size snapshot files or a broken empty snapshot folder.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <data-repo-dir> [YYYY-MM-DD]" >&2
  exit 2
fi

DATA_REPO=$(cd "$1" && pwd)
DATE="${2:-$(date -u +%F)}"
ATTEMPTS="${GIT_PUSH_ATTEMPTS:-5}"

cd "$DATA_REPO"
git config user.name "${GIT_AUTHOR_NAME:-github-actions[bot]}"
git config user.email "${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

NORMALIZED="data/normalized/${DATE}"
if [[ -f "$NORMALIZED" ]]; then
  echo "push: removing broken snapshot file $NORMALIZED"
  rm -f "$NORMALIZED"
fi
if [[ -d "$NORMALIZED" ]]; then
  if [[ ! -s "$NORMALIZED/manifest.json" ]]; then
    echo "push: refusing broken empty snapshot directory $NORMALIZED"
    find "$NORMALIZED" -type f -size 0 -print -delete || true
    if [[ ! -s "$NORMALIZED/manifest.json" ]]; then
      rm -rf "$NORMALIZED"
    fi
  fi
fi

git add -A

# Drop any staged zero-size files so we never publish empty blobs.
while IFS= read -r -d '' file; do
  if [[ -f "$file" && ! -s "$file" ]]; then
    echo "push: unstaging zero-size $file"
    git restore --staged "$file" || true
    rm -f "$file"
  fi
done < <(git diff --cached --name-only -z)

if git diff --cached --quiet; then
  echo "No snapshot changes"
  exit 0
fi

git commit -m "data: snapshot ${DATE}"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]]; then
  BRANCH=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  BRANCH="${BRANCH:-main}"
fi
if ! git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    BRANCH=main
  elif git ls-remote --exit-code --heads origin master >/dev/null 2>&1; then
    BRANCH=master
  fi
fi

COLLECTOR_REF="${GITHUB_REF:-}"
if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  if [[ -n "$COLLECTOR_REF" && "$COLLECTOR_REF" != "refs/heads/main" && "$COLLECTOR_REF" != "refs/heads/master" ]]; then
    echo "push: refusing to push to data ${BRANCH} from collector ref ${COLLECTOR_REF}" >&2
    exit 1
  fi
fi

push_failed=0
for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch origin "$BRANCH" --quiet || git fetch origin --quiet
  if git pull --rebase origin "$BRANCH"; then
    if git push origin "HEAD:${BRANCH}"; then
      echo "push: succeeded on attempt ${attempt}"
      exit 0
    fi
  fi
  push_failed=1
  echo "push: attempt ${attempt} failed; retrying"
  git rebase --abort >/dev/null 2>&1 || true
  sleep "${GIT_PUSH_SLEEP_SECONDS:-$((2 ** attempt))}"
done

echo "push: failed after ${ATTEMPTS} attempts" >&2
exit "$push_failed"
