#!/usr/bin/env bash
# bunion worker-VM setup — runs once on first boot (passed to `exe.dev new --setup-script`).
# Makes a fresh exe.dev VM a complete bunion worker: keyless codex, repo cloning via the
# integration proxy, and the JS toolchain the repo's checks need.
#
# Provision (from your laptop), substituting the github integration + repo as needed:
#   ssh exe.dev new --name bunion-bevyl-N --integration bevyl-web --json --setup-script /dev/stdin < provisioning/vm-setup.sh
#   ssh exe.dev integrations attach llm vm:bunion-bevyl-N
set -e

# 1. Keyless codex via the exe-llm gateway. High reasoning effort: tokens are ~free on the flat plan, so the only
#    cost is slower turns — worth it for first-pass quality (a rework loop wastes far more than reasoning tokens).
#    (Later: tune effort per stage — e.g. high for build/verify, medium for plan/qa.)
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model_provider = "exe-llm"
model_reasoning_effort = "high"

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://llm.int.exe.xyz/v1"
requires_openai_auth = false
EOF

# 2. Route github clones through the integration proxy (which carries the gh credential helper).
git config --global url."https://bevyl-web.int.exe.xyz/".insteadOf "https://github.com/"

# 2b. git clone/push ride the bevyl-web integration proxy (step 2's insteadOf) — the VM holds no github.com creds.
#     PR AUTHOR + commit author: with a factory GitHub App configured (BEVYL_FACTORY_BOT_NAME set in the provisioning
#     env), author commits as the bot and point `gh` at github.com so it uses the per-session GH_TOKEN the brain
#     injects (codex/app-server + wait-tool) → PRs open as bevyl-dark-factory[bot]. Without the app, fall back to the
#     old behavior: no git author override, and GH_HOST=proxy so `gh` authors PRs as exe-dev-github-integration[bot].
#     (stupify reviews the factory's app-authored PRs either way — its inScope gates on the `bunion` label.)
# BEV re-audit: ~/.profile ends up holding real secrets (QA_PASS, the scoped AWS key, ELEVENLABS_API_KEY, etc. —
# see step 6/7 below) but nothing ever set its mode, so it inherited whatever umask happened to be in effect —
# 600 on some VMs, world-readable 644 on others. Force it closed BEFORE the first secret-bearing line is ever
# appended, and again at the end (idempotent either way) so re-running this script also repairs a drifted VM.
touch "$HOME/.profile" && chmod 600 "$HOME/.profile"
if [ -n "${BEVYL_FACTORY_BOT_NAME:-}" ]; then
  git config --global user.name "$BEVYL_FACTORY_BOT_NAME"
  git config --global user.email "${BEVYL_FACTORY_BOT_EMAIL:-}"
  # gh must hit github.com (not the proxy) to use the injected GH_TOKEN — strip any prior GH_HOST=proxy line (idempotent).
  sed -i '/export GH_HOST=/d' "$HOME/.profile" 2>/dev/null || true
else
  grep -q 'GH_HOST=' "$HOME/.profile" 2>/dev/null || echo 'export GH_HOST=bevyl-web.int.exe.xyz' >> "$HOME/.profile"
fi

# 3. The repo's toolchain. The base image ships codex + gh + python3 but NO bun/node, and the
#    bevyl repo is bun-based — without this the build/QA agents can't run tests/typecheck.
[ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash

# 4. Env for the agents' shells. codex runs commands via `bash -lc`, which sources ~/.bash_profile
#    (NOT ~/.profile), so make ~/.bash_profile source ~/.profile and put REPO + bun there.
grep -q 'export REPO=' "$HOME/.profile" 2>/dev/null || echo 'export REPO=bevyl-ai/bevyl.ai' >> "$HOME/.profile"
# Per-ticket repo: the after_create hook writes the ticket's repo to .bunion-repo in the workspace; override $REPO from it
# so multi-repo works (the line above is just the default/fallback). Idempotent.
grep -q 'bunion-repo' "$HOME/.profile" 2>/dev/null || echo '[ -r "$PWD/.bunion-repo" ] && export REPO="$(cat "$PWD/.bunion-repo" 2>/dev/null || echo bevyl-ai/bevyl.ai)"' >> "$HOME/.profile"
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
grep -q 'HOME/.profile' "$HOME/.bash_profile" 2>/dev/null || echo '[ -f "$HOME/.profile" ] && . "$HOME/.profile"' >> "$HOME/.bash_profile"

# 5. Headless chromium for QA agents — the qa skill drives Playwright to verify UI behaviour.
[ -d "$HOME/.cache/ms-playwright" ] || "$HOME/.bun/bin/bun" x playwright install chromium >/dev/null 2>&1 || echo "playwright chromium install skipped"

# 6. QA secrets, set in the env — NOT committed here:
#    - preview sign-in (authed routes): QA_USER + QA_PASS (a test account); browser.mjs login uses them.
#    - screenshot proof upload: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY; shot.mjs PUTs to the
#      bevyl-github-media S3 bucket (under qa-screenshots/ only) and returns a public URL to embed in the PR.
#      BEV audit: workers used to share the brain's general-purpose AWS key (full account-wide scope) for this
#      single PutObject call. Use a DEDICATED, narrowly-scoped credential instead — IAM user
#      `bunion-qa-screenshot-uploader`, inline policy `qa-screenshot-put-only` grants ONLY
#      s3:PutObject on arn:aws:s3:::bevyl-github-media/qa-screenshots/* (no delete, no other prefix, no other
#      bucket/service) — so a compromised/leaked worker can do nothing with it beyond writing QA screenshots.
#    printf 'export QA_USER=%s\nexport QA_PASS=%s\nexport AWS_ACCESS_KEY_ID=%s\nexport AWS_SECRET_ACCESS_KEY=%s\n' ... >> "$HOME/.profile"

# 7. Worker credentials, injected from the provisioning env when present (idempotent). Without a needed key, such
#    tickets correctly dead-end on "Needs human: provide <KEY>". PostHog read key/project = production HogQL
#    validation (BEV-3942); ELEVENLABS_API_KEY = live voiceover verification (BEV-3975).
#    NOTE: high-privilege prod secrets (e.g. SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS) are deliberately NOT
#    injected here — they would hand unattended agents prod-DB god-mode. Add one only with explicit operator sign-off.
for k in POSTHOG_PERSONAL_API_KEY POSTHOG_PROJECT_ID POSTHOG_API_HOST NEXT_PUBLIC_POSTHOG_HOST ELEVENLABS_API_KEY; do
  v="${!k:-}"
  if [ -n "$v" ] && ! grep -q "^export $k=" "$HOME/.profile" 2>/dev/null; then
    printf 'export %s=%s\n' "$k" "$v" >> "$HOME/.profile"
  fi
done

# Re-tighten in case anything along the way (a `>>` to a non-existent file, etc.) left it loose — idempotent, so
# re-running this script on an already-provisioned VM also repairs a drifted one.
chmod 600 "$HOME/.profile" 2>/dev/null || true

echo "bunion-vm-setup done"
