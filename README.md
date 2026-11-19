# PR Reviews

A Comet plugin for reviewing pull requests on GitHub. The sidebar lists open, non-draft pull requests that request your review, on one repository and into one base branch. Picking one opens its description and its diff, and an agent thread kept for it. A card links the pull request and shows its CI checks and unresolved review comments.

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

- **Repository**: `owner/name` on GitHub. `chatwoot/chatwoot` by default.
- **Base branch**: lists pull requests into this branch, which leaves stacked ones out. `develop` by default. Empty lists every branch.

Set them in Settings → Plugins, or with `comet plugin set reviews repo owner/name`.
