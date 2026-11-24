import { createHash } from "node:crypto"

/**
 * The branch a project has checked out, as its guide reads it: its diff against the commit it forked from
 * its base branch, with the uncommitted changes to tracked files, and its commit messages, which say what
 * its author meant. Files git does not track yet are not in the diff.
 */
export interface Branch {
  readonly name: string
  /** The base branch, such as `origin/main`. */
  readonly base: string
  readonly diff: string
  /** The branch's commit messages, oldest last, as `git log` lists them. */
  readonly log: string
}

/** The base branches tried, in order, when the remote names no default branch. */
const FALLBACK_BASES = ["origin/main", "origin/master", "main", "master"]

/** A hex id for text, such as a folder or a diff, that names it in the guide cache. */
export const hashOf = (text: string) => createHash("sha1").update(text).digest("hex")

/** Reads the project's branch with git, in the folder `$` runs in. A failure carries git's own error. */
export async function readBranch($: typeof Bun.$): Promise<Branch> {
  const git = async (args: readonly string[]) => {
    try {
      return (await $`git ${args}`.quiet()).text()
    } catch (error) {
      const stderr = error instanceof Bun.$.ShellError ? error.stderr.toString().trim() : ""
      throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
    }
  }
  const exists = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false)
  const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  // The remote's default branch, else the first of the usual names that exists.
  const remoteDefault = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).then((ref) => ref.trim(), () => "")
  let base = remoteDefault
  for (const candidate of FALLBACK_BASES) if (!base && (await exists(candidate))) base = candidate
  if (!base) throw new Error("Comet found no base branch to compare with: no origin/HEAD, main or master.")
  const forkedAt = (await git(["merge-base", "HEAD", base])).trim()
  // Colour and external diff tools would change the diff's text, so the guide could not read its hunks.
  const diff = await git(["-c", "color.ui=false", "diff", "--no-ext-diff", forkedAt])
  const log = (await git(["log", "--format=%s%n%n%b", `${forkedAt}..HEAD`])).trim()
  return { name, base, diff, log }
}
