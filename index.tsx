import { Button, definePlugin, Item, List, Markdown, Stack, Text, type Tint } from "@comet/plugin"
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hashOf, readBranch, type Branch } from "./branch"
import { createGuides, type Subject } from "./guide-view"

/**
 * PR Reviews: the open pull requests that wait for your review, as a Comet plugin. Each tab reads the GitHub
 * repository of its own project, as `gh` names it in the project's folder. Its settings filter the list: drafts,
 * approved pull requests, and pull requests into another branch than the base branch. The Base branch setting
 * names that branch, else it is the repository's default branch. It reads GitHub with the `gh` CLI, which must be on the PATH and logged in with `gh auth login`. It only
 * reads. It never comments on, approves or changes a pull request.
 *
 * The sidebar lists the open pull requests that request your review and pass the filters. Picking one opens two panels,
 * its description and its diff, and opens the thread kept for it. The card links the pull request the
 * tab's thread is about, and shows its CI checks and unresolved review threads.
 *
 * It reads a pull request again when a turn ends in its thread, since the agent may have commented. A view
 * that comes on screen reads again if what it shows is stale. While the sidebar is on screen it also polls.
 *
 * The diff panel can show a review guide: the change in chapters and stops, one stop at a time, as
 * `guide-view.tsx` draws it. A guide is kept for the pull request's head commit. The Branch guide panel
 * does the same for the branch the project has checked out, against its base branch. It needs no
 * parameters, so it opens from the view pane's new menu or the palette.
 */

/** A repository as a thread key names it: owner/name. */
const REPO_FORMAT = /^[\w.-]+\/[\w.-]+$/
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
  /** The SHA of the pull request's head commit. A guide is kept for it. */
  readonly headRefOid: string
  readonly reviewThreads: { readonly nodes: readonly { readonly isResolved: boolean }[] }
  readonly commits: { readonly nodes: readonly { readonly commit: { readonly statusCheckRollup: { readonly state: string; readonly contexts: { readonly nodes: readonly Check[] } } | null } }[] }
}

// GitHub's API returns at most 100 nodes a page. A pull request with more review threads or checks counts the first 100.
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url body additions deletions changedFiles baseRefName headRefName headRefOid
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

