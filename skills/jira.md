# JIRA Issue Workflow: $ARGUMENTS

You are executing a structured development workflow for JIRA issue **$ARGUMENTS**. Follow these steps in order. Do NOT skip steps or combine them.

---

## Step 1: Discover Atlassian Site

Call `mcp__atlassian__getAccessibleAtlassianResources` to get the cloud ID.
Store it for all subsequent JIRA calls. If this fails, stop and report the error.

## Step 2: Fetch Issue Details

Call `mcp__atlassian__getJiraIssue` with the cloud ID, issue key `$ARGUMENTS`,
and `responseContentFormat: "markdown"`.

Display to the user: issue summary, description, type, priority, current status,
and acceptance criteria (if any).

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

**WAIT for explicit user approval before committing.**

## Step 8: Commit and Close Issue

After the user approves:

1. **Commit**: Follow the project's commit message conventions from CLAUDE.md.
   Stage only the relevant files (never `git add -A` or `git add .`).

2. **Transition to Done**: Call `mcp__atlassian__getTransitionsForJiraIssue`
   to discover available transitions. Find the best match for the final status
   (match "Done", "Closed", "Resolved", "Complete" -- pick the closest).
   Call `mcp__atlassian__transitionJiraIssue` with the matched transition ID.
   If no suitable transition exists, report available transitions and let the
   user decide.

---

## Rules

- **Two approval gates**: ALWAYS wait for explicit user approval after Step 3
  (plan) and Step 7 (work review). Never auto-proceed past these gates.
- **Dynamic discovery**: Always discover cloud ID and transition IDs at runtime.
  Never hardcode them.
- **Error resilience**: If a JIRA API call fails (comment, transition), report
  the error but continue with development work. JIRA updates are secondary to
  the code changes.
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
