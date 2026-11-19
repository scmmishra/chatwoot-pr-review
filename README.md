# PR Reviews

A Comet plugin for reviewing pull requests on `chatwoot/chatwoot`. The sidebar lists open, non-draft pull requests into `develop` that request your review. Picking one opens its description and its diff, and an agent thread kept for it. A card links the pull request and shows its CI checks and unresolved review comments.

It only reads. The agent is told not to comment on, approve or request changes on a pull request without asking you.

## Needs

- The `gh` CLI on your PATH, logged in with `gh auth login`.

## Install

```sh
comet plugin add @scmmishra/chatwoot-pr-review
comet plugin on reviews           # in your Chatwoot checkout
```

Then open the "PR Reviews" setup from the palette.
