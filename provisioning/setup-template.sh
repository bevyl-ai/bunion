#!/usr/bin/env bash
# Build/refresh the per-VM template that bunion's per-ticket workspaces are git-worktrees off of:
# a FULL clone + installed deps at $HOME/.bunion/repo. Run once per VM (slow: clone + bun install),
# and re-run to refresh main + deps. bun hardlinks node_modules from its global cache, so the extra
# disk is mostly the source + git history, not a second copy of node_modules.
#
#   ssh bunion-bevyl-N.exe.xyz 'bash -lc bash' < provisioning/setup-template.sh
set -e
T="$HOME/.bunion/repo"
[ -n "$REPO" ] || { echo "REPO not set in env"; exit 1; }
rm -f "$T/.template-ready" # mark not-ready while we (re)build, so the hook falls back to a clone meanwhile

if [ ! -d "$T/.git" ]; then
  mkdir -p "$T"
  git clone "https://github.com/$REPO.git" "$T" || gh repo clone "$REPO" "$T"
fi
cd "$T"
git fetch --quiet origin
git checkout -f -B main origin/main
git reset --hard --quiet origin/main
git worktree prune 2>/dev/null || true
bun install
touch "$T/.template-ready" # complete — the after_create hook will now worktree off this template
echo "template ready: $T @ $(git rev-parse --short HEAD) · history $(git log --oneline | wc -l | tr -d ' ') commits · node_modules $([ -d node_modules ] && du -sh node_modules 2>/dev/null | cut -f1 || echo MISSING)"
