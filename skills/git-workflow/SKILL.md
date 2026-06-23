---
name: git-workflow
version: 1.0.0
description: Git workflow helper — create branches, write conventional commits, rebase cleanly, resolve merge conflicts, and craft PR descriptions
riskClass: low
publisher: Axiom
---

# Git Workflow Skill

## Overview
This skill provides a disciplined Git workflow for feature development, code review, and release management. It covers branch naming, conventional commit messages, clean rebasing, systematic merge conflict resolution, and crafting high-quality pull request descriptions. The goal is a clean, bisectable Git history that tells the story of the project.

## When to Use
- Starting a new feature, bugfix, or refactor
- Preparing a pull request for review
- Cleaning up a messy branch before merging
- Resolving merge conflicts from an upstream change
- Writing a PR description that reviewers will appreciate
- Squashing fixup commits into a coherent history

## Step-by-Step Instructions

### Phase 1: Branch Creation
1. **Update main.** `git checkout main && git pull --rebase`. Always branch from an up-to-date main.
2. **Create a descriptive branch.** Use the format `<type>/<short-description>`: `feat/add-user-auth`, `fix/null-pointer-in-orders`, `refactor/extract-validation`, `docs/api-readme`, `chore/update-deps`.
3. **Keep branch names short but meaningful.** 3-5 words is ideal. Use kebab-case, lowercase. Avoid ticket numbers only — they're meaningless without context.

### Phase 2: Committing
4. **Stage changes atomically.** Stage only related changes per commit. Use `git add -p` for partial staging if multiple concerns got mixed.
5. **Write conventional commit messages.** Format: `<type>(<scope>): <description>`. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `style`. Scope: the module or component (optional). Description: imperative mood, lowercase, no period at end, under 72 characters.
6. **Add a body for non-trivial commits.** After the subject line, leave a blank line, then explain WHAT changed and WHY. The WHAT is often obvious from the diff; the WHY is the valuable part.
7. **Reference issues.** `Fixes #123` or `Refs #456` in the commit body. GitHub/GitLab link these automatically.

### Phase 3: Keeping Up with Main (Rebasing)
8. **Fetch and rebase regularly.** `git fetch origin && git rebase origin/main`. Rebase daily to avoid large merge conflicts.
9. **Handle rebase conflicts one commit at a time.** When `git rebase` pauses, resolve the conflict in the file, `git add` the resolved file, and `git rebase --continue`. If you get lost, `git rebase --abort` to go back.
10. **Use interactive rebase to clean up.** `git rebase -i origin/main`. Squash fixup commits (`fixup` or `squash`), reword unclear messages (`reword`), reorder logically, and drop debugging commits.

### Phase 4: Merge Conflict Resolution
11. **Understand both sides.** Read the conflict markers carefully. `<<<<<<< HEAD` is your change, `=======` separates, and `>>>>>>> branch-name` is the incoming change. Never blindly accept one side.
12. **Determine intent.** Why did both branches touch the same lines? Is one change a refactor and the other a feature? Understand before resolving.
13. **Resolve manually.** Edit the file to combine both changes correctly. Remove all conflict markers. Sometimes the right resolution is a blend; sometimes one side is obsolete.
14. **Verify the resolution.** `git diff --check` for leftover markers. Run the test suite. Compile/build to ensure syntax is valid.
15. **Use a merge tool for complex conflicts.** `git mergetool` with VS Code, IntelliJ, or Beyond Compare. Visual three-way merges reduce errors significantly.

### Phase 5: Pull Request Creation
16. **Push the branch.** `git push -u origin feat/my-feature`. If you've rebased, you may need `--force-with-lease` (never `--force` alone).
17. **Craft the PR description.** Template:
    - **Summary:** 1-2 sentences on what this does
    - **Motivation:** Why is this needed? Link the issue.
    - **Changes:** Bullet list of key changes, grouped by file/module
    - **Testing:** How was this tested? What test cases were added?
    - **Screenshots:** Before/after for UI changes
    - **Checklist:** Self-review done, tests pass, docs updated
18. **Self-review before requesting review.** Read the PR diff as if you were the reviewer. Catch your own typos, debug logs, and commented-out code before someone else does.
19. **Mark as draft if incomplete.** Use GitHub draft PRs for work-in-progress. Open for review only when truly ready.

### Phase 6: Post-Merge
20. **Delete the remote branch.** Most PR platforms offer a button. If not: `git push origin --delete feat/my-feature`.
21. **Delete the local branch.** `git branch -d feat/my-feature`.
22. **Update main.** `git checkout main && git pull`.

## Common Pitfalls
- **Force-pushing to shared branches.** `--force` rewrites history that others may have based work on. Use `--force-with-lease` only on your own branches.
- **Merging main into feature branches.** This creates spaghetti history. Always rebase feature branches onto main instead.
- **Giant commits.** A single commit that adds a feature, refactors three modules, and fixes two bugs is unreviewable and un-revertable. Commit often, commit small.
- **Meaningless commit messages.** "fix", "update", "wip", "asdf". These are worthless when bisecting or reading history. Every commit should answer "what and why".
- **Not squashing fixup commits before merge.** `fix typo`, `actually fix typo`, `fix the fix`. These pollute main's history. Squash them into the original commit.

## Verification Checklist
- [ ] Branch created from up-to-date main
- [ ] Branch name follows `<type>/<short-description>` convention
- [ ] Commits are atomic and use conventional commit format
- [ ] Commit messages include WHY in the body for non-trivial changes
- [ ] Branch rebased onto latest main (no merge commits from main)
- [ ] Merge conflicts resolved correctly, all markers removed
- [ ] Test suite passes after conflict resolution
- [ ] `git push --force-with-lease` used instead of `--force`
- [ ] PR description includes summary, motivation, changes, testing, and checklist
- [ ] PR self-reviewed (diff read in full)
- [ ] Fixup commits squashed via interactive rebase
- [ ] Remote and local branches cleaned up after merge
