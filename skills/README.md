# Clay Skills

Optional slash-command skills that drive Clay's MCP servers (`clay-sessions`,
`clay-debate`, …). Drop the `.md` files into your Claude Code commands
directory and they show up as `/<name>` slash commands in any Claude
session.

## Install

```bash
# User-level (every project on this machine):
cp skills/*.md ~/.claude/commands/

# Project-level (only this repo):
mkdir -p .claude/commands
cp skills/*.md .claude/commands/
```

Restart any open Claude session (in Clay's UI or in `claude` CLI) so the
new commands appear in the slash-command list.

## What's included

| Skill | What it does | Requires |
|-------|--------------|----------|
| [`/jira <KEY>`](jira.md) | Full JIRA→implementation workflow: print the issue summary, rename the Clay session to `KEY - <summary>`, transition to In Progress, dispatch parallel subagents for codebase exploration, produce a plan, implement, deploy to **us-test** for confirmation, then commit and transition to Done. Three approval gates (plan, work review, us-test confirmation). | Clay (for `rename_session`, `mark_session_done`), the Atlassian Rovo MCP server, your project's `CLAUDE.md` (for the deploy command) |
| [`/sprint <KEY>`](sprint.md) or [`/sprint <PROJECT>/<VERSION>`](sprint.md) | Orchestrate work in phases. Two input modes: pass a JIRA parent issue key (e.g. `GP-221`) to fan out its sub-tasks, or pass `<PROJECT>/<VERSION>` (e.g. `GP/2.0`) to fan out all issues with that fixVersion. Either way the skill builds a phased dependency tree (including done / in-progress items), tags the dispatcher session with `kind: "sprint"` so it shows a branching-tree icon in the sidebar, and on each invocation spawns Clay sessions for the next not-yet-done phase. JIRA is the source of truth for phase advancement, so re-running the skill after a phase completes auto-launches the next one. | Clay (for `spawn_session`, `rename_session`), the Atlassian Rovo MCP server, the `/jira` skill installed in spawned sessions |
| [`/done`](done.md) | Wraps up the session: transitions the JIRA ticket to Done via Atlassian Rovo, then calls Clay's `mark_session_done` so the sidebar moves the session from **Active** to **Completed**. | Clay (for `mark_session_done`), the Atlassian Rovo MCP server |

Both skills are designed to work inside a Clay session — they call into
Clay's `clay-sessions` MCP server. GUI sessions reach the tools directly;
TUI (xterm) sessions reach them through the `clay-tools` stdio bridge
(`lib/yoke/mcp-bridge-server.js`), which Clay launches automatically with
`--session-id` so session-aware tools always operate on the calling
session.

## Customising

The shipped files are reference implementations. Edit them in place —
they're plain markdown that Claude reads at slash-command invocation
time. Common tweaks:

- **Different JIRA naming conventions** — change the `KEY - <summary>`
  format in `jira.md` Step 2.5.
- **Different "done" transitions** — the matcher in `done.md` Step 2
  prefers "Done" but falls back to "Complete" / "Closed" / "Resolved";
  adjust if your workflow uses something else.
- **Skip the agent-team dispatch** for smaller projects — remove or
  trim Step 3's parallel-subagent block in `jira.md` if a single
  sequential pass works for you.

## Building your own

A Clay-flavoured skill is just a markdown file in `~/.claude/commands/`.
Useful Clay-specific MCP tools you can reference:

- `mcp__clay-tools__clay-sessions__spawn_session(title, initial_prompt, mode?, permission_mode?, effort?)`
  — fan out per-item work sessions.
- `mcp__clay-tools__clay-sessions__rename_session(title)` — set the
  current session's title.
- `mcp__clay-tools__clay-sessions__mark_session_done(undo?)` — flip the
  Active/Completed flag.
- `mcp__clay-tools__clay-debate__propose_debate(...)` — kick off a
  structured multi-Mate debate.

In TUI sessions the tools are exposed via the `clay-tools` bridge, hence
the namespaced names above. In GUI sessions they're available without the
bridge prefix.
