import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Guide } from "./guide"

/**
 * Guides kept on disk, one per place at the version of the diff it was written for, so a panel that shows
 * the same diff again shows its guide without running an agent. A place is a list of folder names, such as
 * a pull request's owner, repository and number. A version is a hex id, such as a head commit's SHA. The
 * folder is a cache: macOS may clear it, and a lost guide is written again on request.
 */

/** A guide as kept: the guide, and the diff it was written from, which its stops show. */
export interface CachedGuide {
  readonly guide: Guide
  readonly diff: string
}

export const GUIDE_FOLDER = join(homedir(), "Library", "Caches", "comet-pr-review", "guides")

/** A version as a file name: hex only, so it names no path outside its folder. */
const VERSION = /^[0-9a-f]{7,64}$/i
/** A place's folder name: no slash, and not `.` or `..`, which would climb out. */
const PART = /^(?!\.{1,2}$)[\w.-]+$/

/** The folder of a place's guides, or undefined for a place or version that cannot name one. */
function folderOf(root: string, place: readonly string[], version: string) {
  if (!place.length || !place.every((part) => PART.test(part)) || !VERSION.test(version)) return undefined
  return join(root, ...place)
}

/** The guide kept for a place at `version`, or undefined when none is kept or the file does not read. */
export function readGuide(place: readonly string[], version: string, root = GUIDE_FOLDER): CachedGuide | undefined {
  const folder = folderOf(root, place, version)
  if (!folder) return undefined
  try {
    const kept = JSON.parse(readFileSync(join(folder, `${version}.json`), "utf8")) as Partial<CachedGuide>
    return typeof kept.diff === "string" && Array.isArray(kept.guide?.chapters) ? (kept as CachedGuide) : undefined
  } catch {
    return undefined
  }
}

/** Keeps a place's guide for `version`, in place of the guides kept for its earlier versions. */
export function writeGuide(place: readonly string[], version: string, kept: CachedGuide, root = GUIDE_FOLDER) {
  const folder = folderOf(root, place, version)
  if (!folder) return
  mkdirSync(folder, { recursive: true })
  for (const file of readdirSync(folder)) if (file.endsWith(".json") && file !== `${version}.json`) rmSync(join(folder, file), { force: true })
  writeFileSync(join(folder, `${version}.json`), JSON.stringify(kept))
}
