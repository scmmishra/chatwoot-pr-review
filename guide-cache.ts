import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Guide } from "./guide"

/**
 * Guides kept on disk, one per pull request at the commit it was written for, so reopening a pull request
 * at the same head commit shows its guide again without running an agent. The folder is a cache: macOS
 * may clear it, and a lost guide is written again on request.
 */

/** A guide as kept: the guide, and the diff it was written from, which its stops show. */
export interface CachedGuide {
  readonly guide: Guide
  readonly diff: string
}

export const GUIDE_FOLDER = join(homedir(), "Library", "Caches", "comet-pr-review", "guides")

/** A commit SHA as a file name. Anything else could name a path outside the folder. */
const COMMIT = /^[0-9a-f]{7,64}$/i
/** An owner or a repository's name as a folder: no slash, and not `.` or `..`, which would climb out. */
const PART = /^(?!\.{1,2}$)[\w.-]+$/

/** The folder of one pull request's guides, or undefined for a repo or commit that cannot name one. */
function folderOf(root: string, repo: string, number: number, sha: string) {
  const parts = repo.split("/")
  if (parts.length !== 2 || !parts.every((part) => PART.test(part)) || !Number.isInteger(number) || !COMMIT.test(sha)) return undefined
  return join(root, ...parts, String(number))
}

/** The guide kept for a pull request at `sha`, or undefined when none is kept or the file does not read. */
export function readGuide(repo: string, number: number, sha: string, root = GUIDE_FOLDER): CachedGuide | undefined {
  const folder = folderOf(root, repo, number, sha)
  if (!folder) return undefined
  try {
    const kept = JSON.parse(readFileSync(join(folder, `${sha}.json`), "utf8")) as Partial<CachedGuide>
    return typeof kept.diff === "string" && Array.isArray(kept.guide?.chapters) ? (kept as CachedGuide) : undefined
  } catch {
    return undefined
  }
}

/** Keeps a pull request's guide for `sha`, in place of the guides kept for its earlier commits. */
export function writeGuide(repo: string, number: number, sha: string, kept: CachedGuide, root = GUIDE_FOLDER) {
  const folder = folderOf(root, repo, number, sha)
  if (!folder) return
  mkdirSync(folder, { recursive: true })
  for (const file of readdirSync(folder)) if (file !== `${sha}.json`) rmSync(join(folder, file), { force: true })
  writeFileSync(join(folder, `${sha}.json`), JSON.stringify(kept))
}
