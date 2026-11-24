import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hashOf, readBranch } from "./branch"

/** A repo on `feat`, one commit past `main`, with an uncommitted edit and a file git does not track. */
async function repo() {
  const dir = mkdtempSync(join(tmpdir(), "branch-"))
  const $ = Bun.$.cwd(dir)
  await $`git init -q -b main && git config user.email t@t && git config user.name t && git config color.ui always`.quiet()
  writeFileSync(join(dir, "a.txt"), "one\n")
  await $`git add a.txt && git commit -qm init && git checkout -qb feat`.quiet()
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n")
  await $`git commit -qam "Add two" -m "Two follows one."`.quiet()
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(dir, "new.txt"), "untracked\n")
  return $
}

test("reads the branch's diff against where it forked from its base, with uncommitted edits, and its messages", async () => {
  const branch = await readBranch(await repo())
  expect(branch.name).toBe("feat")
  // No remote names a default branch here, so the base is the first usual name that exists.
  expect(branch.base).toBe("main")
  expect(branch.diff).toContain("+two\n+three")
  expect(branch.diff).not.toContain("new.txt")
  // The user's colour setting does not reach the diff's text.
  expect(branch.diff).not.toContain("\u001b[")
  expect(branch.log).toBe("Add two\n\nTwo follows one.")
})

test("fails with git's own words outside a repo", async () => {
  await expect(readBranch(Bun.$.cwd(mkdtempSync(join(tmpdir(), "plain-"))))).rejects.toThrow(/not a git repository/i)
})

test("names text by a hex id the guide cache takes", () => {
  expect(hashOf("/Users/me/code/app")).toMatch(/^[0-9a-f]{40}$/)
  expect(hashOf("a")).not.toBe(hashOf("b"))
})