/** Runs the `gh` CLI, in the folder `$` runs in. A failure carries the CLI's own error, such as a missing login. */
async function gh(args: readonly string[], $: typeof Bun.$ = Bun.$) {
  try {
    return await $`gh ${args}`.quiet()
  } catch (error) {
    const stderr = error instanceof Bun.$.ShellError ? error.stderr.toString().trim() : ""
    throw new Error(stderr || messageOf(error))
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isStale = (readAt: number | undefined) => readAt === undefined || Date.now() - readAt > STALE_MS

/** A pull request: its repository, as owner/name, and its number. */
interface PrRef {
  readonly repo: string
  readonly number: number
}

/** The key a pull request goes by in the plugin's state and in its thread's key. */
const keyOf = ({ repo, number }: PrRef) => `${repo}#${number}`

/** The pull request a thread key names, or undefined for a key the plugin did not make. */
const prOf = (key: string): PrRef | undefined => {
  const found = key.startsWith(THREAD_PREFIX) ? key.slice(THREAD_PREFIX.length).match(/^(.+)#(\d+)$/) : null
  return found && REPO_FORMAT.test(found[1]!) ? { repo: found[1]!, number: Number(found[2]) } : undefined
}

/** Shares one read per pull request between callers that ask at once, such as a panel and a card. */
function shared<T>(read: (pr: PrRef) => Promise<T>) {
  const reading = new Map<string, Promise<T>>()
  return (pr: PrRef) => {
    let found = reading.get(keyOf(pr))
    if (!found) {
      found = read(pr).finally(() => reading.delete(keyOf(pr)))
      reading.set(keyOf(pr), found)
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
  /** The Base branch setting. Empty means the repository's default branch. */
  const base = () => String(comet.settings.get("base") ?? "").trim()

  /**
   * Each project's GitHub repository and its default branch, by the project's folder, as `gh` names them
   * there. A folder `gh` cannot place, such as one with no GitHub remote, holds why.
   */
  const [repos, setRepos] = createStore<Record<string, { repo?: string; defaultBranch?: string; error?: string }>>({})
  const placing = new Set<string>()
  /** Asks `gh` which repository a project is, once per folder. A failed ask is asked again when the sidebar shows next. */
  const readRepo = (folder: string, $: typeof Bun.$) => {
    if (placing.has(folder) || repos[folder]?.repo) return
    placing.add(folder)
    gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], $)
      .then((output) => {
        const found = output.json() as { nameWithOwner: string; defaultBranchRef?: { name: string } | null }
        setRepos(folder, { repo: found.nameWithOwner, defaultBranch: found.defaultBranchRef?.name, error: undefined })
      })
      .catch((error) => setRepos(folder, { error: messageOf(error) }))
      .finally(() => placing.delete(folder))
  }
  /**
   * The branch a repository's list keeps pull requests into: the Base branch setting, else its default branch.
   * Empty when the "Only PRs into the base branch" filter is off, which keeps every branch.
   */
  const branchOf = (repo: string) => {
    if (comet.settings.get("onlyBase") === false) return ""
    return base() || Object.values(repos).find((found) => found.repo === repo)?.defaultBranch || ""
  }
  /**
   * The search a repository's list reads, as `gh search prs` arguments: review requests for you, open, and the
   * filters the settings turn on. GitHub search has no flag to leave approved pull requests out, so that one is a
   * query term. It starts with -, so it goes after `--`, which ends the flags.
   */
  const searchOf = (repo: string) => {
    const branch = branchOf(repo)
    const flags = ["--repo", repo, "--review-requested=@me", "--state", "open", ...(comet.settings.get("hideDrafts") === false ? [] : ["--draft=false"]), ...(branch ? ["--base", branch] : [])]
    const terms = comet.settings.get("hideApproved") === true ? ["-review:approved"] : []
    return [...flags, ...(terms.length ? ["--", ...terms] : [])]
  }

  /**
   * Each repository's review requests, by owner/name. `readAt` is when the last read finished, in milliseconds
   * since the epoch. `search` is the search it read, so a change to the filters reads again.
   */
  const [inboxes, setInboxes] = createStore<Record<string, { requests: ReviewRequest[]; loading: boolean; error?: string; readAt?: number; search?: string }>>({})
  /**
   * Each pull request as last read, by `keyOf`. The diff is read only for its panel. `description` is the body
   * with its images downloaded, once they are.
   */
  const [prs, setPrs] = createStore<Record<string, { pr?: PullRequest; description?: string; diff?: string; error?: string; diffError?: string; readAt?: number; diffReadAt?: number }>>({})
  const entry = (key: string) => {
    if (!prs[key]) setPrs(key, {})
  }

  // A poll and a turn end can ask at once, so they share one read per repository.
  const inboxReads = new Map<string, Promise<void>>()
  /**
   * Reads a repository's review requests, filtered. Only a read the user asked for, the first, or one with other
   * filters shows "Loading…", so polling does not flicker.
   */
  const refreshInbox = (repo: string, shown = false) => {
    const search = searchOf(repo)
    const inbox = inboxes[repo]
    if (!inbox) setInboxes(repo, { requests: [], loading: false })
    if (shown || inbox?.readAt === undefined || inbox.search !== search.join(" ")) setInboxes(repo, "loading", true)
    let read = inboxReads.get(repo)
    if (!read) {
      read = gh(["search", "prs", "--sort", "updated", "--limit", String(SEARCH_LIMIT), "--json", "number,title,url,author", ...search])
        .then((output) => {
          setInboxes(repo, "requests", reconcile(output.json() as ReviewRequest[], { key: "number" }))
          setInboxes(repo, { error: undefined, readAt: Date.now(), search: search.join(" ") })
        })
        .catch((error) => setInboxes(repo, "error", messageOf(error)))
        .finally(() => {
          setInboxes(repo, "loading", false)
          inboxReads.delete(repo)
        })
      inboxReads.set(repo, read)
    }
    return read
  }

  /** Reads a pull request's details, checks and review threads. */
  const readPr = shared((ref) => {
    const [owner, name] = ref.repo.split("/")
    const key = keyOf(ref)
    return gh(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${ref.number}`, "-f", `query=${PR_QUERY}`])
      .then((output) => {
        const pr = (output.json() as { data: { repository: { pullRequest: PullRequest } } }).data.repository.pullRequest
        entry(key)
        setPrs(key, "pr", reconcile(pr))
        setPrs(key, { error: undefined, readAt: Date.now() })
        void withDownloadedImages(pr.body).then((description) => setPrs(key, "description", description))
      })
      .catch((error) => {
        entry(key)
        setPrs(key, { error: messageOf(error) })
      })
  })

  const readDiff = shared((ref) => {
    const key = keyOf(ref)
    return gh(["pr", "diff", String(ref.number), "--repo", ref.repo])
      .then((output) => {
        entry(key)
        setPrs(key, { diff: output.text(), diffError: undefined, diffReadAt: Date.now() })
      })
      .catch((error) => {
        entry(key)
        setPrs(key, { diffError: messageOf(error) })
      })
  })

  const guides = createGuides(comet)

  // The agent may have commented on the pull request, or the author may have pushed while the turn ran.
  // The diff is read again only if a panel read it before.
  comet.onTurnEnd(({ key }) => {
    const ref = prOf(key)
    if (!ref) return
    void readPr(ref)
    if (prs[keyOf(ref)]?.diff !== undefined) void readDiff(ref)
    void refreshInbox(ref.repo)
  })

  comet.sidebar("inbox", {
    title: "Reviews",
    view: (ctx) => {
      const place = () => repos[ctx.project.path]
      const repo = () => place()?.repo
      const inbox = () => {
        const found = repo()
        return found ? inboxes[found] : undefined
      }
      // The project's repository is asked for when the sidebar first shows, and again after a failed ask.
      createEffect(() => {
        if (ctx.visible() && !untrack(repo)) readRepo(ctx.project.path, ctx.$)
      })
      // The list is read when it first comes on screen, and polls only while on screen. A change to the filters
      // reads it again at once. The effect follows only those, so a read does not restart the timer.
      createEffect(() => {
        const found = repo()
        if (!ctx.visible() || !found) return
        const search = searchOf(found).join(" ")
        if (untrack(() => isStale(inboxes[found]?.readAt) || inboxes[found]?.search !== search)) void untrack(() => refreshInbox(found))
        const timer = setInterval(() => void refreshInbox(found), POLL_MS)
        onCleanup(() => clearInterval(timer))
      })
      return (
        <Stack grow>
          <Show when={place()?.error}>{(error) => <Text tone="muted">This project has no GitHub repository that gh can read: {error()}</Text>}</Show>
          <Show when={repo()}>
            {(found) => (
              <>
                <Stack direction="row">
                  <Text tone="muted">{inbox()?.loading ? "Loading…" : `Waiting for your review${branchOf(found()) ? ` into ${branchOf(found())}` : ""}`}</Text>
                  <Button label="Refresh" variant="ghost" disabled={inbox()?.loading} onClick={() => refreshInbox(found(), true)} />
                </Stack>
                <Show when={inbox()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
                <Show when={(inbox()?.requests.length ?? 0) > 0} fallback={<Show when={inbox()?.readAt !== undefined && !inbox()?.loading && !inbox()?.error}><Text tone="muted">No pull requests wait for your review.</Text></Show>}>
                  <List>
                    <For each={inbox()?.requests}>
                      {(request) => (
                        <Item
                          title={request.title}
                          subtitle={`#${request.number} · ${request.author.login}`}
                          selected={ctx.isOpen(PR_PANEL, { repo: found(), number: request.number })}
                          onSelect={() => {
                            const ref = { repo: found(), number: request.number }
                            // The description's tab opens first, and the diff's opens beside it, in front.
                            ctx.open(PR_PANEL, ref)
                            ctx.open(DIFF_PANEL, ref)
                            ctx.openThread({
                              key: `${THREAD_PREFIX}${keyOf(ref)}`,
                              title: `#${request.number} ${request.title}`,
                              prompt: `Review pull request ${keyOf(ref)}, "${request.title}". Read it with \`gh pr view ${request.number} --repo ${ref.repo} --comments\` and \`gh pr diff ${request.number} --repo ${ref.repo}\`. Tell me what it changes and what you would flag. Do not comment on, approve or request changes on the pull request without asking me first.`,
                            })
                          }}
                        />
                      )}
                    </For>
                  </List>
                </Show>
              </>
            )}
          </Show>
          <Show when={!place()}>
            <Text tone="muted">Finding this project's repository…</Text>
          </Show>
        </Stack>
      )
    },
  })

  comet.panel<{ repo: string; number: number }>("pr", {
    title: (params) => `#${params.number}`,
    params: ["repo", "number"],
    single: true,
    view: (ctx) => {
      const { number } = ctx.params
      const ref = { repo: ctx.params.repo, number }
      // A panel reads its pull request when it comes on screen with nothing read, or a stale read.
      createEffect(() => {
        if (ctx.visible() && untrack(() => isStale(prs[keyOf(ref)]?.readAt))) void readPr(ref)
      })
      const read = () => prs[keyOf(ref)]
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

  comet.panel<{ repo: string; number: number }>("diff", {
    title: (params) => `#${params.number} diff`,
    params: ["repo", "number"],
    single: true,
    view: (ctx) => {
      const ref = { repo: ctx.params.repo, number: ctx.params.number }
      const key = keyOf(ref)
      // The diff reads when its panel comes on screen with nothing read, or a stale read. The pull request
      // reads too, since its head commit is the version its guide is kept for.
      createEffect(() => {
        if (!ctx.visible()) return
        if (untrack(() => isStale(prs[key]?.diffReadAt))) void readDiff(ref)
        if (untrack(() => isStale(prs[key]?.readAt))) void readPr(ref)
      })
      const read = () => prs[key]
      const subject = (): Subject => ({
        key: `pr:${key}`,
        diff: read()?.diff,
        place: ["pulls", ...ref.repo.split("/"), String(ref.number)],
        version: read()?.pr?.headRefOid,
        // The description says what the author meant. The guide may be asked for before the pull request is read.
        about: async () => {
          if (!prs[key]?.pr) await readPr(ref)
          const pr = prs[key]?.pr
          return { name: `pull request ${key}`, title: pr?.title ?? "", intent: pr?.body ?? "" }
        },
      })
      return (
        <Stack grow>
          <Show when={read()?.diffError}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={read()?.diffReadAt !== undefined} fallback={<Show when={!read()?.diffError}><Text tone="muted">Loading the diff…</Text></Show>}>
            {guides.view(ctx, subject)}
          </Show>
        </Stack>
      )
    },
  })

  comet.panel("branch", {
    title: "Branch guide",
    view: (ctx) => {
      const [branch, setBranch] = createSignal<Branch>()
      const [error, setError] = createSignal<string>()
      let readAt: number | undefined
      const refresh = () =>
        readBranch(ctx.$)
          .then((found) => {
            setBranch(found)
            setError(undefined)
          })
          .catch((failed) => setError(messageOf(failed)))
          .finally(() => (readAt = Date.now()))
      // The branch reads when its panel comes on screen with nothing read, or a stale read, since the user
      // may have committed or edited files since.
      createEffect(() => {
        if (ctx.visible() && isStale(readAt)) void refresh()
      })
      const subject = (): Subject => ({
        key: `branch:${ctx.project.path}`,
        diff: branch()?.diff,
        place: ["branches", hashOf(ctx.project.path)],
        version: branch() ? hashOf(branch()!.diff) : undefined,
        about: async () => ({ name: `the branch ${branch()?.name} of ${ctx.project.name}, against ${branch()?.base}`, title: branch()?.name ?? "", intent: branch()?.log ?? "" }),
      })
      return (
        <Stack grow>
          <Stack direction="row">
            <Text tone="muted">{branch() ? `${branch()!.name} against ${branch()!.base}` : error() ? "" : "Reading the branch…"}</Text>
            <Button label="Refresh" variant="ghost" onClick={() => void refresh()} />
          </Stack>
          <Show when={error()}>{(found) => <Text tone="muted">{found()}</Text>}</Show>
          <Show when={branch()}>{guides.view(ctx, subject)}</Show>
        </Stack>
      )
    },
  })

  comet.card("status", {
    title: "Pull request",
    view: (ctx) => {
      const ref = () => prOf(ctx.thread() ?? "")
      const pr = () => {
        const found = ref()
        return found && prs[keyOf(found)]?.pr
      }
      // The card reads only while on screen, and only a stale read. The panel shares the read when both show.
      createEffect(() => {
        if (!ctx.visible()) return
        const found = ref()
        if (found && untrack(() => isStale(prs[keyOf(found)]?.readAt))) void readPr(found)
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
