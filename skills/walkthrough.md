# UI Walkthrough: $ARGUMENTS

You are giving the user a guided tour of a locally-running web portal
and turning each piece of their feedback into either an inline fix or
a tracked JIRA ticket.

Drive the browser with the **Playwright MCP server** (tools prefixed
`browser_*` from the `playwright` MCP server: `browser_navigate`,
`browser_snapshot`, `browser_take_screenshot`, `browser_click`,
`browser_type`, `browser_press_key`, `browser_wait_for`,
`browser_console_messages`, `browser_network_requests`,
`browser_tab_close`). If those aren't available in this session, stop
and tell the user to install Playwright MCP:
`claude mcp add --scope user playwright -- npx @playwright/mcp@latest`.

The browser opens a window the user can watch. You analyse the
accessibility snapshot (`browser_snapshot`) for structured DOM
content for reasoning about controls — but **always also take a
screenshot** (`browser_take_screenshot`) of every page you visit so
the user has a visual record to review alongside your commentary.
The snapshot tells you *what* is on the page; the screenshot is what
the user looks at to judge it.

### Where screenshots go

Save every screenshot into `<cwd>/.playwright-mcp/` (relative to the
working directory — this is the Playwright MCP default and gets
gitignored). Pass an explicit `filename` to `browser_take_screenshot`
so each file is identifiable later:

```
filename = "<KEY>-<page-slug>-<NN>.png"
```

- `<KEY>` — the relevant JIRA issue key in **uppercase**:
  - If a JIRA ticket was just filed for this page (Step 5b), use
    that key (e.g. `GP-247`).
  - If the walkthrough is being driven against a specific issue the
    user mentioned at the start, use that key for every screenshot.
  - Otherwise use the literal string `WALK` as a placeholder until
    a ticket is filed; if the screenshot then becomes attached to
    a newly-filed ticket, rename or take a fresh shot with the real
    key so the artifact is traceable.
- `<page-slug>` — short kebab-case identifier for the page or panel
  (e.g. `dispatch`, `settings-account`, `inventory-table`).
- `<NN>` — zero-padded sequence number if you take more than one
  shot of the same page in the same session (`01`, `02`, …).

Examples: `.playwright-mcp/GP-247-dispatch-01.png`,
`.playwright-mcp/WALK-settings-account-01.png`.

If `.playwright-mcp/` doesn't exist yet, the MCP server creates it on
first write — you don't need to mkdir.

---

## Step 1: Resolve the URL

`$ARGUMENTS` is **optional**. If the user provided something, use it
verbatim as the URL to walk through.

Otherwise, detect the project's local dev URL in this order. Stop at
the first source that yields a candidate; do NOT run a dev server
yourself — assume the user already has one running.

1. **Project CLAUDE.md / AGENTS.md** — Read the project's instruction
   file(s). Look for explicit URLs like `http://localhost:NNNN` or
   `127.0.0.1:NNNN`, or a "Development" / "Local" / "Dev server"
   section that names a port.
2. **Project Makefile** — `Read` the cwd's `Makefile` (and any
   `*.mk` files). Search for `--port`, `PORT=`, `:NNNN`, or `serve`
   / `dev` / `run` targets that hard-code a port. Many monorepos put
   the canonical dev port in a top-level Make target so the same
   command spins it up everywhere.
3. **Sibling deploy/config repo** — Many setups keep dev port maps
   in a *sibling* repo, not the app repo itself. Check this cwd's
   parent directory for siblings whose names look like
   `*-deploy-dev`, `*-deploy`, `*-config`, `*-infra`, `*-deployment`,
   or simply `config` / `deploy`. For each match, `Read` its
   `Makefile`, top-level YAML (`docker-compose.yml`,
   `values.yaml`), `.env*` files, and any `*.json` config that
   references the current project by name or slug. Pull the port
   from there.
4. **package.json scripts** — Read `package.json`. If `scripts.dev`
   or `scripts.start` references vite (default 5173), next (3000),
   react-scripts / CRA (3000), nuxt (3000), angular (4200), astro
   (4321), or remix (3000), pick the conventional port. Honour any
   `--port NNNN` in the script string before falling back to the
   framework default.
