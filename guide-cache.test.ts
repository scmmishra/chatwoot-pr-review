import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGuide, writeGuide } from "./guide-cache"

const KEPT = { guide: { title: "Call b", summary: "Calls b.", chapters: [{ title: "Runtime", stops: [{ title: "Call b", note: "Calls b.", hunks: ["a.ts#h1"] }] }] }, diff: "diff --git a/a.ts b/a.ts\n" }
const OLD = "1111111111111111111111111111111111111111"
const NEW = "2222222222222222222222222222222222222222"

test("keeps a guide for a pull request's head commit, and replaces the one kept for an earlier commit", () => {
  const root = mkdtempSync(join(tmpdir(), "guides-"))
  writeGuide("chatwoot/chatwoot", 42, OLD, KEPT, root)
  expect(readGuide("chatwoot/chatwoot", 42, OLD, root)).toEqual(KEPT)
  expect(readGuide("chatwoot/chatwoot", 42, NEW, root)).toBeUndefined()
  expect(readGuide("chatwoot/chatwoot", 43, OLD, root)).toBeUndefined()

  writeGuide("chatwoot/chatwoot", 42, NEW, KEPT, root)
  expect(readdirSync(join(root, "chatwoot", "chatwoot", "42"))).toEqual([`${NEW}.json`])
  expect(readGuide("chatwoot/chatwoot", 42, OLD, root)).toBeUndefined()
})

test("reads nothing from a broken file, and names no path outside the folder", () => {
  const root = mkdtempSync(join(tmpdir(), "guides-"))
  writeGuide("o/r", 1, OLD, KEPT, root)
  writeFileSync(join(root, "o", "r", "1", `${OLD}.json`), "{ not json")
  expect(readGuide("o/r", 1, OLD, root)).toBeUndefined()

  writeGuide("../evil", 1, NEW, KEPT, root)
  writeGuide("o/r", 1, "../../x", KEPT, root)
  expect(existsSync(join(root, "..", "evil"))).toBe(false)
  expect(readGuide("o/..", 1, NEW, root)).toBeUndefined()
  expect(readdirSync(root)).toEqual(["o"])
})
