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

- **Base branch**: lists pull requests into this branch instead of the repository's default branch. Pull requests into other branches, such as stacked ones, stay out.

Set it in Settings → Plugins, or with `comet plugin set reviews base <branch>`. The repository is the one `gh` finds in the project's folder, from its GitHub remote.
