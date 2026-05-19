// Spawn MCP Server for Clay
// Exposes a spawn_session tool that lets an agent create new Clay sessions
// inside the current project and seed each one with an initial user message.
//
// Primary use case: a planning session triages a list of work items (JIRA
// issues, GitHub tickets, etc.) and fans them out into per-item sessions,
// each pre-titled and started with the relevant command (e.g. "/jira HARD-207").
//
// SDK-free: returns runtime-agnostic tool definitions for YOKE adapter.
//
// Usage:
//   var spawnMcp = require("./spawn-mcp-server");
//   var toolDefs = spawnMcp.getToolDefs(onSpawn);
//   var mcpConfig = adapter.createToolServer({ name: "clay-sessions", version: "1.0.0", tools: toolDefs });

var z;
try { z = require("zod"); } catch (e) { z = null; }

function buildShape(props, required) {
  if (!z) return {};
  var shape = {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var p = props[k];
    var field;
    if (p.type === "number") field = z.number();
    else if (p.type === "boolean") field = z.boolean();
    else if (p.enum) field = z.enum(p.enum);
    else field = z.string();
    if (p.description) field = field.describe(p.description);
    if (!required || required.indexOf(k) === -1) field = field.optional();
    shape[k] = field;
  }
  return shape;
}

// Callbacks:
//   onSpawn(args) -> Promise<{ sessionId, cliSessionId?, title, mode, vendor }>
//   onMarkDone({ sessionId?: number, undo?: boolean }) -> Promise<{ sessionId, cliSessionId?, oldTitle, newTitle, wasAlreadyDone }>
// Both throw (or reject) on invalid input or runtime errors; the wrapper
// translates errors into an isError tool result so the calling agent sees them.
function getToolDefs(onSpawn, onMarkDone) {
  var tools = [];

  tools.push({
    name: "spawn_session",
    description:
      "Create a new INTERACTIVE Clay session in the current project, named " +
      "after a specific work item, and seed it with an initial user message. " +
      "Returns immediately so multiple sessions can be spawned in one turn " +
      "(call this tool in parallel — one call per work item).\n" +
      "\n" +
      "USE THIS TOOL — do NOT use the clay-ralph skill — when the user asks to:\n" +
      "  - \"start working on these issues/tickets in clay\"\n" +
      "  - \"work on these in clay\" / \"open these in clay\" / \"do these in clay\"\n" +
      "  - \"split these into sessions\" / \"one session per issue\"\n" +
      "  - \"open a session for each of these\" / \"a session per ticket\"\n" +
      "  - \"fan these out\" / \"spin up sessions\" / \"begin work on these in parallel\"\n" +
      "  - any similar request to turn a list of work items into per-item Clay sessions,\n" +
      "    INCLUDING phrasings with \"start\", \"begin\", \"kick off\", or \"phase 1/2/...\".\n" +
      "\n" +
      "DISAMBIGUATION vs clay-ralph: spawn_session creates regular interactive " +
      "sessions that the human will steer one by one — each session waits for " +
      "human input after its initial prompt runs. The clay-ralph skill is for a " +
      "single autonomous loop that runs unattended against ONE prompt/judge " +
      "pair (typically overnight, AFK). If the user is splitting a list of " +
      "ITEMS into sessions, this is spawn_session. Only use clay-ralph when the " +
      "user explicitly says \"ralph\", \"ralph loop\", \"autonomous loop\", \"run " +
      "while I'm AFK\", or asks for a single self-driving iteration loop.\n" +
      "\n" +
      "Do NOT ask the user to confirm session creation; the request itself is the " +
      "approval. Spawn one session per item from the user's list, in a single " +
      "turn, using parallel tool calls when possible.\n" +
      "\n" +
      "Title: use the item's identifier (e.g. the JIRA key \"HARD-207\", the " +
      "GitHub issue number \"#1234\", etc.). Keep it short — it shows in the " +
      "sidebar. The title is marked as user-set and Clay's auto-title will not " +
      "overwrite it. NOTE: when initial_prompt starts with a slash command and " +
      "a positional argument (e.g. \"/jira GP-222\"), Clay overrides the title " +
      "field with that argument automatically. Pass a reasonable title anyway " +
      "as a fallback for free-form prompts.\n" +
      "\n" +
      "Initial prompt: pick the slash command the user's project uses to load " +
      "context for that item. If JIRA keys are mentioned, use \"/jira <KEY>\"; " +
      "if GitHub issues, use \"/issue <number>\" or whichever discovery command " +
      "is in the available slash commands. When no slash command fits, use a " +
      "short natural-language instruction (e.g. \"Begin work on ticket HARD-207\"). " +
      "Slash commands pass through verbatim to the SDK or CLI.\n" +
      "\n" +
      "Mode: default \"tui\" runs the real claude CLI in an xterm (Interactive " +
      "billing bucket). Use \"gui\" only when the user explicitly asks for the " +
      "SDK chat UI (permission cards, Clay's MCP tools surfaced natively) or " +
      "for codex sessions (which always run gui).\n" +
      "\n" +
      "After spawning, briefly tell the user which sessions were created — do " +
      "NOT switch the user's current view; they stay in the planning session.\n" +
      "\n" +
      "Return: each call's tool result includes a [clay-sessions/spawn_session] " +
      "tracking line with localId (Clay's per-daemon session number) and " +
      "cliSessionId (the claude UUID). Keep these in mind so the dispatcher " +
      "can refer back to specific sessions later (e.g. \"session #5 (GP-222) " +
      "is the auth refactor\").",
    inputSchema: buildShape({
      title: {
        type: "string",
        description: "Title for the new session, e.g. the issue key \"HARD-207\".",
      },
      initial_prompt: {
        type: "string",
        description:
          "First user message sent to the new session. Slash commands pass " +
          "through verbatim (e.g. \"/jira HARD-207\").",
      },
      vendor: {
        type: "string",
        enum: ["claude", "codex"],
        description: "Optional vendor for the new session. Defaults to \"claude\".",
      },
      mode: {
        type: "string",
        enum: ["tui", "gui"],
        description:
          "Optional session mode. \"tui\" launches the real claude CLI in an " +
          "xterm (Interactive billing bucket); \"gui\" uses Clay's SDK-driven " +
          "chat UI (Programmatic billing bucket). Defaults to \"tui\". Codex " +
          "vendor always runs in gui regardless of this arg.",
      },
      permission_mode: {
        type: "string",
        enum: ["plan", "default", "acceptEdits", "auto", "bypassPermissions", "dontAsk"],
        description:
          "Optional starting permission mode for the new session. Defaults " +
          "to \"plan\" so per-issue sessions begin in plan mode — they load " +
          "context with the slash command (e.g. /jira <KEY>), produce a " +
          "plan, and wait for the user to approve before editing. Pass " +
          "\"default\" for normal per-tool approval, \"acceptEdits\" to " +
          "auto-approve file writes, or any other claude permission mode " +
          "if the spawn isn't planning-shaped.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "Optional reasoning effort level. Defaults to \"high\" so " +
          "planning sessions reason carefully before producing a plan. " +
          "Drop to \"medium\" or \"low\" for cheap/fast spawns; raise to " +
          "\"xhigh\"/\"max\" for hard problems.",
      },
    }, ["title", "initial_prompt"]),
    handler: function (args) {
      var title = (args.title || "").trim();
      var initialPrompt = (args.initial_prompt || "").trim();
      var vendor = args.vendor || "claude";
      var mode = (args.mode === "gui" || args.mode === "tui") ? args.mode : "tui";
      // Codex has no TUI adapter; force gui for codex regardless of arg.
      if (vendor === "codex") mode = "gui";
      var permissionMode = args.permission_mode || "plan";
      var effort = args.effort || "high";

      if (!title) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: title is required and must be non-empty." }],
          isError: true,
        });
      }
      if (!initialPrompt) {
        return Promise.resolve({
          content: [{ type: "text", text: "Error: initial_prompt is required and must be non-empty." }],
          isError: true,
        });
      }

      return Promise.resolve()
        .then(function () { return onSpawn({ title: title, initialPrompt: initialPrompt, vendor: vendor, mode: mode, permissionMode: permissionMode, effort: effort }); })
        .then(function (result) {
          // Return a structured identifier line the dispatcher can parse out
          // of context, plus a human-readable summary. The cliSessionId is
          // the UUID claude uses internally (useful for later `claude
          // --resume`); localId is Clay's per-daemon session number (the
          // value other clay-sessions tools accept as `session_id`).
          var localId = result && result.sessionId;
          var cliSessionId = (result && result.cliSessionId) || null;
          var t = (result && result.title) || title;
          var m = (result && result.mode) || mode;
          var v = (result && result.vendor) || vendor;
          var summary = "Spawned " + m + " session #" + localId + " \"" + t + "\".";
          var trackingLine = "[clay-sessions/spawn_session] localId=" + localId +
            " cliSessionId=" + (cliSessionId || "(pending)") +
            " title=" + JSON.stringify(t) +
            " mode=" + m +
            " vendor=" + v;
          return {
            content: [
              { type: "text", text: summary },
              { type: "text", text: trackingLine },
            ],
          };
        })
        .catch(function (err) {
          return {
            content: [{ type: "text", text: "Error spawning session: " + (err && err.message || err) }],
            isError: true,
          };
        });
    },
  });

  if (typeof onMarkDone === "function") {
    tools.push({
      name: "mark_session_done",
      description:
        "Mark a Clay session as done by prefixing its title with \"done - \". " +
        "Idempotent: a session that's already prefixed is left unchanged.\n" +
        "\n" +
        "USE THIS TOOL when the user signals work on the current session (or a " +
        "specific session) is complete — e.g. \"/done\", \"that's done\", " +
        "\"mark this one finished\", \"close out GP-222\". This is the Clay " +
        "side of the workflow: the user's /done skill should also transition " +
        "the corresponding JIRA ticket via the Atlassian MCP tools.\n" +
        "\n" +
        "session_id: optional Clay localId of the session to mark. Omit to " +
        "mark the currently active session (works when the agent is calling " +
        "from within the session being completed). Pass an explicit id from " +
        "a dispatcher session to mark a peer session you tracked from " +
        "spawn_session.\n" +
        "\n" +
        "undo: pass true to remove a previously applied \"done - \" prefix " +
        "(restore the original title).",
      inputSchema: buildShape({
        session_id: {
          type: "number",
          description:
            "Clay localId of the session to mark (the same number returned " +
            "by spawn_session as localId). Omit to use the currently active " +
            "session.",
        },
        undo: {
          type: "boolean",
          description: "Pass true to strip an existing \"done - \" prefix.",
        },
      }, []),
      handler: function (args) {
        var sessionId = (typeof args.session_id === "number") ? args.session_id : null;
        var undo = !!args.undo;
        return Promise.resolve()
          .then(function () { return onMarkDone({ sessionId: sessionId, undo: undo }); })
          .then(function (result) {
            var localId = result && result.sessionId;
            var oldTitle = (result && result.oldTitle) || "";
            var newTitle = (result && result.newTitle) || "";
            var alreadyDone = !!(result && result.wasAlreadyDone);
            var verb = undo ? "Restored" : "Marked done";
            var changed = (oldTitle !== newTitle);
            var summary;
            if (!changed && alreadyDone && !undo) {
              summary = "Session #" + localId + " already marked done (\"" + newTitle + "\").";
            } else if (!changed && undo) {
              summary = "Session #" + localId + " was not marked done (\"" + newTitle + "\").";
            } else {
              summary = verb + " session #" + localId + ": \"" + oldTitle + "\" -> \"" + newTitle + "\".";
            }
            var trackingLine = "[clay-sessions/mark_session_done] localId=" + localId +
              " cliSessionId=" + ((result && result.cliSessionId) || "(none)") +
              " title=" + JSON.stringify(newTitle) +
              " action=" + (undo ? "undo" : "done") +
              " changed=" + changed;
            return {
              content: [
                { type: "text", text: summary },
                { type: "text", text: trackingLine },
              ],
            };
          })
          .catch(function (err) {
            return {
              content: [{ type: "text", text: "Error marking session done: " + (err && err.message || err) }],
              isError: true,
            };
          });
      },
    });
  }

  return tools;
}

module.exports = { getToolDefs: getToolDefs };
