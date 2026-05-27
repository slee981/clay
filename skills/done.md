# Mark Current JIRA Issue and Clay Session as Done

The user has signalled that work on the current JIRA issue is complete.
Carry out the two actions below. Run JIRA and Clay updates in parallel
where the tool calls don't depend on each other.

---

## Step 1: Identify the JIRA Issue Key

Look back through this session's earlier messages for a `/jira <KEY>`
invocation or any explicit `ABC-123`-style JIRA key. That key is the
ticket to close.

If you cannot find a JIRA key in the conversation, stop and ask the user
to confirm which issue to mark done. Do not guess.

## Step 2: Transition the Issue to Done in JIRA

1. Call `mcp__atlassian__getAccessibleAtlassianResources` to get the
   cloud ID (skip if you already have it cached in this session).
2. Call `mcp__atlassian__getTransitionsForJiraIssue` with the cloud ID
   and the issue key to discover available transitions.
3. Pick the transition whose name best matches "Done" (case-insensitive;
   also accept "Complete", "Closed", "Resolved" if no exact "Done"
   exists).
4. Call `mcp__atlassian__transitionJiraIssue` with the matched
   transition ID.

If the issue is already in a done-shaped status, treat that as
**JIRA succeeded** for the purposes of Step 3 — note it in the final
summary, then proceed to mark Clay done.

If the transition fails for any other reason (no matching transition
exists, the JIRA API errors, the cloud ID lookup fails, the issue
key is wrong), **stop here**. Do NOT proceed to Step 3. Report the
JIRA failure to the user and ask how they want to handle it (manual
JIRA update, different key, or override). The Clay session must not
be flipped to done while JIRA is still showing it as open — having
the two diverge is exactly what this gate exists to prevent.

## Step 3: Mark the Clay Session as Done

**Only run this step if Step 2 succeeded** (or the issue was already
in a done-shaped status). If JIRA could not be updated, skip this
step entirely.

Call the `mark_session_done` tool from the `clay-sessions` MCP server
(exposed as `mark_session_done` in GUI sessions, or
`clay-sessions__mark_session_done` via the `clay-tools` bridge in TUI
sessions). Pass no arguments — it operates on the calling session,
which is this one. The tool routes via the bridge's
`--session-id` plumbing so it always hits the session running `/done`,
even if the user has clicked into a different one while you're working.

The tool flips the session's structural `done` flag (it does NOT
modify the title). The Clay sidebar moves the session from its
"Active" tab into the "Completed" tab automatically. Idempotent —
calling it on an already-done session is a no-op.

## Step 4: Summarise

In ONE short sentence, tell the user:

- Which JIRA transition you applied (or that the issue was already
  done).
- That the Clay session is now marked done.

Do NOT switch the user to a different session, do NOT keep working on
the issue, do NOT propose follow-up work unless they ask. The user is
done with this one.

---

## Rules

- **JIRA-first, then Clay** — never flip the Clay session's `done`
  flag if the JIRA transition failed. The two states must agree;
  Clay-done while JIRA-open is the bug this skill exists to avoid.
  Treat "already done in JIRA" as success — only a real API failure
  (or missing key) blocks Clay from being marked done.
- **Same rule applies to GitHub** — if the user's "done" workflow
  involves closing a PR or issue on GitHub (some projects use that
  in place of JIRA), the same gate applies: don't mark the Clay
  session done unless the GitHub close also succeeded.
