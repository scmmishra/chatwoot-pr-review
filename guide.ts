/**
 * A review guide for a pull request, after Linear's PR guides and Codiff's walkthroughs: a short path
 * through the change, in chapters and stops. Each stop is one review idea, with a note and the hunks it
 * covers. An agent writes the guide from the diff, and names each hunk by an id this module gives it. The
 * guide does not copy the diff: each stop shows the real hunks its ids name.
 */

/** One hunk of a diff: the file header it sits under, and its own lines from its `@@` line on. */
export interface Hunk {
  /** `<path>#h<n>`, the hunk's place in its file, counting from 1. */
  readonly id: string
  readonly path: string
  readonly header: string
  readonly body: string
}

export interface GuideStop {
  readonly title: string
  readonly note: string
  readonly hunks: readonly string[]
}

export interface GuideChapter {
  readonly title: string
  readonly stops: readonly GuideStop[]
}

export interface Guide {
  readonly title: string
  readonly summary: string
  readonly chapters: readonly GuideChapter[]
}

/**
 * Past this many hunks the schema names hunks as plain strings, not as a list of the real ids. Codex's
 * strict schemas cap how many values a schema may list, and `settle` drops an id the diff lacks anyway.
 */
const MAX_ENUM_HUNKS = 400
/** The chapter that holds every hunk the agent left out, such as lockfiles and generated files. */
const OTHER_CHAPTER = "Other"

/** The path a file's diff header names: its new path, else the old one for a deleted file. */
function pathOf(header: string): string {
  const added = header.match(/^\+\+\+ b\/(.+)$/m)?.[1]
  if (added) return added
  const removed = header.match(/^--- a\/(.+)$/m)?.[1]
  if (removed) return removed
  return header.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1] ?? "unknown"
}

/**
 * The hunks of a unified diff, as `git diff` and `gh pr diff` write it. A file with no `@@` lines, such as
 * a binary file or a pure rename, is one hunk of its header alone.
 */
export function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const file of patch.split(/^(?=diff --git )/m)) {
    if (!file.startsWith("diff --git ")) continue
    const at = file.search(/^@@ /m)
    const header = at === -1 ? file : file.slice(0, at)
    const path = pathOf(header)
    const bodies = at === -1 ? [""] : file.slice(at).split(/^(?=@@ )/m)
    bodies.forEach((body, index) => hunks.push({ id: `${path}#h${index + 1}`, path, header, body }))
  }
  return hunks
}

/**
 * A diff of the hunks `ids` name, in that order. Hunks of one file in a row share its header while they
 * go down the file. A hunk above the one before it starts the file again, since a diff's hunks of one
 * file must run in order.
 */
export function patchOf(hunks: readonly Hunk[], ids: readonly string[]): string {
  const at = new Map(hunks.map((hunk, index) => [hunk.id, index]))
  let patch = ""
  let last: number | undefined
  for (const id of ids) {
    const index = at.get(id)
    if (index === undefined) continue
    const hunk = hunks[index]!
    const continues = last !== undefined && hunks[last]!.path === hunk.path && last < index
    if (!continues) patch += ensureNewline(hunk.header)
    last = index
    patch += ensureNewline(hunk.body)
  }
  return patch
}

const ensureNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`)

/** The JSON schema of a guide, strict enough for Codex. With few hunks, a stop can name only real ones. */
export function guideSchema(hunks: readonly Hunk[]): Record<string, unknown> {
  const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties })
  const text = { type: "string" }
  const hunkId = hunks.length <= MAX_ENUM_HUNKS ? { type: "string", enum: hunks.map((hunk) => hunk.id) } : text
  const stop = object({ title: text, note: text, hunks: { type: "array", items: hunkId } })
  const chapter = object({ title: text, stops: { type: "array", items: stop } })
  return object({ title: text, summary: text, chapters: { type: "array", items: chapter } })
}

/**
 * What a guide is about, as the agent reads it. `name` says what changes, such as `pull request o/r#7`.
 * `intent` is what its author says it does, such as a description or the commit messages.
 */
export interface About {
  readonly name: string
  readonly title: string
  readonly intent: string
}

/** What the agent is told about the change, and how to write its guide. */
export function guidePrompt(about: About, hunks: readonly Hunk[]): string {
  let annotated = ""
  let file: string | undefined
  for (const hunk of hunks) {
    if (hunk.path !== file) annotated += ensureNewline(hunk.header)
    file = hunk.path
    annotated += `[hunk ${hunk.id}]\n${ensureNewline(hunk.body)}`
  }
  return `Write a review guide for ${about.name}, "${about.title}". A guide is a short path through the change for a reviewer.

How to write it:
- Group the hunks into 1 to 6 chapters, by idea, not by file. Give each chapter a title of one or two words, such as "Runtime", "UI" or "Tests".
- Each chapter has stops. A stop is one review idea. Give it a title of 2 to 6 words that says what it does. Never use a file name as a title.
- Use as few stops as work. A small change needs 1 to 3. Never write more than 14.
- A stop lists the ids of the hunks it covers, in the order to read them. It may take hunks from several files. Each hunk goes in one stop at most.
- Order the chapters and stops by what a reviewer should read first: the core change, then what builds on it, then tests, then docs.
- Leave out lockfiles, generated files, snapshots and mechanical edits. The guide lists them on its own.
- A stop's note says what it changes and why, in 1 to 3 short sentences of plain text. It is not Markdown, so use no backticks, headings or lists.
- Do not invent bugs, risks or tests. Say only what the diff shows.
- The summary says what the change does, in one or two sentences.
- Read what the author says as their intent. The diff is what counts. The files in this folder may be at another commit than the diff.

What the author says:

${about.intent.trim() || "(nothing)"}

The diff. Each hunk starts with a line [hunk <id>]:

${annotated}`
}

/**
 * The guide as the panel shows it, from the agent's reply. It drops ids the diff lacks, a hunk named a
 * second time, and stops and chapters left empty. Hunks the agent left out go in one last chapter, so the
 * guide covers the whole diff.
 */
export function settle(reply: Guide, hunks: readonly Hunk[]): Guide {
  const known = new Set(hunks.map((hunk) => hunk.id))
  const used = new Set<string>()
  const take = (id: string) => {
    if (!known.has(id) || used.has(id)) return false
    used.add(id)
    return true
  }
  const chapters = reply.chapters
    .map((chapter) => ({ title: chapter.title, stops: chapter.stops.map((stop) => ({ ...stop, hunks: stop.hunks.filter(take) })).filter((stop) => stop.hunks.length > 0) }))
    .filter((chapter) => chapter.stops.length > 0)
  const rest = hunks.filter((hunk) => !used.has(hunk.id)).map((hunk) => hunk.id)
  if (rest.length) chapters.push({ title: OTHER_CHAPTER, stops: [{ title: "The rest of the diff", note: "Hunks the guide leaves out, such as lockfiles, generated files and mechanical edits.", hunks: rest }] })
  return { title: reply.title, summary: reply.summary, chapters }
}

/** Every stop of a guide in reading order, with the title of its chapter. */
export const stopsOf = (guide: Guide) => guide.chapters.flatMap((chapter) => chapter.stops.map((stop) => ({ ...stop, chapter: chapter.title })))
