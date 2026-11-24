import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGuide, writeGuide } from "./guide-cache"

const KEPT = { guide: { title: "Call b", summary: "Calls b.", chapters: [{ title: "Runtime", stops: [{ title: "Call b", note: "Calls b.", hunks: ["a.ts#h1"] }] }] }, diff: "diff --git a/a.ts b/a.ts\n" }
const OLD = "1111111111111111111111111111111111111111"
const NEW = "2222222222222222222222222222222222222222"

const PR = ["pulls", "chatwoot", "chatwoot", "42"]

test("keeps a guide for a place's version, and replaces the one kept for an earlier version", () => {
  const root = mkdtempSync(join(tmpdir(), "guides-"))
  writeGuide(PR, OLD, KEPT, root)
  expect(readGuide(PR, OLD, root)).toEqual(KEPT)
  expect(readGuide(PR, NEW, root)).toBeUndefined()
  expect(readGuide(["pulls", "chatwoot", "chatwoot", "43"], OLD, root)).toBeUndefined()

  writeGuide(PR, NEW, KEPT, root)
  expect(readdirSync(join(root, ...PR))).toEqual([`${NEW}.json`])
  expect(readGuide(PR, OLD, root)).toBeUndefined()
})

test("reads nothing from a broken file, and names no path outside the folder", () => {
  const root = mkdtempSync(join(tmpdir(), "guides-"))
  writeGuide(["o", "r", "1"], OLD, KEPT, root)
  writeFileSync(join(root, "o", "r", "1", `${OLD}.json`), "{ not json")
  expect(readGuide(["o", "r", "1"], OLD, root)).toBeUndefined()

  writeGuide(["..", "evil"], NEW, KEPT, root)
  writeGuide(["o/../../evil"], NEW, KEPT, root)
  writeGuide(["o", "r", "1"], "../../x", KEPT, root)
  expect(existsSync(join(root, "..", "evil"))).toBe(false)
  expect(readGuide(["o", ".."], NEW, root)).toBeUndefined()
  expect(readGuide([], NEW, root)).toBeUndefined()
  expect(readdirSync(root)).toEqual(["o"])
})
