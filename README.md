# PR Reviews

A Comet plugin for reviewing pull requests on GitHub. In each project it is on, the sidebar lists the open, non-draft pull requests on that project's repository that request your review, into its default branch. Picking one opens its description and its diff, and an agent thread kept for it. A card links the pull request and shows its CI checks and unresolved review comments.

It only reads. The agent is told not to comment on, approve or request changes on a pull request without asking you.

## Needs

- The `gh` CLI on your PATH, logged in with `gh auth login`.

## Install

```sh
comet plugin add @scmmishra/chatwoot-pr-review
comet plugin on reviews           # in your Chatwoot checkout
```

Then open the "PR Reviews" setup from the palette.

## Settings

- **Hide drafts**: on by default.
- **Hide approved PRs**: hides pull requests that already have an approving review. Off by default. A pull request you approved leaves the list anyway, since GitHub drops your review request.
- **Only PRs into the base branch**: hides pull requests that merge into another branch, such as stacked ones. On by default.
- **Base branch**: the branch that filter keeps. Empty uses the repository's default branch.

Set them in Settings → Plugins, or with `comet plugin set reviews <key> <value>`. The list reads again as soon as one changes. The repository is the one `gh` finds in the project's folder, from its GitHub remote.
