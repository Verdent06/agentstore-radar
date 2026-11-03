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
# A global commit.gpgsign or fsmonitor must not block the retry loop.
git config commit.gpgsign false
git config core.fsmonitor false

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

# Drop staged zero-size files so we never publish empty blobs.
drop_zero_size_staged() {
  while IFS= read -r -d '' file; do
    if [[ -f "$file" && ! -s "$file" ]]; then
      echo "push: unstaging zero-size $file"
      git restore --staged "$file" || true
      rm -f "$file"
    fi
  done < <(git diff --cached --name-only -z)
}

# Snapshot commits include that day's manifest. Checkpoint-only commits
# (state files saved when collect is killed before writeNormalized) do not.
commit_message() {
  if git diff --cached --name-only | grep -F -q "data/normalized/${DATE}/manifest.json"; then
    echo "data: snapshot ${DATE}"
  else
    echo "data: checkpoint ${DATE}"
  fi
}

commit_if_needed() {
  git add -A
  drop_zero_size_staged
  if git diff --cached --quiet; then
    return 0
  fi
  git commit -m "$(commit_message)"
}

# A timeout can flush checkpoint writes after the first commit. Fold those
# into another commit, or stash and re-apply after rebase, before pull --rebase.
# `git pull --rebase` refuses a dirty worktree ("cannot pull with rebase: You have unstaged changes").
STASHED=0
settle_worktree() {
  local attempt
  for attempt in 1 2 3; do
    commit_if_needed
    if [[ -z "$(git status --porcelain)" ]]; then
      return 0
    fi
  done
  echo "push: stashing changes that survived commit"
  git stash push --include-untracked --message "radar-collect-retry" >/dev/null
  STASHED=1
}

reapply_stash() {
  if [[ "$STASHED" != 1 ]]; then
    return 0
  fi
  if git stash pop; then
    STASHED=0
    settle_worktree
    return 0
  fi
  echo "push: stash pop conflicted; restoring HEAD files and keeping the stash for the next attempt" >&2
  git checkout -- . >/dev/null 2>&1 || true
  git reset >/dev/null 2>&1 || true
  return 1
}

HEAD_BEFORE=$(git rev-parse HEAD)
settle_worktree
HEAD_AFTER=$(git rev-parse HEAD)
if [[ "$HEAD_BEFORE" == "$HEAD_AFTER" && "$STASHED" != 1 ]]; then
  echo "No snapshot changes"
  exit 0
fi

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
  settle_worktree
  git fetch origin "$BRANCH" --quiet || git fetch origin --quiet
  if git pull --rebase origin "$BRANCH"; then
    if reapply_stash && git push origin "HEAD:${BRANCH}"; then
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
