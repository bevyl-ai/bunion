---
name: push
description: Keep the remote branch current and publish/update the PR for the current issue.
---

# push

Publish the working branch and ensure a PR exists for the current Linear issue. Run this after `commit`, and again after any fix during the `land` loop.

## Preconditions

- `gh` is authenticated and on PATH.
- You are on the issue's working branch with your commits made (use `commit` first).

## Procedure

1. **Validate locally first.** Run the repository's check command and make it green before pushing. Discover it in this order and use the first that applies:
   - a `BUNION_CHECK` value passed in the environment, else
   - the repo's documented check (e.g. `bun run typecheck && bun test`, `make`, `npm test`, `cargo test`).
   Never push red. If checks fail, fix, `commit`, and re-validate.
2. **Push the branch.** `git push -u origin <branch>`. On a non-fast-forward rejection, run the `pull` skill (sync `origin/main`, resolve conflicts), then push again.
3. **Ensure a PR exists.**
   - If none: `gh pr create --fill --head <branch> --base <default-branch>`. If the repo has `.github/pull_request_template.md`, base the body on it.
   - If one exists: it updates automatically on push; refresh the body if scope changed.
4. **Label it.** Ensure the PR carries the `bunion` label so factory PRs are filterable: `gh label create bunion --color BFD4F2 2>/dev/null || true`, then `gh pr edit <pr> --add-label bunion`.
5. **Attach the PR to the Linear issue** (do this via the `linear` skill / `linear_graphql`, not here) so the workpad and the issue link stay current.

## Notes

- Do all GitHub I/O through `gh` (it carries your auth); do not hand-roll tokens.
- Keep the PR title and body reviewer-oriented and specific to the change.
