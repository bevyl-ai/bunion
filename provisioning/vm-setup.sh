#!/usr/bin/env bash
# bunion worker-VM setup — runs once on first boot (passed to `exe.dev new --setup-script`).
# Makes a fresh exe.dev VM a complete bunion worker: keyless codex, repo cloning via the
# integration proxy, and the JS toolchain the repo's checks need.
#
# Provision (from your laptop), substituting the github integration + repo as needed:
#   ssh exe.dev new --name bunion-bevyl-N --integration bevyl-web --json --setup-script /dev/stdin < provisioning/vm-setup.sh
#   ssh exe.dev integrations attach llm vm:bunion-bevyl-N
set -e

# 1. Keyless codex via the exe-llm gateway.
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model_provider = "exe-llm"

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://llm.int.exe.xyz/v1"
requires_openai_auth = false
EOF

# 2. Route github clones through the integration proxy (which carries the gh credential helper).
git config --global url."https://bevyl-web.int.exe.xyz/".insteadOf "https://github.com/"

# 2b. gh has no github.com creds on the VM — only the bevyl-web integration proxy — so point gh at it
#     so `gh pr` just works. This authors PRs as the bevyl-web app (exe-dev-github-integration[bot]),
#     which is fine: the bevyl stupify reviewer is configured to review the factory's app-authored PRs
#     (its inScope gates on the `bunion` label, and it posts COMMENT reviews — which GitHub allows even
#     app-on-its-own-PR). See stupify-octember-stupify / stupify-bevyl-ai-bevyl-ai ~/.stupify/review-sweep.ts.
grep -q 'GH_HOST=' "$HOME/.profile" 2>/dev/null || echo 'export GH_HOST=bevyl-web.int.exe.xyz' >> "$HOME/.profile"

# 3. The repo's toolchain. The base image ships codex + gh + python3 but NO bun/node, and the
#    bevyl repo is bun-based — without this the build/QA agents can't run tests/typecheck.
[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash

# 4. Env for the agents' shells. codex runs commands via `bash -lc`, which sources ~/.bash_profile
#    (NOT ~/.profile), so make ~/.bash_profile source ~/.profile and put REPO + bun there.
grep -q 'export REPO=' "$HOME/.profile" 2>/dev/null || echo 'export REPO=bevyl-ai/bevyl.ai' >> "$HOME/.profile"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
grep -q 'HOME/.profile' "$HOME/.bash_profile" 2>/dev/null || echo '[ -f "$HOME/.profile" ] && . "$HOME/.profile"' >> "$HOME/.bash_profile"

# 5. Headless chromium for QA agents — the qa skill drives Playwright to verify UI behaviour.
[ -d "$HOME/.cache/ms-playwright" ] || "$HOME/.bun/bin/bun" x playwright install chromium >/dev/null 2>&1 || echo "playwright chromium install skipped"

# 6. QA secrets, set in the env — NOT committed here:
#    - preview sign-in (authed routes): QA_USER + QA_PASS (a test account); browser.mjs login uses them.
#    - screenshot proof upload: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY; shot.mjs PUTs to the
#      bevyl-github-media S3 bucket and returns a public URL to embed in the PR.
#    printf 'export QA_USER=%s\nexport QA_PASS=%s\nexport AWS_ACCESS_KEY_ID=%s\nexport AWS_SECRET_ACCESS_KEY=%s\n' ... >> "$HOME/.profile"

echo "bunion-vm-setup done"