5. **Backend hints** — `manage.py` (Django, 8000), `Gemfile` /
   `config/puma.rb` (Rails, 3000), `go.mod` with a documented
   port, `application.yml` / `application.properties` (Spring Boot,
   often 8080).
6. **Port probe** — As a last resort, probe each of
   `localhost:3000, localhost:3001, localhost:5173, localhost:4200,
   localhost:8000, localhost:8080` with a quick HTTP HEAD or GET via
   `bash` (e.g. `curl -sIm 1 http://localhost:3000`). Use the first
   one that returns a 2xx/3xx response.
7. **Ask the user** — if none of the above resolve, stop and ask
   what URL to walk through. Don't guess.

When you pick a URL, tell the user **in one short sentence** which
source it came from ("found localhost:3000 documented in
`../silverleafe-deploy-dev/Makefile`", "package.json's vite config
implies localhost:5173", "port probe found a server on localhost:4200").
This lets the user catch a wrong inference fast.

Don't run an exhaustive read of every config file when an earlier
source already gave you a verified port — but verify before
committing. If a Makefile says port 3000 but `localhost:3000`
doesn't respond, fall through to the probe rather than dying.

## Step 2: Open the Page

Call `browser_navigate` with the resolved URL. Wait for the page to
settle (`browser_wait_for` with a sensible network-idle or selector
condition). If the navigation errors out (DNS, connection refused,
TLS), stop and tell the user the server doesn't appear to be running
on that URL — suggest they confirm it's started, or override with
`$ARGUMENTS` next time.

## Step 3: Initial Landing-page Read

Call `browser_snapshot` to get the accessibility tree **and**
`browser_take_screenshot` to capture the landing page visually.
Save the screenshot to `.playwright-mcp/<KEY>-landing-01.png` using
the naming rules above. Surface the file path in chat so the user
can see what you're looking at. Then summarise **out loud** for the
user in chat:

- The page title and top-level heading
- The primary navigation items (link text + where they go, when the
  hrefs are inferrable)
- Major panels / sections present
- Any obvious error states, console errors
  (`browser_console_messages` for warnings/errors), or 4xx/5xx
  network calls (`browser_network_requests`)

This summary is the user's map. Keep it tight — a short bulleted list
is better than prose.

Then ask: **"Where do you want to start?"** — let the user steer.
Don't auto-tour every route; the user will tell you which page they
want to look at first.

## Step 4: Walkthrough Loop

For each page or section the user wants to inspect:

1. Navigate there (`browser_navigate`, `browser_click`,
   `browser_type` as needed). Wait for it to settle.
2. Read the page (`browser_snapshot`) **and** take a screenshot
   (`browser_take_screenshot`) every time, saving to
   `.playwright-mcp/<KEY>-<page-slug>-<NN>.png` (see the naming
   rules at the top of this skill). Surface the file path in chat
   so the user has a visual to review alongside your commentary.
   The snapshot is for your reasoning; the screenshot is what the
   user judges the page from.
3. Describe what's there briefly. Call out anything that looks
   off: console errors, broken images, accessibility issues
   (missing labels, low-contrast labels in the snapshot), obvious
   visual breakage.
4. Wait for the user's feedback before moving on.

Don't spend a turn passively waiting — proactively flag issues you
notice. The user might not have spotted the console error you can
see in `browser_console_messages`.

## Step 5: Handle Each Piece of Feedback

When the user says something needs to change, classify it:

### a) Small inline fix

The change is a one-or-two-file edit that's safe to apply right now:
copy text, button label, CSS tweak, missing aria-label, obvious typo,
a small JS bug whose fix is obvious from the source.

- Locate the relevant file with **Grep** / **Glob** (do NOT use
  `bash` running `grep`/`find` — native tools are tracked).
- Read with **Read**, edit with **Edit**.
- Tell the user what you changed in one sentence.
- Suggest they hot-reload (or do `browser_navigate` to the same URL
  if the dev server doesn't HMR) and confirm the fix.

### b) Larger work — file a JIRA ticket

The change needs design discussion, multiple files, a migration, a
backend contract change, etc. — anything where you'd want a proper
plan before touching code.

- Call `mcp__atlassian__getAccessibleAtlassianResources` if you
  haven't yet in this session.
- Call `mcp__atlassian__createJiraIssue` with:
  - `projectKey`: from the user's context (ask once if you don't
    know it; remember it for the rest of the walkthrough)
  - `summary`: a short, specific title
  - `description` (markdown): what's on the screen, what's wrong,
    what should happen instead. Include the URL of the page being
    walked through, and a snippet of the relevant accessibility
    snapshot if structural.
  - `issueType`: pick "Bug" if it's a defect, "Task" otherwise.
- Tell the user the new key in one short sentence ("filed GP-247
  for the dispatch-page header spacing").

### c) Bigger work — spawn a Clay session

If a fix needs a full `/jira` workflow (plan, review, deploy to
us-test, commit), don't try to do it inline. After filing the JIRA
ticket per (b), additionally call
`mcp__clay-tools__clay-sessions__spawn_session` with
`title = "<NEW-KEY>"` and `initial_prompt = "/jira <NEW-KEY>"`. This
creates a sidebar session that picks the issue up with the full
flow. Mention to the user that the new session was spawned so they
can attend to it after the walkthrough.

### d) Just discussion

Sometimes the user is thinking out loud. Don't create issues or
edit files unless they explicitly ask. Acknowledge, ask
clarifying questions, and move on when they're ready.

## Step 6: Running Tally

Maintain (in your head / in conversation) a running list of:

- **Fixed inline**: file + one-line description per change.
- **Filed as JIRA**: ticket key + summary per issue.
- **Spawned sessions**: localId + JIRA key per spawned session.

You don't need to show this on every turn — it would be noisy. But
when the user says "okay, that's enough" or similar, surface the
tally.

## Step 7: Wrap-up

When the user signals they're done with the walkthrough:

1. Close the browser tab (`browser_tab_close`) if it's still open.
2. Print the running tally in three short sections (Fixed,
   Filed, Spawned).
3. Ask whether you should follow up on any of the spawned
   sessions before wrapping (e.g. transition the parent issue,
   leave a JIRA comment summarising the walkthrough).

Do NOT switch the user's view to any spawned session. They stay in
this walkthrough session.

---

## Rules

- **Browser MCP only** — never use `bash` to `curl` the local URL
  as a substitute for `browser_navigate`. The walkthrough is
  visual; the user is watching the browser window.
- **Always screenshot every page** — `browser_snapshot` gives you
  structured semantic content for reasoning, but every page the
  user visits during the walkthrough should also be captured with
  `browser_take_screenshot` and surfaced in chat. The user is
  reviewing the UI; they need to see it, not just read your
  description of it.
- **Screenshots land in `.playwright-mcp/`** — relative to the cwd,
  with the JIRA key prefixed in the filename
  (`<KEY>-<page-slug>-<NN>.png`). Use `WALK` as the key prefix only
  until a real ticket is filed; once a ticket exists for the page,
  the screenshot for that page must use that key so the artifact is
  traceable back to JIRA.
- **No URL guessing without a probe** — when auto-detecting,
  don't just pick a port from convention. Verify with a quick
  HTTP probe that something is actually responding there before
  navigating. Otherwise you'll get a connection-refused error
  and waste a turn.
- **Native tools for file reads** — Read / Grep / Glob, not
  `bash` running `cat`/`grep`/`find`.
- **Agent teams for cross-cutting fixes** — if a small inline
  fix turns out to span several files you didn't anticipate, fall
  back to filing a JIRA + spawning a session via /jira rather
  than blowing up the walkthrough's context. The skill is meant to
  stay snappy.
- **Don't auto-tour** — the user steers. Your job is to describe
  what's on the current page and respond, not to march through
  every route unprompted.
- **Flag attention when blocked** — if you need the user to switch
  pages, confirm a fix, or pick between options before continuing,
  call `request_user_attention` with a short reason like "ready for
  next page", "fix applied — refresh and confirm?". Clay highlights
  this session in the sidebar so they can find it. Auto-clears when
  they open it.
- **One JIRA per discrete issue** — if the user raises three
  separate things on one page, that's three tickets (or three
  inline fixes, or a mix). Don't bundle unrelated feedback into
  one big ticket; it makes work-tracking and PR scoping harder
  later.
