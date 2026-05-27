# Sprint Orchestration: $ARGUMENTS

You are orchestrating a phased plan over a set of JIRA issues. The
user wants a dependency tree, a phased ordering, and Clay sessions
spawned for each phase one phase at a time.

This skill is invoked **once per phase**. On first run it figures out
the input mode, builds the plan, and starts Phase 1. On every
subsequent invocation it re-inspects JIRA for current status, decides
which phase to run next, and spawns the Clay sessions for it.

## Step 0: Decode the Input Mode

`$ARGUMENTS` can be either:

- **Parent-issue mode**: a single JIRA issue key like `GP-221`.
  Orchestrates the parent issue's direct sub-tasks. Detected when
  `$ARGUMENTS` matches `<PROJECT>-<number>` (e.g. `GP-221`,
  `HARD-509`).

- **Fix-version mode**: `<PROJECT>/<VERSION>` — a JIRA project key
  and a fix-version name separated by a slash, e.g. `GP/2.0` or
  `HARD/release-15`. Orchestrates every issue in that project with
  that `fixVersion`. Detected when `$ARGUMENTS` contains a `/`.

If the input doesn't match either shape, stop and ask the user to
clarify (don't guess).

## Step 1: Discover Atlassian Site

Call `mcp__atlassian__getAccessibleAtlassianResources` to get the cloud
ID. Cache it for the rest of this skill. Fail loudly if this errors.

## Step 2: Fetch the Scope

**Parent-issue mode:** Call `mcp__atlassian__getJiraIssue` with the
cloud ID, issue key `$ARGUMENTS`, and
`responseContentFormat: "markdown"`. Capture the parent's summary,
type, and current status. If the parent is not found, stop and ask
the user to verify the key.

**Fix-version mode:** Split `$ARGUMENTS` on `/` into `PROJECT` and
`VERSION`. Call `mcp__atlassian__searchJiraIssuesUsingJql` with a
small probe query (`project = "<PROJECT>" AND fixVersion =
"<VERSION>"` with `maxResults: 1`) to confirm the project and version
exist and return at least one issue. If the probe returns zero, stop
and ask the user to verify either the project key or the version name
(the version may not exist or may be misspelled). Capture the project
name and version name for use in later headers.

### Step 2.5: Mark this Session as the Sprint Dispatcher

Call the Clay MCP tool `rename_session` (exposed as `rename_session`
in GUI sessions, or `clay-sessions__rename_session` via the
`clay-tools` bridge in TUI sessions) on the current session.

**Parent-issue mode** title:
```
title = "$ARGUMENTS - <short parent summary>"
kind  = "sprint"
```

**Fix-version mode** title:
```
title = "<PROJECT> v<VERSION> sprint"
kind  = "sprint"
```

Truncate so the full title stays under ~80 characters. The
`kind: "sprint"` tag tells Clay's sidebar to render a small
branching-tree icon next to the title so the user can spot the
dispatcher session at a glance among many spawned sub-task sessions.

Skip silently if the rename tool isn't available (running outside
Clay) — the rest of the skill still works without it.

## Step 3: Fetch the Issue Set

**Parent-issue mode:** call `mcp__atlassian__searchJiraIssuesUsingJql`
with:

```
parent = "$ARGUMENTS" ORDER BY rank ASC
```

**Fix-version mode:** call `mcp__atlassian__searchJiraIssuesUsingJql`
with:

```
project = "<PROJECT>" AND fixVersion = "<VERSION>" ORDER BY rank ASC
```

In both modes, for each result capture: key, summary, current status,
assignee (if any), issue type, and the issue's links (call
`mcp__atlassian__getJiraIssue` per issue if the JQL response doesn't
include link types — needed for dependency detection in Step 5).

If the JQL returns zero issues, stop with a helpful message:
- Parent mode: "parent issue has no sub-tasks, nothing to orchestrate."
- Fix-version mode: "no issues found with that fixVersion in
  <PROJECT> — verify the project key and version name."

**Include items regardless of status** (To Do, In Progress, Done,
Blocked, etc.) — the user explicitly wants visibility into all of
them, not just the open ones. Status drives phase advancement; you
will skip already-Done items when spawning sessions.

## Step 4: Display the Inventory

Print a compact table of every item so the user can see what they're
starting from:

**Parent-issue mode** header:
```
## Sub-tasks of $ARGUMENTS — <parent summary>
```

**Fix-version mode** header:
```
## Issues in <PROJECT> fixVersion <VERSION>
```

