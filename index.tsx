import { Button, definePlugin, Diff, Item, List, Markdown, Stack, Text, type Tint } from "@comet/plugin"
import { createEffect, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * PR Reviews: the open pull requests on Chatwoot's repo that wait for your review, as a Comet plugin. It
 * reads GitHub with the `gh` CLI, which must be on the PATH and logged in with `gh auth login`. It only
 * reads. It never comments on, approves or changes a pull request.
 *
 * The sidebar lists open, non-draft pull requests into develop that request your review. Picking one opens two panels,
 * its description and its diff, and opens the thread kept for it. The card links the pull request the
 * tab's thread is about, and shows its CI checks and unresolved review threads.
 *
 * It reads a pull request again when a turn ends in its thread, since the agent may have commented. A view
 * that comes on screen reads again if what it shows is stale. While the sidebar is on screen it also polls.
 */

const REPO = { owner: "chatwoot", name: "chatwoot" } as const
const REPO_SLUG = `${REPO.owner}/${REPO.name}`
/** The branch the sidebar's pull requests merge into. A stacked pull request merges into another branch, so it is left out. */
const BASE_BRANCH = "develop"
const PR_PANEL = "reviews.pr"
const DIFF_PANEL = "reviews.diff"
const SECOND_MS = 1000
/** How often the sidebar reads again while it is on screen. Review requests change slowly. */
const POLL_MS = 120 * SECOND_MS
/** How old a read may be before a view that comes on screen reads again. */
const STALE_MS = 30 * SECOND_MS
/** The start of each pull request's thread key. Its number follows it. */
const THREAD_PREFIX = "pr-review-"
/** GitHub's search returns at most 100 results a page. One page holds every pending review request. */
const SEARCH_LIMIT = 100
/** Check conclusions that do not fail a pull request. */
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
const PENDING_STATUS = new Set(["PENDING", "EXPECTED"])
/** The tint of the badge for each overall CI state. */
const CI_TINT: Record<string, Tint> = { SUCCESS: "green", FAILURE: "red", ERROR: "red", PENDING: "orange", EXPECTED: "orange" }

/** Where the plugin keeps the images of descriptions it downloaded, named by the hash of their URL. */
const IMAGE_FOLDER = join(tmpdir(), "comet-pr-review-images")
/**
 * The hosts the plugin downloads images from. A description can point an image at any server, and
 * fetching it would show that server the user's address, so GitHub proxies other images. Comet draws
 * any other image as its alt text.
 */
const IMAGE_HOSTS = [/(^|\.)github\.com$/, /(^|\.)githubusercontent\.com$/]
/** The image types Comet draws, by content type, with the extension each file gets. */
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" }
/** Larger images are left as their alt text. Screenshots are far smaller. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** An image as GitHub writes one in a description: an HTML img tag, or Markdown's. */
const IMG_TAG = /<img\b[^>]*>/gi
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]

const fromGitHub = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === "https:" && IMAGE_HOSTS.some((host) => host.test(hostname))
  } catch {
    return false
  }
}

/** Downloads an image once, and answers its file. Undefined for an image Comet cannot draw or that failed. */
async function downloadImage(url: string): Promise<string | undefined> {
  const base = join(IMAGE_FOLDER, createHash("sha1").update(url).digest("hex"))
  const kept = Object.values(IMAGE_TYPES).map((extension) => `${base}.${extension}`).find(existsSync)
  if (kept) return kept
  const response = await fetch(url)
  const extension = IMAGE_TYPES[response.headers.get("content-type")?.split(";")[0]?.trim() ?? ""]
  if (!response.ok || !extension || Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return undefined
  mkdirSync(IMAGE_FOLDER, { recursive: true })
  const file = `${base}.${extension}`
  await Bun.write(file, response)
  return file
}

/**
 * A description with each image as Markdown, which Comet draws: GitHub's img tags become Markdown images.
 * With `files`, an image GitHub hosts names its downloaded file. Any other image keeps its URL, and Comet
 * draws its alt text.
 */
function imagesAsMarkdown(body: string, files: ReadonlyMap<string, string> = new Map()) {
  const source = (url: string) => files.get(url) ?? url
  return body
    .replace(IMG_TAG, (tag) => {
      const src = attribute(tag, "src")
      return src ? `![${attribute(tag, "alt") ?? ""}](${source(src)})` : tag
    })
    .replace(MARKDOWN_IMAGE, (_, alt: string, url: string) => `![${alt}](${source(url)})`)
}

/** A description with the images GitHub hosts downloaded, as `imagesAsMarkdown` draws it. */
async function withDownloadedImages(body: string) {
  const urls = [...imagesAsMarkdown(body).matchAll(MARKDOWN_IMAGE)].map((match) => match[2]!).filter(fromGitHub)
  const files = new Map<string, string>()
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const file = await downloadImage(url).catch(() => undefined)
      if (file) files.set(url, file)
    }),
  )
  return imagesAsMarkdown(body, files)
}

