import { Button, Diff, Stack, Text, type AgentId, type Comet, type TabContext } from "@comet/plugin"
import { createEffect, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { guidePrompt, guideSchema, hunksOf, patchOf, settle, stopsOf, type About, type Guide } from "./guide"
import { readGuide, writeGuide } from "./guide-cache"

/**
 * The review guide of a diff, as a panel shows it: a button that writes one, then the guide one stop at a
 * time, or the whole diff. A pull request's diff panel and the branch panel both show their diff this way.
 *
 * A guide runs only when the user asks, since it runs an agent on their plan. It runs on the agent and model
 * the settings name, in a session no thread shows. It is kept on disk for the version of the diff it was
 * written for, so the panel shows it again without a run until that diff changes.
 */

/** The agent a guide runs on when the setting is unset. */
const GUIDE_AGENT: AgentId = "claude"

/** A diff a guide can be written for. */
export interface Subject {
  /** One per diff a panel shows, such as a pull request or a project's branch. */
  readonly key: string
  /** The diff as last read, or undefined before the first read. */
  readonly diff: string | undefined
  /** The folders its guides are kept in. */
  readonly place: readonly string[]
  /** The version of the diff a guide is kept for, such as a head commit. Undefined until it is known. */
  readonly version: string | undefined
  /** What the agent is told it reviews. It is read when the user asks for a guide. */
  readonly about: () => Promise<About>
}

/** A subject's guide: the diff it was written from and its version, the stop on show, and what the panel shows. */
interface GuideState {
  guide?: Guide
  diff?: string
  version?: string
  at: number
  showing: "guide" | "diff"
  generating: boolean
  error?: string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The guides of every subject, shared by every tab, and the view that shows one subject's. */
export function createGuides(comet: Comet) {
  const [guides, setGuides] = createStore<Record<string, GuideState>>({})
  /** The guides being written, by subject, so Cancel can stop one. */
  const writing = new Map<string, AbortController>()

  /** Writes a guide for the subject's diff, on the agent and model the settings name, and keeps it. */
  const generate = async (ctx: TabContext, subject: Subject) => {
    const { key, diff, version } = subject
    if (diff === undefined || writing.has(key)) return
    const hunks = hunksOf(diff)
    if (!hunks.length) return setGuides(key, { at: 0, showing: "diff", generating: false, error: "There are no changes to guide." })
    const controller = new AbortController()
    writing.set(key, controller)
    setGuides(key, { at: guides[key]?.at ?? 0, showing: guides[key]?.showing ?? "diff", generating: true, error: undefined })
    try {
      const agent = (String(comet.settings.get("guideAgent") ?? "").trim() || GUIDE_AGENT) as AgentId
      const model = String(comet.settings.get("guideModel") ?? "").trim()
      const prompt = guidePrompt(await subject.about(), hunks)
      const reply = await ctx.run<Guide>(prompt, { agent, ...(model ? { model } : {}), schema: guideSchema(hunks), signal: controller.signal })
      const guide = settle(reply, hunks)
      setGuides(key, { guide, diff, version, at: 0, showing: "guide" })
      // The panel shows the guide either way, so a guide that cannot be kept only costs a later run.
      if (version) {
        try {
          writeGuide(subject.place, version, { guide, diff })
        } catch (error) {
          ctx.toast(`Comet could not keep the guide for later: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      setGuides(key, "error", messageOf(error))
    } finally {
      setGuides(key, "generating", false)
      writing.delete(key)
    }
  }

  /** The guide controls and the guide, or the whole diff, for the subject a panel shows. */
  const view = (ctx: TabContext, subject: () => Subject): JSX.Element => {
    const key = () => subject().key
    const state = () => guides[key()]
    // A guide kept for this version of the diff shows without a run. A guide for an earlier version stays
    // until the user writes a new one, with a note that the diff changed.
    createEffect(() => {
      const { key, place, version } = subject()
      if (!version || untrack(() => guides[key]?.version === version || guides[key]?.generating)) return
      const kept = readGuide(place, version)
      if (kept) setGuides(key, { guide: kept.guide, diff: kept.diff, version, at: 0, showing: "guide", generating: false, error: undefined })
    })
    const shownGuide = () => (state()?.showing === "guide" ? state()?.guide : undefined)
    const show = (showing: "guide" | "diff") => setGuides(key(), "showing", showing)
    const write = () => void generate(ctx, subject())
    return (
      <>
        <Stack direction="row">
          <Show when={state()?.guide} fallback={<Button label={state()?.generating ? "Writing the guide…" : "Generate guide"} disabled={state()?.generating} onClick={write} />}>
            <Button label="Guide" variant={state()?.showing === "guide" ? "primary" : "ghost"} onClick={() => show("guide")} />
            <Button label="Full diff" variant={state()?.showing === "diff" ? "primary" : "ghost"} onClick={() => show("diff")} />
            <Button label={state()?.generating ? "Writing the guide…" : "Generate again"} variant="ghost" disabled={state()?.generating} onClick={write} />
          </Show>
          <Show when={state()?.generating}>
            <Button label="Cancel" variant="ghost" onClick={() => writing.get(key())?.abort()} />
          </Show>
        </Stack>
        <Show when={state()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
        <Show when={shownGuide()} fallback={<Diff patch={subject().diff ?? ""} />}>
          {(guide) => {
            const stops = () => stopsOf(guide())
            const at = () => Math.min(state()?.at ?? 0, stops().length - 1)
            const stop = () => stops()[at()]!
            const hunks = () => hunksOf(state()?.diff ?? "")
            const step = (by: number) => setGuides(key(), "at", at() + by)
            return (
              <>
                <Stack gap={0}>
                  <Text tone="strong">{guide().title}</Text>
                  <Text tone="muted">{guide().summary}</Text>
                  <Show when={state()?.diff !== subject().diff}>
                    <Text tone="muted">The diff changed since this guide was written. It shows the diff it was written from.</Text>
                  </Show>
                </Stack>
                <Stack direction="row">
                  <Button label="Previous" variant="ghost" disabled={at() === 0} onClick={() => step(-1)} />
                  <Text tone="muted">
                    {stop().chapter} · {at() + 1} of {stops().length}
                  </Text>
                  <Button label="Next" variant="ghost" disabled={at() === stops().length - 1} onClick={() => step(1)} />
                </Stack>
                {/* A note is plain text: Markdown is a scroll view, and it draws nothing in a stack that does not grow. */}
                <Stack gap={0}>
                  <Text tone="strong">{stop().title}</Text>
                  <Text>{stop().note}</Text>
                </Stack>
                <Diff patch={patchOf(hunks(), stop().hunks)} />
              </>
            )
          }}
        </Show>
      </>
    )
  }

  return { view }
}