Then the same table layout in both modes:

```
| Key      | Type    | Status        | Summary                       |
|----------|---------|---------------|-------------------------------|
| GP-222   | Story   | Done          | Setup auth scaffolding        |
| GP-223   | Task    | In Progress   | Add database schema           |
| GP-224   | Bug     | To Do         | Fix login redirect            |
| ...      | ...     | ...           | ...                           |
```

## Step 5: Identify Dependencies

For each item, derive its blockers from:

1. **JIRA issue links** — the most authoritative source. Look for
   link types "Blocks", "Is Blocked By", "Depends On", "Has To Be
   Done After". Treat "Is Blocked By GP-X" as "depends on GP-X".
2. **Description and acceptance-criteria text** — natural-language
   references like "After GP-X is done…" or "Requires GP-Y".
3. **Type-driven defaults** — UI items tend to depend on API items
   of the same epic; integration tests tend to depend on all feature
   work. Apply this only when no explicit link exists and call it
   out as inferred.

Be explicit when a dependency is inferred vs. declared in JIRA.

## Step 6: Build Phases

Topologically sort items into phases:

- **Phase 1**: items with no dependencies (or whose dependencies are
  already Done).
- **Phase N>1**: items whose dependencies are all satisfied by
  earlier phases or by items already Done in JIRA.

Within a phase, items run in parallel (the user fans them out into
separate Clay sessions). So a phase should be the *maximal* set of
items that have no unsatisfied dependencies — don't artificially
split them.

If a cycle is detected in the dependency graph, stop and report it.
Cycles need human intervention.

## Step 7: Render the Dependency Tree

Show the phased plan as a markdown tree, marking each item with its
JIRA status. Root label varies by mode:

- Parent-issue mode: `<KEY> — <parent summary>`
- Fix-version mode: `<PROJECT> fixVersion <VERSION>`

```
GP-221 — Auth refresh epic
│
├── Phase 1 — independent setup
│   ├── ✓ GP-222 — Setup auth scaffolding         [Done]
│   ├── ◐ GP-223 — Add database schema            [In Progress]
│   └── ○ GP-224 — Create test fixtures           [To Do]
│
├── Phase 2 — depends on Phase 1
│   ├── ○ GP-225 — Auth UI                        [To Do]  ← blocked by GP-222
│   └── ○ GP-226 — Auth API                       [To Do]  ← blocked by GP-222, GP-223
│
└── Phase 3 — depends on Phase 2
    └── ○ GP-227 — Integration tests              [To Do]  ← blocked by GP-225, GP-226
```

Legend: `✓` Done, `◐` In Progress, `○` To Do, `⚠` Blocked.

## Step 8: Decide Which Phase to Run

Walk the phases in order and find the **first phase that has at
least one item not yet Done**. That's the target phase.

- If every phase is fully Done, congratulate the user — the scope is
  complete. In parent-issue mode, also attempt to transition the
  parent issue itself to Done (`mcp__atlassian__getTransitionsForJiraIssue`
  → match "Done"/"Closed"/"Resolved" → `transitionJiraIssue`). Only
  after that transition succeeds (or the parent is already Done) may
  you call `mark_session_done` on this dispatcher session. If the
  parent-close transition fails, report the failure and leave the
  dispatcher session **active** so the user can resolve it manually
  — never mark the sprint done while JIRA still shows the parent as
  open. In fix-version mode there's no parent issue to gate on, so
  marking the dispatcher session done is the user's call (don't do
  it automatically). Stop without spawning anything.
- If a target phase exists, tell the user which phase it is, list
  the items in that phase, and **wait for explicit approval before
  spawning Clay sessions**.

The user might say "skip GP-225 for now" or "only spawn GP-224 from
this phase" — respect their override.

### Step 8.5: Transition the Parent Issue to In Progress