/** The fields the plugin reads from `gh search prs --json`. */
interface ReviewRequest {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly author: { readonly login: string }
}

type Check =
  | { readonly __typename: "CheckRun"; readonly name: string; readonly status: string; readonly conclusion: string | null; readonly detailsUrl: string | null }
  | { readonly __typename: "StatusContext"; readonly context: string; readonly state: string; readonly targetUrl: string | null }

/** The fields the plugin reads from GitHub's GraphQL API for one pull request. */
interface PullRequest {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly body: string
  readonly author: { readonly login: string } | null
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly baseRefName: string
  readonly headRefName: string
  readonly reviewThreads: { readonly nodes: readonly { readonly isResolved: boolean }[] }
  readonly commits: { readonly nodes: readonly { readonly commit: { readonly statusCheckRollup: { readonly state: string; readonly contexts: { readonly nodes: readonly Check[] } } | null } }[] }
}

// GitHub's API returns at most 100 nodes a page. A pull request with more review threads or checks counts the first 100.
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url body additions deletions changedFiles baseRefName headRefName
      author { login }
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`

/** Runs the `gh` CLI. A failure carries the CLI's own error, such as a missing login. */
async function gh(args: readonly string[]) {
  try {
    return await Bun.$`gh ${args}`.quiet()
  } catch (error) {
    const stderr = error instanceof Bun.$.ShellError ? error.stderr.toString().trim() : ""
    throw new Error(stderr || messageOf(error))
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isStale = (readAt: number | undefined) => readAt === undefined || Date.now() - readAt > STALE_MS

/** The pull request a thread key names, or undefined for a key the plugin did not make. */
const prOf = (key: string) => {
  const number = key.startsWith(THREAD_PREFIX) ? Number(key.slice(THREAD_PREFIX.length)) : NaN
  return Number.isInteger(number) ? number : undefined
}

/** Shares one read per key between callers that ask at once, such as a panel and a card. */
function shared<T>(read: (number: number) => Promise<T>) {
  const reading = new Map<number, Promise<T>>()
  return (number: number) => {
    let found = reading.get(number)
    if (!found) {
      found = read(number).finally(() => reading.delete(number))
      reading.set(number, found)
    }
    return found
  }
}

type CheckState = "passed" | "failed" | "pending"

const checkOf = (check: Check): { name: string; url?: string; state: CheckState } =>
  check.__typename === "CheckRun"
    ? { name: check.name, url: check.detailsUrl ?? undefined, state: check.status !== "COMPLETED" ? "pending" : PASSING.has(check.conclusion ?? "") ? "passed" : "failed" }
    : { name: check.context, url: check.targetUrl ?? undefined, state: check.state === "SUCCESS" ? "passed" : PENDING_STATUS.has(check.state) ? "pending" : "failed" }

const ciOf = (pr: PullRequest) => {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup
  if (!rollup) return undefined
  const checks = rollup.contexts.nodes.map(checkOf)
  const count = (state: CheckState) => checks.filter((check) => check.state === state).length
  return { state: rollup.state, checks, failed: count("failed"), pending: count("pending"), passed: count("passed") }
}

export default definePlugin((comet) => {
  /** `readAt` is when the last read finished, in milliseconds since the epoch. */
  const [inbox, setInbox] = createStore<{ requests: ReviewRequest[]; loading: boolean; error?: string; readAt?: number }>({ requests: [], loading: false })
  /** Each pull request as last read, by number. The diff is read only for its panel. */
  /** `description` is the body with its images downloaded, once they are. */
  const [prs, setPrs] = createStore<Record<number, { pr?: PullRequest; description?: string; diff?: string; error?: string; diffError?: string; readAt?: number; diffReadAt?: number }>>({})
  const entry = (number: number) => {
    if (!prs[number]) setPrs(number, {})
  }

  // A poll and a turn end can ask at once, so they share one read.
  let inboxRead: Promise<void> | undefined
  /** Reads the review requests. Only a read the user asked for, or the first, shows "Loading…", so polling does not flicker. */
  const refreshInbox = (shown = false) => {
    if (shown || inbox.readAt === undefined) setInbox("loading", true)
    inboxRead ??= gh(["search", "prs", "--repo", REPO_SLUG, "--review-requested=@me", "--state", "open", "--draft=false", "--base", BASE_BRANCH, "--sort", "updated", "--limit", String(SEARCH_LIMIT), "--json", "number,title,url,author"])
      .then((output) => {
        setInbox("requests", reconcile(output.json() as ReviewRequest[], { key: "number" }))
        setInbox({ error: undefined, readAt: Date.now() })
      })
      .catch((error) => setInbox("error", messageOf(error)))
      .finally(() => {
        setInbox("loading", false)
        inboxRead = undefined
      })
    return inboxRead
  }

  /** Reads a pull request's details, checks and review threads. */
  const readPr = shared((number) =>
    gh(["api", "graphql", "-F", `owner=${REPO.owner}`, "-F", `name=${REPO.name}`, "-F", `number=${number}`, "-f", `query=${PR_QUERY}`])
      .then((output) => {
        const pr = (output.json() as { data: { repository: { pullRequest: PullRequest } } }).data.repository.pullRequest
        entry(number)
        setPrs(number, "pr", reconcile(pr))
        setPrs(number, { error: undefined, readAt: Date.now() })
        void withDownloadedImages(pr.body).then((description) => setPrs(number, "description", description))
      })
      .catch((error) => {
        entry(number)
        setPrs(number, { error: messageOf(error) })
      }),
  )

  const readDiff = shared((number) =>
    gh(["pr", "diff", String(number), "--repo", REPO_SLUG])
      .then((output) => {
        entry(number)
        setPrs(number, { diff: output.text(), diffError: undefined, diffReadAt: Date.now() })
      })
      .catch((error) => {
        entry(number)
        setPrs(number, { diffError: messageOf(error) })
      }),
  )

  // The agent may have commented on the pull request, or the author may have pushed while the turn ran.
  // The diff is read again only if a panel read it before.
  comet.onTurnEnd(({ key }) => {
    const number = prOf(key)
    if (number === undefined) return
    void readPr(number)
    if (prs[number]?.diff !== undefined) void readDiff(number)
    void refreshInbox()
  })

  comet.sidebar("inbox", {
    title: "Reviews",
    view: (ctx) => {
      // The list is read when it first comes on screen, and polls only while on screen.
      // The effect follows only `visible`, so a read does not restart the timer.
      createEffect(() => {
        if (!ctx.visible()) return
        if (untrack(() => isStale(inbox.readAt))) void refreshInbox()
        const timer = setInterval(() => void refreshInbox(), POLL_MS)
        onCleanup(() => clearInterval(timer))
      })
      return (
        <Stack grow>
          <Stack direction="row">
            <Text tone="muted">{inbox.loading ? "Loading…" : "Waiting for your review"}</Text>
            <Button label="Refresh" variant="ghost" disabled={inbox.loading} onClick={() => refreshInbox(true)} />
          </Stack>
          <Show when={inbox.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={inbox.requests.length > 0} fallback={<Show when={!inbox.loading && !inbox.error}><Text tone="muted">No pull requests wait for your review.</Text></Show>}>
            <List>
              <For each={inbox.requests}>
                {(request) => (
                  <Item
                    title={request.title}
                    subtitle={`#${request.number} · ${request.author.login}`}
                    selected={ctx.isOpen(PR_PANEL, { number: request.number })}
                    onSelect={() => {
                      // The description's tab opens first, and the diff's opens beside it, in front.
                      ctx.open(PR_PANEL, { number: request.number })
                      ctx.open(DIFF_PANEL, { number: request.number })
                      ctx.openThread({
                        key: `${THREAD_PREFIX}${request.number}`,
                        title: `#${request.number} ${request.title}`,
                        prompt: `Review pull request ${REPO_SLUG}#${request.number}, "${request.title}". Read it with \`gh pr view ${request.number} --repo ${REPO_SLUG} --comments\` and \`gh pr diff ${request.number} --repo ${REPO_SLUG}\`. Tell me what it changes and what you would flag. Do not comment on, approve or request changes on the pull request without asking me first.`,
                      })
                    }}
                  />
                )}
              </For>
            </List>
          </Show>
        </Stack>
      )
    },
  })

  comet.panel<{ number: number }>("pr", {
    title: (params) => `#${params.number}`,
    params: ["number"],
    single: true,
    view: (ctx) => {
      const number = ctx.params.number
      // A panel reads its pull request when it comes on screen with nothing read, or a stale read.
      createEffect(() => {
        if (ctx.visible() && untrack(() => isStale(prs[number]?.readAt))) void readPr(number)
      })
      const read = () => prs[number]
      return (
        <Stack grow>
          <Show when={read()?.pr}>
            {(pr) => (
              <Stack gap={0}>
                <Text tone="strong">{pr().title}</Text>
                <Text tone="muted">
                  #{number} · {pr().author?.login ?? "ghost"} · {pr().baseRefName} ← {pr().headRefName} · +{pr().additions} −{pr().deletions} in {pr().changedFiles} files
                </Text>
              </Stack>
            )}
          </Show>
          <Show when={read()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={read()?.pr} fallback={<Show when={!read()?.error}><Text tone="muted">Loading…</Text></Show>}>
            {(pr) => <Markdown text={(read()?.description ?? imagesAsMarkdown(pr().body)).trim() || "_No description._"} />}
          </Show>
        </Stack>
      )
    },
  })

  comet.panel<{ number: number }>("diff", {
    title: (params) => `#${params.number} diff`,
    params: ["number"],
    single: true,
    view: (ctx) => {
      const number = ctx.params.number
      // The diff reads when its panel comes on screen with nothing read, or a stale read.
      createEffect(() => {
        if (ctx.visible() && untrack(() => isStale(prs[number]?.diffReadAt))) void readDiff(number)
      })
      const read = () => prs[number]
      return (
        <Stack grow>
          <Show when={read()?.diffError}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={read()?.diffReadAt !== undefined} fallback={<Show when={!read()?.diffError}><Text tone="muted">Loading the diff…</Text></Show>}>
            <Diff patch={read()?.diff ?? ""} />
          </Show>
        </Stack>
      )
    },
  })

  comet.card("status", {
    title: "Pull request",
    view: (ctx) => {
      const number = () => prOf(ctx.thread() ?? "")
      const pr = () => {
        const found = number()
        return found === undefined ? undefined : prs[found]?.pr
      }
      // The card reads only while on screen, and only a stale read. The panel shares the read when both show.
      createEffect(() => {
        if (!ctx.visible()) return
        const found = number()
        if (found !== undefined && untrack(() => isStale(prs[found]?.readAt))) void readPr(found)
      })
      return (
        <Show when={pr()}>
          {(shown) => {
            const ci = () => ciOf(shown())
            const unresolved = () => shown().reviewThreads.nodes.filter((thread) => !thread.isResolved).length
            return (
              <Stack gap={0}>
                <Item title={`Pull request #${shown().number}`} subtitle={shown().title} icon="github" href={shown().url} />
                <Item
                  title="CI"
                  subtitle={ci() ? `${ci()!.failed} failed · ${ci()!.pending} pending · ${ci()!.passed} passed` : "No checks"}
                  badge={ci() ? { text: ci()!.state.toLowerCase(), tint: CI_TINT[ci()!.state] ?? "neutral" } : undefined}
                  href={`${shown().url}/checks`}
                />
                <For each={ci()?.checks.filter((check) => check.state === "failed")}>
                  {(check) => <Item title={check.name} badge={{ text: "failed", tint: "red" }} href={check.url} />}
                </For>
                <Item
                  title="Unresolved comments"
                  badge={{ text: String(unresolved()), tint: unresolved() ? "orange" : "neutral" }}
                  href={`${shown().url}/files`}
                />
              </Stack>
            )
          }}
        </Show>
      )
    },
  })

  comet.setup("reviews", { title: "PR Reviews", sidebar: "reviews.inbox" })
})
