import { Button, Diff, Stack, Text, type AgentId, type Comet, type DiffSection, type TabContext } from "@comet/plugin"
import { createEffect, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { guidePrompt, guideSchema, hunksOf, patchOf, settle, stopsOf, type About, type Guide } from "./guide"
import { readGuide, writeGuide } from "./guide-cache"

/**
 * A review guide, as its tab shows it: one page, with each stop as a section of the diff, under its
 * chapter, title and note. Before a guide exists, the tab offers to write one. A pull request's guide
 * tab and the Branch guide tab both show their guide this way.
 *
 * A guide runs only when the user asks, since it runs an agent on their plan. It runs on the agent and model
 * the settings name, in a session no thread shows. It is kept on disk for the version of the diff it was
 * written for, so the tab shows it again without a run until that diff changes.
 */

/** The agent a guide runs on when the setting is unset. */
const GUIDE_AGENT: AgentId = "claude"
/** Each agent by the name the user knows it by. */
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" }

/** A diff a guide can be written for. */
export interface Subject {
  /** One per diff a tab guides, such as a pull request or a project's branch. */
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

/** A subject's guide, with the diff it was written from and that diff's version, and whether one is being written. */
interface GuideState {
  guide?: Guide
  diff?: string
  version?: string
  generating: boolean
  error?: string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The guide's stops as sections of one diff, each with its chapter and place as its label. */
function sectionsOf(guide: Guide, diff: string): DiffSection[] {
  const hunks = hunksOf(diff)
  const stops = stopsOf(guide)
  return stops.map((stop, index) => ({ label: `${stop.chapter} · ${index + 1} of ${stops.length}`, title: stop.title, note: stop.note, patch: patchOf(hunks, stop.hunks) }))
}

/** The guides of every subject, shared by every tab, and the view that shows one subject's. */
export function createGuides(comet: Comet) {
  const [guides, setGuides] = createStore<Record<string, GuideState>>({})
  /** The guides being written, by subject, so Cancel can stop one. */
  const writing = new Map<string, AbortController>()
  const agent = () => (String(comet.settings.get("guideAgent") ?? "").trim() || GUIDE_AGENT) as AgentId
  const model = () => String(comet.settings.get("guideModel") ?? "").trim()

  /** Writes a guide for the subject's diff, on the agent and model the settings name, and keeps it. */
  const generate = async (ctx: TabContext, subject: Subject) => {
    const { key, diff, version } = subject
    if (diff === undefined || writing.has(key)) return
    const hunks = hunksOf(diff)
    if (!hunks.length) return setGuides(key, { generating: false, error: "There are no changes to guide." })
    const controller = new AbortController()
    writing.set(key, controller)
    setGuides(key, { generating: true, error: undefined })
    try {
      const prompt = guidePrompt(await subject.about(), hunks)
      const reply = await ctx.run<Guide>(prompt, { agent: agent(), ...(model() ? { model: model() } : {}), schema: guideSchema(hunks), signal: controller.signal })
      const guide = settle(reply, hunks)
      setGuides(key, { guide, diff, version })
      // The tab shows the guide either way, so a guide that cannot be kept only costs a later run.
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

  /** The subject's guide as one page, or the offer to write one. */
  const view = (ctx: TabContext, subject: () => Subject): JSX.Element => {
    const key = () => subject().key
    const state = () => guides[key()]
    // A guide kept for this version of the diff shows without a run. A guide for an earlier version stays
    // until the user writes a new one, with a note that the diff changed.
    createEffect(() => {
      const { key, place, version } = subject()
      if (!version || untrack(() => guides[key]?.version === version || guides[key]?.generating)) return
      const kept = readGuide(place, version)
      if (kept) setGuides(key, { guide: kept.guide, diff: kept.diff, version, generating: false, error: undefined })
    })
    const write = () => void generate(ctx, subject())
    const runs = () => `Runs ${AGENT_NAMES[agent()] ?? agent()}${model() ? ` (${model()})` : ""} on your plan.`
    const writingNow = (
      <Stack direction="row">
        <Text tone="muted">Writing the guide…</Text>
        <Button label="Cancel" variant="ghost" onClick={() => writing.get(key())?.abort()} />
      </Stack>
    )
    return (
      <Show
        when={state()?.guide}
        fallback={
          <Stack>
            <Text>A guide walks through these changes in a few short sections, in the order to read them.</Text>
            <Show when={!state()?.generating} fallback={writingNow}>
              <Stack direction="row">
                <Button label="Generate guide" variant="primary" disabled={subject().diff === undefined} onClick={write} />
                <Text tone="muted">{runs()}</Text>
              </Stack>
            </Show>
            <Show when={state()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          </Stack>
        }
      >
        {(guide) => (
          <>
            <Stack direction="row">
              <Stack gap={0} grow>
                <Text tone="strong">{guide().title}</Text>
                <Text tone="muted">{guide().summary}</Text>
                <Show when={state()?.diff !== subject().diff && subject().diff !== undefined}>
                  <Text tone="muted">The diff changed since this guide was written. It shows the diff it was written from.</Text>
                </Show>
              </Stack>
              <Show when={!state()?.generating} fallback={writingNow}>
                <Button label="Generate again" variant="ghost" onClick={write} />
              </Show>
            </Stack>
            <Show when={state()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
            <Diff sections={sectionsOf(guide(), state()?.diff ?? "")} />
          </>
        )}
      </Show>
    )
  }

  return { view }
}