**Parent-issue mode only.** Skip this step in fix-version mode (fix
versions don't have a single status to transition).

Before spawning any sub-task sessions, make sure the parent issue's
JIRA status reflects that work is now active.

1. If you cached the parent's current status in Step 2 and it's
   already in an in-progress-shaped state (case-insensitive match
   for "In Progress", "Start Progress", "In Development",
   "Ongoing") or terminal-shaped (Done / Closed / Resolved), skip
   the transition silently.
2. Otherwise call `mcp__atlassian__getTransitionsForJiraIssue` with
   the cloud ID and the parent key (`$ARGUMENTS` in parent-issue
   mode).
3. Pick the transition whose name best matches "In Progress" (also
   accept "Start Progress", "In Development", or the closest
   semantic equivalent).
4. Call `mcp__atlassian__transitionJiraIssue` with the matched
   transition ID.
5. If the transition succeeds, mention it briefly to the user
   (one line). If no suitable transition exists or the API call
   fails, report it but **continue with the spawn** — the JIRA
   status of the parent is secondary to actually starting the
   work.

Do NOT block the spawn on this step. The user already approved
launching the phase; a parent-status update is bookkeeping, not a
gate.

## Step 9: Spawn Clay Sessions for the Target Phase

For each item in the approved phase that is **not already Done**:

Call `spawn_session` (from `clay-sessions` MCP — exposed as
`mcp__clay-tools__clay-sessions__spawn_session` via the bridge in TUI
sessions). One call per item, in **parallel** in a single agent turn.

Arguments per call:

- `title`: just the JIRA key (e.g. `"GP-225"`). The `/jira` slash
  command running inside the spawned session will refine it to
  `"GP-225 — <summary>"` once it fetches the issue.
- `initial_prompt`: `"/jira GP-225"` (slash command, including the
  key as its arg).
- `mode`: omit (defaults to `"tui"` for subscription billing).
- `permission_mode`: omit (defaults to `"plan"` so each session
  produces a plan before touching code).
- `effort`: omit (defaults to `"high"`).

Items that are already **In Progress** should also be spawned — the
user explicitly said they want to continue them. The `/jira` skill
inside that session will pick up where the prior work left off.

Items already **Done** should NOT be spawned — skip them and note
why in the summary.

## Step 10: Summarise and Hand Off

In a short final message, tell the user:

- Which phase you started (e.g. "Phase 2 of 3").
- Which items were spawned, with their Clay session localIds (from
  the `spawn_session` tracking lines).
- Which items were skipped and why ("GP-222 already Done").
- How to advance: "Re-run `/sprint $ARGUMENTS` once you're done with
  this phase and I'll detect completion in JIRA and launch the next
  one."

Do NOT switch the user's view to any of the spawned sessions — they
stay in the dispatcher session (this one) so they can come back here
to advance.

---

## Rules

- **JIRA is the source of truth for phase advancement** — don't rely
  on Clay's done flag for orchestration decisions. Always re-fetch
  item status from JIRA at Step 3 on every invocation.
- **One phase per invocation** — never spawn items from a later
  phase before the current phase is Done in JIRA. The user explicitly
  wants phased execution, not "everything at once".
- **Approval gate before each phase launch** — Step 8's "wait for
  approval" is non-negotiable. The user may want to override
  ordering, skip an item, or pause.
- **Flag attention when waiting** — at the Step 8 approval gate
  (and any time you're blocked, e.g. cycle detected in Step 6), call
  `request_user_attention` with a short reason like "Phase 2 plan
  ready — approve to spawn" or "dependency cycle, need user input".
  Clay highlights the dispatcher session in the sidebar so the user
  can spot it among many. Auto-clears when they open the session.
- **Parallel spawn within a phase** — call `spawn_session` once per
  item in a single turn so the sessions appear together in the
  sidebar instead of trickling in.
- **Skip Done items** — never spawn a session for an item that
  JIRA already shows as Done. The user wants resumption, not
  duplication.
- **Don't mark the dispatcher done unless JIRA agrees** — in
  parent-issue mode, the sprint dispatcher session may only be
  marked done after the parent JIRA issue itself has been
  transitioned to Done (or was already Done). If the parent-close
  transition fails, leave the dispatcher session active and tell
  the user. Clay-done while JIRA-open is the divergence this gate
  prevents. Same rule for GitHub-as-tracker projects: don't mark
  the dispatcher done unless the GitHub close succeeded.
- **Inferred dependencies are flagged** — when you derive a
  dependency from description text or type heuristics rather than a
  JIRA link, mark it `(inferred)` in the tree so the user can
  correct you.
- **Native tools over bash** — when reading source files to enrich
  dependency analysis, use Read / Grep / Glob, not `bash` running
  `cat` / `grep` / `find`.
- **Subagents for cross-cutting analysis** — if dependencies aren't
  obvious from JIRA alone and you need to inspect code to figure out
  ordering (e.g. "does the API exist for GP-225's UI work?"),
  dispatch parallel Explore subagents rather than doing it
  sequentially in the main turn.
