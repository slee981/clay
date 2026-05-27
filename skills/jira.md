# JIRA Issue Workflow: $ARGUMENTS

You are executing a structured development workflow for JIRA issue **$ARGUMENTS**. Follow these steps in order. Do NOT skip steps or combine them.

---

## Step 1: Discover Atlassian Site

Call `mcp__atlassian__getAccessibleAtlassianResources` to get the cloud ID.
Store it for all subsequent JIRA calls. If this fails, stop and report the error.

## Step 2: Fetch Issue Details

Call `mcp__atlassian__getJiraIssue` with the cloud ID, issue key `$ARGUMENTS`,
and `responseContentFormat: "markdown"`.

**Print the issue to the user before doing anything else.** This is the
first thing the user sees in the session and the only time they see the
ticket spelled out — don't fold it into your plan or skip to exploration.
Use a markdown block laid out like this (omit fields the API doesn't
return):

```
## $ARGUMENTS — <summary>

**Type:** <type>   **Priority:** <priority>   **Status:** <status>

### Description
<full description body — preserve markdown formatting>

### Acceptance Criteria
<bulleted list from AC field, or "(none specified)">
```

If the issue is not found, stop and ask the user to verify the issue key.

### Step 2.5: Rename the Clay Session

As soon as you have the issue summary, call the Clay MCP tool
`rename_session` (exposed as `rename_session` in GUI sessions, or
`clay-sessions__rename_session` via the `clay-tools` bridge in TUI
sessions) with:

```
title = "$ARGUMENTS - <issue summary>"
```

Truncate the summary so the full title stays under ~80 characters (the
sidebar gets noisy past that). Do not pass `session_id`; the tool will
operate on the calling session.

If the rename tool is not available in this session (e.g. running
outside Clay), skip this step silently.

## Step 3: Transition to In Progress and Plan

As soon as you begin planning, transition the issue to "In Progress" so the
JIRA status reflects active work:

1. **Transition to In Progress**: Call `mcp__atlassian__getTransitionsForJiraIssue`
   to discover available transitions. Find the best match for "In Progress"
   (case-insensitive, also match "Start Progress", "In Development", etc.).
   Call `mcp__atlassian__transitionJiraIssue` with the matched transition ID.
   If no suitable transition exists or the issue is already in progress, report
   this and continue.

2. **Enter plan mode and dispatch agent teams**. Use parallel subagents
   for the exploration phase whenever the work spans multiple files,
   modules, or layers. A single sequential pass through the codebase is
   slow and chews up the main turn's context; subagents run in
   isolated context windows and return summaries.

   Pick subagents that match the work. Send the calls in a single
   message so they run concurrently:

   - **Explore** (`subagent_type: "Explore"`) for "where is X defined",
     "which files reference Y", "what's the test coverage for module Z".
     One call per distinct lookup; many in parallel is fine.
   - **architect** (`everything-claude-code:architect`) for system-design
     and scalability questions, refactoring scope, technical trade-offs.
   - **planner** (`everything-claude-code:planner`) for breaking the
     issue itself into ordered implementation steps. Useful when the
     ticket is larger than a single PR.
   - **code-reviewer** / **security-reviewer** / **database-reviewer**
     for risk surfaces touched by the change (auth, data model, perf).
   - **general-purpose** as a fallback for open-ended research.

   Prefer reading source files **directly** with the Read tool rather
   than `bash` running `cat`, `head`, or `tail`. Use **Grep** for
   substring/regex searches and **Glob** for filename patterns instead
   of `bash` running `grep` / `find` / `ls`. The native tools return
   structured output the harness can track and integrate with rewind
   /checkpoint behaviour; shell commands skip that.

   Reserve `bash` for things only the shell can do: running tests,
   building, git status, running a script. Not for browsing the tree.

   Once the subagents return, synthesise their findings into a detailed
   implementation plan including:
   - Summary of the JIRA issue requirements
   - Files to create or modify (with paths)
   - Implementation approach for each change
   - Test strategy
   - Risks or edge cases (call out what each reviewer subagent surfaced)

   Present the plan and **WAIT for explicit user approval before continuing**.

## Step 4: Post Plan to JIRA

After the user approves the plan:

1. **Add plan as JIRA comment**: Call `mcp__atlassian__addCommentToJiraIssue`
   with the plan formatted in markdown (`contentFormat: "markdown"`).

## Step 5: Implement

Implement all changes according to the approved plan. Follow the conventions
and patterns defined in the project's CLAUDE.md and existing codebase.

## Step 6: Write Tests

Write tests for all new functionality:
- Follow existing test patterns in the codebase
- Cover happy paths and error cases
- Run the tests and verify they pass

## Step 7: Present Work for Review

Present a summary of all changes:
- Files created and modified
- Brief description of each change
- Test results

**WAIT for explicit user approval before proceeding to the us-test deploy.**

## Step 7.5: Deploy to us-test

Before committing, deploy the changes to the **us-test** environment so
the user can confirm the changes behave correctly against the test
deployment. The exact deploy command is project-specific — find it in
this priority order:

