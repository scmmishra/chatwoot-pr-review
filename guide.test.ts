import { expect, test } from "bun:test"
import { guidePrompt, guideSchema, hunksOf, patchOf, settle, stopsOf } from "./guide"

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import { a } from "./a"
+import { b } from "./b"

 a()
@@ -10,2 +11,3 @@ function run() {
   a()
+  b()
 }
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const old = 1
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
`

test("splits a diff into hunks named by file and place, with a file that has none as one hunk", () => {
  const hunks = hunksOf(DIFF)
  expect(hunks.map((hunk) => hunk.id)).toEqual(["src/app.ts#h1", "src/app.ts#h2", "src/old.ts#h1", "logo.png#h1"])
  expect(hunks[1]!.body).toStartWith("@@ -10,2 +11,3 @@ function run() {")
  expect(hunks[3]!.header).toContain("Binary files a/logo.png and b/logo.png differ")
  expect(hunksOf("")).toEqual([])
})

test("makes a diff of the hunks a stop names, in its order, with a file's header again when its hunks go back up", () => {
  const hunks = hunksOf(DIFF)
  expect(patchOf(hunks, ["src/app.ts#h1", "src/app.ts#h2"]).match(/^diff --git /gm)).toHaveLength(1)
  expect(patchOf(hunks, ["src/app.ts#h2", "src/app.ts#h1"]).match(/^diff --git /gm)).toHaveLength(2)
  const patch = patchOf(hunks, ["src/app.ts#h2", "src/old.ts#h1", "src/app.ts#h1", "missing#h1"])
  expect(patch.match(/^diff --git a\/src\/app\.ts/gm)).toHaveLength(2)
  expect(patch.indexOf("+  b()")).toBeLessThan(patch.indexOf("-export const old = 1"))
  expect(patch.indexOf("-export const old = 1")).toBeLessThan(patch.indexOf('+import { b } from "./b"'))
  expect(hunksOf(patch).map((hunk) => hunk.path)).toEqual(["src/app.ts", "src/old.ts", "src/app.ts"])
})

test("a schema that Codex's strict rules take, naming only the diff's hunks", () => {
  const schema = guideSchema(hunksOf(DIFF)) as any
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual(["title", "summary", "chapters"])
  const stop = schema.properties.chapters.items.properties.stops.items
  expect(stop.required).toEqual(["title", "note", "hunks"])
  expect(stop.properties.hunks.items.enum).toEqual(["src/app.ts#h1", "src/app.ts#h2", "src/old.ts#h1", "logo.png#h1"])
})

test("the prompt names the change and its intent, and marks each hunk with its id", () => {
  const prompt = guidePrompt({ name: "pull request chatwoot/chatwoot#42", title: "Add b", intent: "Adds b." }, hunksOf(DIFF))
  expect(prompt).toContain('pull request chatwoot/chatwoot#42, "Add b"')
  expect(prompt).toContain("Adds b.")
  expect(prompt).toContain("[hunk src/app.ts#h2]\n@@ -10,2 +11,3 @@")
})

test("keeps each hunk once, drops ids the diff lacks and empty stops, and puts the rest last", () => {
  const guide = settle(
    {
      title: "Add b",
      summary: "Calls b after a.",
      chapters: [
        { title: "Runtime", stops: [{ title: "Call b", note: "Calls `b`.", hunks: ["src/app.ts#h2", "src/app.ts#h1", "made-up#h1"] }] },
        { title: "Cleanup", stops: [{ title: "Again", note: "", hunks: ["src/app.ts#h1"] }] },
      ],
    },
    hunksOf(DIFF),
  )
  expect(guide.chapters.map((chapter) => chapter.title)).toEqual(["Runtime", "Other"])
  expect(stopsOf(guide).map((stop) => [stop.chapter, stop.title, stop.hunks])).toEqual([
    ["Runtime", "Call b", ["src/app.ts#h2", "src/app.ts#h1"]],
    ["Other", "The rest of the diff", ["src/old.ts#h1", "logo.png#h1"]],
  ])
})
