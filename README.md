# PR Reviews

A Comet plugin for reviewing pull requests on GitHub. In each project it is on, the sidebar lists the open, non-draft pull requests on that project's repository that request your review, into its default branch. Picking one opens its description and its diff, and an agent thread kept for it. A card links the pull request and shows its CI checks and unresolved review comments.

It only reads. The agent is told not to comment on, approve or request changes on a pull request without asking you.

## Review guide

The diff panel has a "Generate guide" button. It asks an agent to write a review guide for the pull request: its changes in a few chapters, each a short path of stops. A stop is one idea, with a note and the hunks it covers. Previous and Next step through the stops, and "Full diff" shows the whole diff again. Hunks the guide leaves out, such as lockfiles, come last.

A guide runs only when you press the button, since it runs an agent on your plan. It runs in a session no thread shows, so it adds nothing to the pull request's thread. The agent may read the project, but Comet declines any edit or command that could change it. A guide lasts until the plugins reload.

It needs Comet's plugin API 0.2.1, which carries `ctx.run`.

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
- **Guide agent**: the agent that writes review guides, `claude` or `codex`. Claude Code by default.
- **Guide model**: the guide agent's model, such as `sonnet`. Empty uses the agent's default model.

Set them in Settings → Plugins, or with `comet plugin set reviews <key> <value>`. The list reads again as soon as one changes. The repository is the one `gh` finds in the project's folder, from its GitHub remote.