1. The project's `CLAUDE.md` (look for a `## Deploy` or `## us-test`
   section, or a documented script).
2. `package.json` scripts (e.g. `deploy:us-test`, `deploy-test`).
3. `Makefile` targets (e.g. `make deploy-us-test`, `make us-test`).
4. Any `bin/` or `scripts/` files with `us-test` / `deploy` in the
   name.

If you can't find a documented command, **stop and ask the user**
what the deploy command is rather than guessing. Do NOT push to a
production-shaped environment.

Run the deploy. Stream output so the user sees what happens. Report
success, failure, and any URLs the deploy emits (e.g. a us-test
endpoint to verify against).

**WAIT for explicit user confirmation that us-test works as expected
before committing.** This is the third approval gate. If the user
finds something wrong on us-test, return to Step 5 to fix it; don't
proceed to commit.

## Step 8: Commit and Close Issue

After the user has confirmed us-test:

1. **Commit**: Follow the project's commit message conventions from CLAUDE.md.
   Stage only the relevant files (never `git add -A` or `git add .`).

2. **Transition to Done**: Call `mcp__atlassian__getTransitionsForJiraIssue`
   to discover available transitions. Find the best match for the final status
   (match "Done", "Closed", "Resolved", "Complete" -- pick the closest).
   Call `mcp__atlassian__transitionJiraIssue` with the matched transition ID.
   If no suitable transition exists, or the transition call errors out,
   **stop here** — report the failure and ask the user how they want to
   handle it. Do NOT proceed to step 3. The Clay session must not be
   marked done while JIRA still shows the issue as open.

3. **Mark the Clay session done** — only if step 2 succeeded (or the
   issue was already in a done-shaped status before this step). If
   JIRA could not be transitioned, skip this step entirely. Call the
   `mark_session_done` tool from the `clay-sessions` MCP server
   (exposed as `mark_session_done` in GUI sessions, or
   `clay-sessions__mark_session_done` via the `clay-tools` bridge in
   TUI sessions). Pass no arguments — it operates on the calling
   session. The tool flips the session's structural `done` flag so
   Clay moves it from the **Active** tab to the **Completed** tab in
   the sidebar. Skip silently if the tool isn't available (running
   outside Clay).

---

## Rules

- **Always print the issue first**: Step 2's full issue block (summary,
  description, AC) is non-skippable — print it to the user before any
  exploration, planning, or tool calls beyond the initial JIRA fetch.
  The user needs the description in plain text to decide whether to
  approve the plan; folding it into the plan or skipping it because
  "the model already read it" is wrong.
- **Three approval gates**: ALWAYS wait for explicit user approval
  after Step 3 (plan), Step 7 (work review), and Step 7.5 (us-test
  confirmation). Never auto-proceed past these gates. The us-test
  deploy is what catches issues *before* they make it into a commit.
- **Flag attention at approval gates**: every time you stop and wait
  for the user (the three gates above, plus any time you're blocked
  on an ambiguous question), call `request_user_attention` with a
  short reason like "plan ready for approval", "us-test confirmed?",
  or "blocked on JIRA cloud ID". Clay highlights the session in the
  sidebar so the user can find which spawn needs them. Auto-clears
  when they open the session, so you don't have to remember to clear
  it.
- **Dynamic discovery**: Always discover cloud ID and transition IDs at runtime.
  Never hardcode them.
- **Error resilience**: If a JIRA API call fails during *development*
  steps (comment, in-progress transition), report the error but
  continue with development work. JIRA updates during the work itself
  are secondary to the code changes. **Exception**: the final
  done-transition in Step 8 is a hard gate — if that fails, do NOT
  mark the Clay session done. The two systems must agree on
  completion; Clay-done while JIRA-open is the bug this rule prevents.
- **GitHub-as-tracker projects**: if a project uses GitHub Issues or
  PR-close in place of JIRA for completion, the same hard gate
  applies — don't `mark_session_done` unless the GitHub close also
  succeeded.
- **Selective staging**: When committing, add specific files by name.
- **Project conventions**: Always defer to the project's CLAUDE.md for commit
  message format, coding style, and other conventions.
- **Agent teams over solo exploration**: When a step needs codebase-wide
  context (Step 3 planning, Step 6 test coverage discovery), dispatch
  parallel subagents via the Task tool rather than doing everything
  sequentially. One call per independent lookup, sent in a single
  message so they run concurrently. The Explore agent is the default
  for "find / where / which"; the architect / planner / reviewer
  agents for judgement calls. Don't dispatch a subagent for trivial
  single-file lookups — the round-trip cost outweighs the benefit
  there.
- **Native tools over bash for file access**: Read files with the Read
  tool, search with Grep, find paths with Glob. Reserve `bash` for
  operations only the shell can do (tests, builds, `git status`,
  scripts). Do NOT `cat`, `head`, `tail`, `grep`, `find`, or `ls`
  through bash — the native tools integrate with rewind /
  checkpointing and produce structured output the harness can track.
