var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var tuiMcp = require("./tui-mcp-config");

// Format a user's answer to an ask_user_questions card as a plain user
// message so the MCP path can feed it back to the agent on the next turn.
// The agent sees its own question text alongside the selected answer(s),
// which keeps the connection explicit: a bare "Phase 0" with no context
// reads as a non-sequitur to the model and triggers "I don't see an
// answer" responses, especially when a turn break sits between the tool
// call and this message.
function formatAskUserAnswerAsMessage(input, answers) {
  var questions = (input && Array.isArray(input.questions)) ? input.questions : [];
  if (questions.length === 0) {
    // Shouldn't happen, but be defensive.
    try { return "(answered with: " + JSON.stringify(answers || {}) + ")"; }
    catch (e) { return "(answered)"; }
  }
  var lines = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var qText = (q && q.question) ? q.question : ("Question " + (i + 1));
    var ans = (answers && answers[i] != null) ? String(answers[i]) : "";
    if (!ans) continue;
    lines.push("- " + qText + " → " + ans);
  }
  if (lines.length === 0) return "(no answer provided)";
  // Prefix tells the model "this is a structured answer to your previous
  // AskUserQuestion call", which the bare "Q → A" alone doesn't make
  // unambiguous when read out of context.
  return "[Answer to your AskUserQuestion]\n" + lines.join("\n");
}

/**
 * Attach session management, config, project management, and mid-section
 * message handlers to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers, debug, dangerouslySkipPermissions, currentVersion,
 *   sm, sdk, tm, clients,
 *   send, sendTo, sendToAdmins, sendToSession, sendToSessionOthers,
 *   opts, usersModule, userPresence, matesModule, pushModule,
 *   getSessionForWs, getLinuxUserForSession, ensureProjectAccessForSession, getOsUserInfoForWs,
 *   hydrateImageRefs, onProcessingChanged, broadcastPresence,
 *   adapter, getProjectList, getProjectCount, getScheduleCount,
 *   moveScheduleToProject, moveAllSchedulesToProject, getHubSchedules,
 *   fetchVersion, isNewer, onCreateWorktree, IGNORED_DIRS,
 *   scheduleMessage, cancelScheduledMessage,
 *   getProjectOwnerId, setProjectOwnerId,
 *   getUpdateChannel, setUpdateChannel,
 *   getLatestVersion, setLatestVersion
 */
function attachSessions(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var osUsers = ctx.osUsers;
  var currentVersion = ctx.currentVersion;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToAdmins = ctx.sendToAdmins;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var opts = ctx.opts;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var pushModule = ctx.pushModule;
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var onProcessingChanged = ctx.onProcessingChanged;
  var broadcastPresence = ctx.broadcastPresence;
  var adapter = ctx.adapter;
  var getProjectList = ctx.getProjectList;
  var getProjectCount = ctx.getProjectCount;
  var getScheduleCount = ctx.getScheduleCount;
  var moveScheduleToProject = ctx.moveScheduleToProject;
  var moveAllSchedulesToProject = ctx.moveAllSchedulesToProject;
  var getHubSchedules = ctx.getHubSchedules;
  var fetchVersion = ctx.fetchVersion;
  var isNewer = ctx.isNewer;
  var onCreateWorktree = ctx.onCreateWorktree;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;
  var scheduleMessage = ctx.scheduleMessage;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var setProjectOwnerId = ctx.setProjectOwnerId;
  var getUpdateChannel = ctx.getUpdateChannel;
  var setUpdateChannel = ctx.setUpdateChannel;
  var getLatestVersion = ctx.getLatestVersion;
  var setLatestVersion = ctx.setLatestVersion;
  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;

  // Resolve the active user's Claude open-mode preference ('gui' or 'tui').
  // Multi-user mode reads the users.json row; single-user mode falls through
  // to the daemon.json fallback in lib/users-preferences.js.
  function getClaudeOpenModeForWs(ws) {
    if (!usersModule || typeof usersModule.getClaudeOpenMode !== "function") return "tui";
    var uid = ws && ws._clayUser ? ws._clayUser.id : null;
    try { return usersModule.getClaudeOpenMode(uid) || "tui"; } catch (e) { return "tui"; }
  }

  // Resolve the active user's "always restart Claude sessions in TUI" pref.
  // When true, born-GUI sessions get a transient runtime PTY on resume so
  // they render in TUI without converting the on-disk session. Multi-user
  // reads users.json; single-user falls through to daemon.json.
  function getAlwaysRestartInTuiForWs(ws) {
    if (!usersModule || typeof usersModule.getAlwaysRestartInTui !== "function") return true;
    var uid = ws && ws._clayUser ? ws._clayUser.id : null;
    try { return usersModule.getAlwaysRestartInTui(uid); } catch (e) { return true; }
  }

  // ---------- TUI session: jsonl watcher (titles + response previews) ----------
  //
  // Watch the per-session jsonl Claude Code writes and mirror its auto /
  // user titles into Clay's session.title. Lets TUI sessions move past the
  // generic "New Session" / "<KEY>" label without us having to scrape the
  // PTY output. The watcher also fires on assistant response blocks so
  // claude replies surface in the notification center.
  //
  // Started lazily on TUI session creation / first click after restart,
  // torn down via stopTitleWatcher on session delete.
  function startTitleWatcher(session) {
    if (!session || !session.cliSessionId) return;
    if (session._titleWatcherStop) return; // already watching
    var watcher;
    try { watcher = require("./claude-jsonl-watcher"); } catch (e) { return; }
    var home = null;
    if (osUsers && session.ownerId) {
      try {
        var ownerUser = usersModule.findUserById ? usersModule.findUserById(session.ownerId) : null;
        if (ownerUser && ownerUser.linuxUser) {
          var info = require("./os-users").resolveOsUserInfo(ownerUser.linuxUser);
          if (info && info.home) home = info.home;
        }
      } catch (e) {}
    }
    if (!home) home = require("os").homedir();
    var jsonlPath = watcher.jsonlPathFor(home, cwd, session.cliSessionId);
    if (!jsonlPath) return;
    var localId = session.localId;
    var stop = watcher.start(jsonlPath, {
      onTitle: function (title) {
        var s = sm.sessions.get(localId);
        if (!s) return;
        var clean = String(title || "").trim().substring(0, 200);
        if (!clean || s.title === clean) return;
        // Don't clobber a user-set title (rename / /jira rename).
        if (s.titleManuallySet) return;
        s.title = clean;
        s.titleAutoGenerated = true;
        try { sm.saveSessionFile(s); } catch (e) {}
        try { sm.broadcastSessionList(); } catch (e) {}
      },
      onResponse: function (text) {
        var s = sm.sessions.get(localId);
        if (!s) return;
        var preview = String(text || "").trim();
        if (!preview) return;
        var firstLine = preview.split("\n")[0];
        if (firstLine.length > 200) firstLine = firstLine.substring(0, 200) + "...";
        var termId = (typeof s.runtimeTerminalId === "number")
          ? s.runtimeTerminalId
          : (typeof s.terminalId === "number" ? s.terminalId : null);
        try {
          ctx._notifications && ctx._notifications.notify("tui_attention", {
            slug: slug,
            sessionId: s.localId,
            ownerId: s.ownerId || null,
            targetUserId: s.ownerId || null,
            title: "Claude responded",
            body: firstLine,
            terminalId: termId,
            sessionTitle: s.title || "",
            cliSessionId: s.cliSessionId || null,
          });
        } catch (e) {}
      },
    });
    session._titleWatcherStop = stop;
  }

  function stopTitleWatcher(session) {
    if (session && typeof session._titleWatcherStop === "function") {
      try { session._titleWatcherStop(); } catch (e) {}
      session._titleWatcherStop = null;
    }
  }

  // Kick off watchers for any TUI sessions already loaded from disk so
  // their titles refresh as soon as Claude Code rewrites the jsonl, even
  // before the user clicks them.
  try {
    sm.sessions.forEach(function (s) {
      if (s.mode === "tui" && s.cliSessionId) startTitleWatcher(s);
    });
  } catch (e) {}

  // Expose the TUI helpers on the session manager so other modules
  // (notably the spawn_session MCP handler in project.js, which closes
  // over `sm` rather than the project-sessions ctx) can wire them in
  // when they spawn TUI sessions of their own.
  sm.startTuiTitleWatcher = startTitleWatcher;
  sm.stopTuiTitleWatcher = stopTitleWatcher;
  sm.makeTuiActivityHook = makeTuiActivityHook;

  // ---------- TUI session: isProcessing bridge ----------
  //
  // Build a PTY onData hook that mirrors SDK-style isProcessing onto the
  // Clay session record. Each output chunk marks isProcessing=true; after
  // 500ms of quiet we flip back to false. Lets the sidebar / icon-strip
  // processing dot blink during claude activity in a TUI session.
  var TUI_QUIET_MS = 500;
  function makeTuiActivityHook(localId) {
    return function onPtyData() {
      var s = sm.sessions.get(localId);
      if (!s) return;
      if (!s.isProcessing) {
        s.isProcessing = true;
        try { sm.broadcastSessionList(); } catch (e) {}
        try { if (typeof onProcessingChanged === "function") onProcessingChanged(s); } catch (e) {}
      }
      if (s._tuiQuietTimer) clearTimeout(s._tuiQuietTimer);
      s._tuiQuietTimer = setTimeout(function () {
        var s2 = sm.sessions.get(localId);
        if (!s2) return;
        s2._tuiQuietTimer = null;
        if (s2.isProcessing) {
          s2.isProcessing = false;
          try { sm.broadcastSessionList(); } catch (e) {}
          try { if (typeof onProcessingChanged === "function") onProcessingChanged(s2); } catch (e) {}
        }
      }, TUI_QUIET_MS);
    };
  }

  // Spawn a transient PTY for "view this Claude GUI session as TUI" when the
  // user's alwaysRestartInTui pref is on. The session itself stays a GUI
  // session on disk; we only attach a runtime terminal so xterm can render
  // `claude --resume <cliSessionId>`. When the PTY dies the runtime link
  // clears and the next click can re-attach without converting the session.
  function spawnRuntimeTuiPty(session, ws) {
    if (!tm || !session || !session.cliSessionId) return null;
    if (typeof session.runtimeTerminalId === "number") {
      // A previous click already spawned one; reuse it. tm.attach will
      // replay scrollback on the new client subscription.
      return session.runtimeTerminalId;
    }
    var sid = session.cliSessionId;
    var localId = session.localId;
    var mcpConfigPath = tuiMcp.buildTuiMcpConfig(slug, opts, sid);
    var cmd = "claude --resume " + sid;
    if (mcpConfigPath) cmd += " --mcp-config " + tuiMcp.shellQuote(mcpConfigPath);
    cmd += "; exit\n";
    var term = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
      initialInput: cmd,
      kind: "tui-session",
      title: "claude (resume) " + sid.slice(0, 8),
      onExit: function () {
        tuiMcp.cleanupTuiMcpConfig(mcpConfigPath);
        // Don't delete the session record - the underlying GUI session is
        // still real. Just drop the runtime link so the sidebar/icon can
        // refresh.
        var s = sm.sessions.get(localId);
        if (s) {
          s.runtimeTerminalId = null;
          try { sm.broadcastSessionList(); } catch (e) {}
        }
      },
    });
    if (term) {
      session.runtimeTerminalId = term.id;
      return term.id;
    }
    return null;
  }

  function handleSessionsMessage(ws, msg) {

    if (msg.type === "push_subscribe") {
      var _pushUserId = ws._clayUser ? ws._clayUser.id : null;
      if (pushModule && msg.subscription) pushModule.addSubscription(msg.subscription, msg.replaceEndpoint, _pushUserId);
      return true;
    }

    if (msg.type === "load_more_history") {
      var session = getSessionForWs(ws);
      if (!session || typeof msg.before !== "number") return true;
      var before = msg.before;
      var targetFrom = typeof msg.target === "number" ? msg.target : before - sm.HISTORY_PAGE_SIZE;
      var from = sm.findTurnBoundary(session.history, Math.max(0, targetFrom));
      var to = before;
      var items = session.history.slice(from, to).map(hydrateImageRefs);
      sendTo(ws, {
        type: "history_prepend",
        items: items,
        meta: { from: from, to: to, hasMore: from > 0 },
      });
      return true;
    }

    if (msg.type === "new_session") {
      var sessionOpts = {};
      if (ws._clayUser && usersModule.isMultiUser()) sessionOpts.ownerId = ws._clayUser.id;
      if (msg.sessionVisibility) sessionOpts.sessionVisibility = msg.sessionVisibility;
      if (msg.vendor) sessionOpts.vendor = msg.vendor;
      // Mode resolution: codex sessions are always GUI (no TUI adapter).
      // Claude sessions honor the explicit msg.mode if provided, otherwise
      // fall back to the user's claudeOpenMode preference. This is what
      // makes the sidebar's "Claude" icon button create the right kind of
      // session without the client needing to know the preference.
      var requestedMode;
      if (msg.vendor === "codex") {
        requestedMode = "gui";
      } else if (msg.mode === "tui" || msg.mode === "gui") {
        requestedMode = msg.mode;
      } else {
        requestedMode = getClaudeOpenModeForWs(ws);
      }
      var newSess;
      if (requestedMode === "tui") {
        // TUI sessions own their cliSessionId up-front so we can launch
        // `claude --session-id <uuid>` and resume the same conversation
        // from external terminals (claude --resume <uuid>) and from the
        // jsonl watcher (~/.claude/projects/<cwd>/<uuid>.jsonl).
        //
        // Construction order matters: createSession() fires session_switched
        // synchronously, so we must populate terminalId on the record before
        // switching. Use createSessionRaw + switchSession to get the right
        // ordering and avoid an extra rebroadcast.
        sessionOpts.mode = "tui";
        sessionOpts.cliSessionId = crypto.randomUUID();
        sessionOpts.vendor = sessionOpts.vendor || "claude";
        newSess = sm.createSessionRaw(sessionOpts);
        if (tm) {
          var tuiSid = newSess.cliSessionId;
          var tuiLocalId = newSess.localId;
          var tuiMcpPath = tuiMcp.buildTuiMcpConfig(slug, opts, tuiSid);
          var tuiCmd = "claude --session-id " + tuiSid;
          if (tuiMcpPath) tuiCmd += " --mcp-config " + tuiMcp.shellQuote(tuiMcpPath);
          tuiCmd += "; exit\n";
          var tuiTerm = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
            initialInput: tuiCmd,
            kind: "tui-session",
            title: "claude " + tuiSid.slice(0, 8),
            onData: makeTuiActivityHook(tuiLocalId),
            onExit: function () {
              tuiMcp.cleanupTuiMcpConfig(tuiMcpPath);
              // Keep the session record around even after the PTY exits
              // (either because the user typed /exit, claude finished its
              // initial prompt and stopped, or mark_session_done shut it
              // down). The conversation is persisted under
              // ~/.claude/projects/<cwd>/<uuid>.jsonl and the next open
              // path will spawn `claude --resume <uuid>` to pick it back up.
              var ds = sm.sessions.get(tuiLocalId);
              if (ds) {
                ds.terminalId = null;
                try { sm.saveSessionFile(ds); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              }
            },
          });
          if (tuiTerm) {
            newSess.terminalId = tuiTerm.id;
          }
        }
        // Persist the TUI session metadata (cliSessionId, mode, vendor) so it
        // survives a daemon restart. saveSessionFile no-ops without
        // cliSessionId; TUI assigns one up-front so this always writes.
        sm.saveSessionFile(newSess);
        // Tail the per-session jsonl claude writes so auto-titles +
        // response previews land in Clay without scraping the PTY.
        startTitleWatcher(newSess);
        sm.switchSession(newSess.localId, ws);
      } else {
        newSess = sm.createSession(sessionOpts, ws);
      }
      ws._clayActiveSession = newSess.localId;
      // Apply project-level email defaults to new session
      if (typeof ctx._email === "object" && ctx._email.getEmailDefaults) {
        var emailDefaults = ctx._email.getEmailDefaults();
        if (emailDefaults.length > 0) {
          var defaultSources = emailDefaults.map(function (id) { return "email:" + id; });
          saveContextSources(slug, newSess.localId, defaultSources);
          sendTo(ws, { type: "context_sources_state", active: defaultSources });
        }
      }
      var nsPresKey = ws._clayUser ? ws._clayUser.id : "_default";
      userPresence.setPresence(slug, nsPresKey, newSess.localId, null);
      if (usersModule.isMultiUser()) {
        broadcastPresence();
      }
      return true;
    }

    if (msg.type === "set_session_visibility") {
      if (typeof msg.sessionId === "number" && (msg.visibility === "shared" || msg.visibility === "private")) {
        sm.setSessionVisibility(msg.sessionId, msg.visibility);
      }
      return true;
    }

    if (msg.type === "set_session_done") {
      if (typeof msg.sessionId === "number") {
        var doneTarget = sm.sessions.get(msg.sessionId);
        if (doneTarget) {
          var nowDone = !!msg.done;
          doneTarget.done = nowDone;
          // Mirror onMarkDone's behaviour: clear the bookmark so the
          // session leaves the favorites strip when marked done.
          if (nowDone && doneTarget.bookmarked) {
            doneTarget.bookmarked = false;
            doneTarget.favoriteOrder = null;
          }
          // Shut down the live claude PTY when marking done so the
          // terminal slot is reclaimed. Soft-exit first, force-close
          // after a grace period if claude doesn't respond.
          if (nowDone && doneTarget.terminalId != null && tm) {
            try { tm.write(doneTarget.terminalId, "/exit\r"); } catch (e) {}
            var _sdTid = doneTarget.terminalId;
            setTimeout(function () {
              try { tm.close(_sdTid); } catch (e) {}
            }, 5000);
          }
          sm.saveSessionFile(doneTarget);
          sm.broadcastSessionList();
        }
      }
      return true;
    }

    if (msg.type === "set_session_bookmark") {
      if (typeof msg.sessionId === "number") {
        var bookmarkTarget = sm.sessions.get(msg.sessionId);
        if (!bookmarkTarget) return true;
        if (usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, bookmarkTarget, { visibility: "public" })) return true;
        }
        sm.setSessionBookmarked(msg.sessionId, !!msg.bookmarked);
      }
      return true;
    }

    if (msg.type === "reorder_session_bookmarks") {
      if (typeof msg.sourceId === "number" && typeof msg.targetId === "number" && msg.sourceId !== msg.targetId) {
        var source = sm.sessions.get(msg.sourceId);
        var target = sm.sessions.get(msg.targetId);
        if (!source || !target) return true;
        if (usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, source, { visibility: "public" })) return true;
          if (!usersModule.canAccessSession(ws._clayUser.id, target, { visibility: "public" })) return true;
        }
        sm.reorderBookmarkedSessions(msg.sourceId, msg.targetId, msg.insertBefore !== false);
      }
      return true;
    }

    if (msg.type === "bulk_delete_sessions") {
      if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) return true;
      var deletableIds = [];
      for (var di = 0; di < msg.sessionIds.length; di++) {
        var bulkId = msg.sessionIds[di];
        if (typeof bulkId !== "number") continue;
        var bulkTarget = sm.sessions.get(bulkId);
        if (!bulkTarget) continue;
        if (usersModule.isMultiUser() && ws._clayUser) {
          if (!usersModule.canAccessSession(ws._clayUser.id, bulkTarget, { visibility: "public" })) continue;
        }
        deletableIds.push(bulkId);
      }
      if (deletableIds.length > 0) {
        // TUI sessions: stop their jsonl watchers + kill their PTYs
        // before the records are wiped.
        for (var bdi = 0; bdi < deletableIds.length; bdi++) {
          var bdTarget = sm.sessions.get(deletableIds[bdi]);
          if (!bdTarget) continue;
          stopTitleWatcher(bdTarget);
          if (tm && bdTarget.mode === "tui" && typeof bdTarget.terminalId === "number") {
            try { tm.close(bdTarget.terminalId); } catch (e) {}
          }
        }
        sm.deleteSessionsBulk(deletableIds, ws);
      }
      return true;
    }

    if (msg.type === "transfer_project_owner") {
      // Home directory projects: ownership is permanently locked
      if (osUsers && osUsers.length > 0 && /^\/home\/[^/]+\//.test(cwd)) {
        sendTo(ws, { type: "error", text: "Cannot transfer ownership of home directory projects." });
        return true;
      }
      var projectOwnerId = getProjectOwnerId();
      var isAdmin = ws._clayUser && ws._clayUser.role === "admin";
      var isProjectOwner = ws._clayUser && projectOwnerId && ws._clayUser.id === projectOwnerId;
      if (!ws._clayUser || (!isAdmin && !isProjectOwner)) {
        sendTo(ws, { type: "error", text: "Only project owners or admins can transfer ownership." });
        return true;
      }
      var targetUser = msg.userId ? usersModule.findUserById(msg.userId) : null;
      if (!targetUser) {
        sendTo(ws, { type: "error", text: "User not found." });
        return true;
      }
      setProjectOwnerId(targetUser.id);
      // Persist via daemon callback
      if (opts.onProjectOwnerChanged) {
        opts.onProjectOwnerChanged(slug, targetUser.id);
      }
      send({ type: "project_owner_changed", ownerId: targetUser.id, ownerName: targetUser.displayName || targetUser.username });
      return true;
    }

    if (msg.type === "resume_session") {
      if (!msg.cliSessionId) return true;
      var cliSess = require("./cli-sessions");

      // If Clay already has a persisted meta file for this cliSessionId, read
      // its vendor so resumeSession doesn't silently default to the project's
      // primary vendor (which would break codex sessions after server restart).
      var persistedVendor = null;
      try {
        var _fsResume = require("fs");
        var _pathResume = require("path");
        var metaPath = _pathResume.join(sm.sessionsDir, msg.cliSessionId + ".jsonl");
        if (_fsResume.existsSync(metaPath)) {
          var firstLine = _fsResume.readFileSync(metaPath, "utf8").split("\n", 1)[0];
          try {
            var metaObj = JSON.parse(firstLine);
            if (metaObj && metaObj.type === "meta" && metaObj.vendor) persistedVendor = metaObj.vendor;
          } catch (e) {}
        }
      } catch (e) {}

      // Try SDK for title first, then fall back to manual parsing
      var titlePromise = adapter.getSessionInfo(msg.cliSessionId, { dir: cwd }).then(function(info) {
        return (info && info.summary) ? info.summary.substring(0, 100) : null;
      }).catch(function() { return null; });

      Promise.all([
        cliSess.readCliSessionHistory(cwd, msg.cliSessionId),
        titlePromise
      ]).then(function(results) {
        var history = results[0];
        var sdkTitle = results[1];
        var title = sdkTitle || "Resumed session";
        if (!sdkTitle) {
          for (var i = 0; i < history.length; i++) {
            if (history[i].type === "user_message" && history[i].text) {
              title = history[i].text.substring(0, 50);
              break;
            }
          }
        }
        var resumed = sm.resumeSession(msg.cliSessionId, { history: history, title: title, vendor: persistedVendor || undefined }, ws);
        if (resumed) ws._clayActiveSession = resumed.localId;
      }).catch(function() {
        var resumed = sm.resumeSession(msg.cliSessionId, persistedVendor ? { vendor: persistedVendor } : undefined, ws);
        if (resumed) ws._clayActiveSession = resumed.localId;
      });
      return true;
    }

    if (msg.type === "list_cli_sessions") {
      var _fs = require("fs");
      // Collect session IDs already in relay (in-memory + persisted on disk)
      var relayIds = {};
      sm.sessions.forEach(function (s) {
        if (s.cliSessionId) relayIds[s.cliSessionId] = true;
      });
      try {
        var sessDir = sm.sessionsDir;
        var diskFiles = _fs.readdirSync(sessDir);
        for (var fi = 0; fi < diskFiles.length; fi++) {
          if (diskFiles[fi].endsWith(".jsonl")) {
            relayIds[diskFiles[fi].replace(".jsonl", "")] = true;
          }
        }
      } catch (e) {}

      // Default source is the Agent SDK's listSessions, which returns the
      // sessions claude has explicitly indexed. The "show_all" flag opts
      // into a wider filesystem scan that also surfaces conversations the
      // SDK doesn't enumerate (orphans whose Clay record was wiped by old
      // deletion-on-exit code, sessions from before claude's session
      // indexing, etc.) — useful for recovery, noisy by default.
      var showAll = !!msg.show_all;
      var cliSessionsMod = require("./cli-sessions");
      var fsScan = showAll
        ? cliSessionsMod.listCliSessions(cwd).catch(function () { return []; })
        : Promise.resolve([]);
      var sdkScan = adapter.listSessions({ dir: cwd }).catch(function () { return []; });
      Promise.all([fsScan, sdkScan]).then(function (pair) {
        var fsList = pair[0] || [];
        var sdkList = pair[1] || [];
        var sdkById = {};
        for (var si = 0; si < sdkList.length; si++) {
          if (sdkList[si] && sdkList[si].sessionId) sdkById[sdkList[si].sessionId] = sdkList[si];
        }
        var merged = {};
        // Seed with FS scan when showAll is set (authoritative for existence).
        for (var fi = 0; fi < fsList.length; fi++) {
          if (fsList[fi] && fsList[fi].sessionId) merged[fsList[fi].sessionId] = fsList[fi];
        }
        // Always include SDK entries.
        for (var sj = 0; sj < sdkList.length; sj++) {
          var s2 = sdkList[sj];
          if (s2 && s2.sessionId && !merged[s2.sessionId]) merged[s2.sessionId] = s2;
        }
        // Overlay richer SDK fields (summary, gitBranch, etc.) where present.
        var ids = Object.keys(merged);
        var combined = [];
        for (var ki = 0; ki < ids.length; ki++) {
          var entry = merged[ids[ki]];
          var sdkEntry = sdkById[ids[ki]];
          if (sdkEntry) {
            entry = Object.assign({}, entry, {
              firstPrompt: (sdkEntry.summary || sdkEntry.firstPrompt || entry.firstPrompt || ""),
              gitBranch: sdkEntry.gitBranch || entry.gitBranch || null,
              startTime: sdkEntry.createdAt ? new Date(sdkEntry.createdAt).toISOString() : entry.startTime,
              lastActivity: sdkEntry.lastModified ? new Date(sdkEntry.lastModified).toISOString() : entry.lastActivity,
            });
          }
          if (!relayIds[entry.sessionId]) combined.push(entry);
        }
        combined.sort(function (a, b) {
          var ta = a.lastActivity || "";
          var tb = b.lastActivity || "";
          return ta < tb ? 1 : ta > tb ? -1 : 0;
        });
        sendTo(ws, { type: "cli_session_list", sessions: combined });
      });
      return true;
    }

    if (msg.type === "switch_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        // Existing sessions resume in their born mode by default. The one
        // override is the per-user alwaysRestartInTui pref: when on, a
        // born-GUI Claude session opens with a transient runtime PTY running
        // `claude --resume <cliSessionId>` so it renders as TUI without
        // mutating the on-disk record. Flipping the pref back off returns
        // subsequent opens to the GUI chat. Born-TUI sessions are unaffected
        // either way (already TUI). runtimeMode / runtimeTerminalId carry
        // the override out to session_switched and session_list so the
        // client renders without sessions.js needing to know about the pref.
        var xmTarget = sm.sessions.get(msg.id);
        // TUI session with no live PTY: either a spawn_session first-open
        // (use pendingInitialPrompt) or a post-restart resume (use --resume
        // against the cliSessionId, since claude CLI persisted the
        // conversation under ~/.claude/projects/<cwd>/<uuid>.jsonl).
        if (xmTarget && xmTarget.mode === "tui" && !xmTarget.terminalId && tm && xmTarget.cliSessionId) {
          var dlPrompt = xmTarget.pendingInitialPrompt || null;
          var dlPermissionMode = xmTarget.pendingPermissionMode || null;
          var dlEffort = xmTarget.pendingEffort || null;
          if (dlPrompt) {
            delete xmTarget.pendingInitialPrompt;
            delete xmTarget.pendingPermissionMode;
            delete xmTarget.pendingEffort;
          }
          var dlSid = xmTarget.cliSessionId;
          var dlLocalId = xmTarget.localId;
          var dlTitle = xmTarget.title || "session";
          var dlMcpPath = tuiMcp.buildTuiMcpConfig(slug, opts, dlSid);
          var dlCmd;
          if (dlPrompt) {
            // First open of a freshly-spawned session: start a brand-new
            // claude conversation with the prompt pre-supplied. Note: the
            // CLI's --mcp-config flag is variadic ("<configs...>"), so a
            // positional prompt immediately after it gets misparsed as a
            // second config-file path. Use "--" to terminate the options
            // list before the positional prompt.
            dlCmd = "claude --session-id " + dlSid +
              " -n " + tuiMcp.shellQuote(dlTitle);
            if (dlPermissionMode) dlCmd += " --permission-mode " + tuiMcp.shellQuote(dlPermissionMode);
            if (dlEffort) dlCmd += " --effort " + tuiMcp.shellQuote(dlEffort);
            if (dlMcpPath) dlCmd += " --mcp-config " + tuiMcp.shellQuote(dlMcpPath);
            dlCmd += " -- " + tuiMcp.shellQuote(dlPrompt);
          } else {
            // Re-open of an existing TUI session (e.g. after daemon restart
            // or after the user closed the previous xterm): resume the saved
            // conversation rather than starting a new one.
            dlCmd = "claude --resume " + dlSid +
              " -n " + tuiMcp.shellQuote(dlTitle);
            if (dlMcpPath) dlCmd += " --mcp-config " + tuiMcp.shellQuote(dlMcpPath);
          }
          dlCmd += "; exit\n";
          var dlTerm = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
            initialInput: dlCmd,
            kind: "tui-session",
            title: "claude " + dlSid.slice(0, 8),
            onData: makeTuiActivityHook(dlLocalId),
            onExit: function () {
              tuiMcp.cleanupTuiMcpConfig(dlMcpPath);
              // Keep the session record: claude has persisted the
              // conversation and the next open will spawn a fresh --resume.
              var ds = sm.sessions.get(dlLocalId);
              if (ds) {
                ds.terminalId = null;
                try { sm.saveSessionFile(ds); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              }
            },
          });
          if (dlTerm) {
            xmTarget.terminalId = dlTerm.id;
            try { sm.saveSessionFile(xmTarget); } catch (e) {}
            // Tail the per-session jsonl so titles/responses surface in
            // Clay even though the user's running inside the real claude
            // CLI rather than the SDK.
            startTitleWatcher(xmTarget);
          }
        }
        if (xmTarget && (xmTarget.vendor === "claude" || !xmTarget.vendor)) {
          var xmAlwaysTui = getAlwaysRestartInTuiForWs(ws);
          if (xmAlwaysTui && xmTarget.mode === "gui" && xmTarget.cliSessionId) {
            var xmRid = spawnRuntimeTuiPty(xmTarget, ws);
            if (typeof xmRid === "number") {
              xmTarget.runtimeMode = "tui";
              xmTarget.runtimeTerminalId = xmRid;
            } else {
              xmTarget.runtimeMode = null;
              xmTarget.runtimeTerminalId = null;
            }
          } else {
            // Pref is off, born-TUI session, or born-GUI without a
            // cliSessionId to resume against: render in the born mode and
            // close any runtime PTY left over from a prior flip.
            if (typeof xmTarget.runtimeTerminalId === "number" && tm) {
              try { tm.close(xmTarget.runtimeTerminalId); } catch (e) {}
            }
            xmTarget.runtimeMode = null;
            xmTarget.runtimeTerminalId = null;
          }
        } else if (xmTarget) {
          // Non-Claude vendor (Codex etc.): pref does not apply. Still clean
          // up any leaked runtime fields.
          if (typeof xmTarget.runtimeTerminalId === "number" && tm) {
            try { tm.close(xmTarget.runtimeTerminalId); } catch (e) {}
          }
          xmTarget.runtimeMode = null;
          xmTarget.runtimeTerminalId = null;
        }
        // If the target session's vendor doesn't own the currently cached
        // model, clear sm.currentModel so the UI and next query don't leak
        // the previous session's vendor-specific model into this one.
        var switchTargetSess = sm.sessions.get(msg.id);
        if (switchTargetSess && sm.currentModel) {
          var targetVendor = switchTargetSess.vendor || sm.defaultVendor || null;
          var tvModels = (targetVendor && sm.modelsByVendor && sm.modelsByVendor[targetVendor]) || [];
          var found = false;
          var _curLc = sm.currentModel.toLowerCase();
          for (var tvi = 0; tvi < tvModels.length; tvi++) {
            var tvEntry = tvModels[tvi];
            var tvVal = typeof tvEntry === "string" ? tvEntry : (tvEntry && (tvEntry.value || tvEntry.id)) || "";
            if (tvVal === sm.currentModel || (tvVal && (tvVal.toLowerCase().indexOf(_curLc) !== -1 || _curLc.indexOf(tvVal.toLowerCase()) !== -1))) { found = true; break; }
          }
          if (tvModels.length > 0 && !found) {
            sm.currentModel = "";
          }
        }
        // Check access in multi-user mode
        if (usersModule.isMultiUser() && ws._clayUser) {
          var switchTarget = sm.sessions.get(msg.id);
          if (!usersModule.canAccessSession(ws._clayUser.id, switchTarget, { visibility: "public" })) return true;
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs);
          broadcastPresence();
        } else {
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs);
        }
        // Opening a session is the user "serving" its attention request.
        // Clear the flag so the sidebar highlight goes away.
        var openedTarget = sm.sessions.get(msg.id);
        if (openedTarget && openedTarget.needsAttention) {
          openedTarget.needsAttention = null;
          try { sm.saveSessionFile(openedTarget); } catch (e) {}
          try { sm.broadcastSessionList(); } catch (e) {}
        }
        // Send per-session context sources
        if (typeof loadContextSources === "function") {
          var switchedSources = loadContextSources(slug, msg.id);
          sendTo(ws, { type: "context_sources_state", active: switchedSources });
        }
        var swPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        userPresence.setPresence(slug, swPresKey, msg.id, null);
      }
      return true;
    }

    if (msg.type === "set_mate_dm") {
      // Only store mateDm on non-mate projects (main project presence).
      // Mate projects should never hold mateDm to avoid circular restore loops.
      if (!isMate) {
        var dmPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        userPresence.setMateDm(slug, dmPresKey, msg.mateId || null);
      }
      return true;
    }

    if (msg.type === "delete_session") {
      if (ws._clayUser) {
        var sdPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!sdPerms.sessionDelete) {
          sendTo(ws, { type: "error", text: "You do not have permission to delete sessions" });
          return true;
        }
      }
      if (msg.id && sm.sessions.has(msg.id)) {
        // TUI session: kill the underlying PTY + stop the jsonl watcher
        // before deleting the session record so we don't leak file handles
        // or leave a `claude` process orphaned.
        var dsTarget = sm.sessions.get(msg.id);
        if (dsTarget) stopTitleWatcher(dsTarget);
        if (dsTarget && dsTarget.mode === "tui" && typeof dsTarget.terminalId === "number" && tm) {
          try { tm.close(dsTarget.terminalId); } catch (e) {}
        }
        sm.deleteSession(msg.id, ws);
      }
      return true;
    }

    if (msg.type === "rename_session") {
      if (msg.id && sm.sessions.has(msg.id) && msg.title) {
        var s = sm.sessions.get(msg.id);
        s.title = String(msg.title).substring(0, 100);
        s.titleManuallySet = true;
        sm.saveSessionFile(s);
        sm.broadcastSessionList();
        // Sync title to SDK session
        if (s.cliSessionId) {
          adapter.renameSession(s.cliSessionId, s.title, { dir: cwd }).catch(function(e) {
            console.error("[project] SDK renameSession failed:", e.message);
          });
        }
      }
      return true;
    }

    if (msg.type === "search_sessions") {
      var results = sm.searchSessions(msg.query || "");
      sendTo(ws, { type: "search_results", query: msg.query || "", results: results });
      return true;
    }

    if (msg.type === "search_session_content") {
      var targetSession = msg.id ? sm.sessions.get(msg.id) : getSessionForWs(ws);
      if (!targetSession) return true;
      var contentResults = sm.searchSessionContent(targetSession.localId, msg.query || "");
      var searchResp = { type: "search_content_results", query: msg.query || "", sessionId: targetSession.localId, hits: contentResults.hits, total: contentResults.total };
      if (msg.source) searchResp.source = msg.source;
      sendTo(ws, searchResp);
      return true;
    }

    if (msg.type === "set_update_channel") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      var newChannel = msg.channel === "beta" ? "beta" : "stable";
      setUpdateChannel(newChannel);
      setLatestVersion(null);
      if (typeof opts.onSetUpdateChannel === "function") {
        opts.onSetUpdateChannel(newChannel);
      }
      // Re-fetch with new channel and broadcast to admin clients
      fetchVersion(newChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          setLatestVersion(v);
          sendToAdmins({ type: "update_available", version: v });
        }
      }).catch(function () {});
      return true;
    }

    if (msg.type === "check_update") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      var updateChannel = getUpdateChannel();
      fetchVersion(updateChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          setLatestVersion(v);
          sendTo(ws, { type: "update_available", version: v });
        } else {
          sendTo(ws, { type: "up_to_date", version: currentVersion });
        }
      }).catch(function () {});
      return true;
    }

    if (msg.type === "update_now") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      send({ type: "update_started", version: getLatestVersion() || "" });
      var _ipc = require("./ipc");
      var _config = require("./config");
      _ipc.sendIPCCommand(_config.socketPath(), { cmd: "update" });
      return true;
    }

    if (msg.type === "process_stats") {
      var sessionCount = sm.sessions.size;
      var processingCount = 0;
      sm.sessions.forEach(function (s) {
        if (s.isProcessing) processingCount++;
      });
      var mem = process.memoryUsage();
      sendTo(ws, {
        type: "process_stats",
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        sessions: sessionCount,
        processing: processingCount,
        clients: clients.size,
        terminals: tm.list().length,
      });
      return true;
    }

    if (msg.type === "stop") {
      var session = getSessionForWs(ws);
      if (session && session.isProcessing) {
        session.taskStopRequested = true;
        if (session.abortController) session.abortController.abort();
      }
      return true;
    }

    if (msg.type === "stop_task") {
      if (msg.taskId) {
        sdk.stopTask(msg.taskId);
      }
      return true;
    }

    if (msg.type === "kill_process") {
      var pid = msg.pid;
      if (!pid || typeof pid !== "number") return true;
      // Verify target is actually a claude process before killing
      if (!sdk.isClaudeProcess(pid)) {
        console.error("[project] Refused to kill PID " + pid + ": not a claude process");
        sendTo(ws, { type: "error", text: "Process " + pid + " is not a Claude process." });
        return true;
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log("[project] Sent SIGTERM to conflicting Claude process PID " + pid);
        sendTo(ws, { type: "process_killed", pid: pid });
      } catch (e) {
        console.error("[project] Failed to kill PID " + pid + ":", e.message);
        sendTo(ws, { type: "error", text: "Failed to kill process " + pid + ": " + (e.message || e) });
      }
      return true;
    }

    if (msg.type === "set_model" && msg.model) {
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "set_vendor" && msg.vendor) {
      var vendorSession = getSessionForWs(ws);
      if (vendorSession) {
        // Refuse to rebind vendor on a session that is already bound to a
        // different CLI (cliSessionId is vendor-specific). This prevents a
        // stale client-side vendor state from clobbering the persisted vendor
        // on page reload / server restart.
        var alreadyBound = vendorSession.cliSessionId && vendorSession.vendor && vendorSession.vendor !== msg.vendor;
        if (alreadyBound) {
          console.warn("[project] set_vendor ignored: session " + vendorSession.localId +
            " is bound to '" + vendorSession.vendor + "', refused rebind to '" + msg.vendor + "'");
        } else {
          vendorSession.vendor = msg.vendor;
          // Clear the shared model so the next query uses the vendor's default
          // instead of leaking the previous vendor's model into a fresh session.
          if (sm.currentModel) {
            sm.currentModel = "";
          }
          sm.saveSessionFile(vendorSession);
          sm.broadcastSessionList();
        }
      }
      if (msg.vendor) {
        var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
        sendTo(ws, {
          type: "model_info",
          model: "",
          models: vendorModels,
          vendor: msg.vendor,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
        });
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      }
      return true;
    }

    if (msg.type === "set_server_default_model" && msg.model) {
      if (typeof opts.onSetServerDefaultModel === "function") {
        opts.onSetServerDefaultModel(msg.model);
      }
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "set_project_default_model" && msg.model) {
      if (typeof opts.onSetProjectDefaultModel === "function") {
        opts.onSetProjectDefaultModel(slug, msg.model);
      }
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setModel(session, msg.model);
      }
      return true;
    }

    if (msg.type === "set_permission_mode" && msg.mode) {
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_server_default_mode" && msg.mode) {
      if (typeof opts.onSetServerDefaultMode === "function") {
        opts.onSetServerDefaultMode(msg.mode);
      }
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_mode" && msg.mode) {
      if (typeof opts.onSetProjectDefaultMode === "function") {
        opts.onSetProjectDefaultMode(slug, msg.mode);
      }
      sm.currentPermissionMode = msg.mode;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setPermissionMode(session, msg.mode);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_effort" && msg.effort) {
      sm.currentEffort = msg.effort;
      var session = getSessionForWs(ws);
      if (session) {
        sdk.setEffort(session, msg.effort);
      }
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_server_default_effort" && msg.effort) {
      if (typeof opts.onSetServerDefaultEffort === "function") {
        opts.onSetServerDefaultEffort(msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_project_default_effort" && msg.effort) {
      if (typeof opts.onSetProjectDefaultEffort === "function") {
        opts.onSetProjectDefaultEffort(slug, msg.effort);
      }
      sm.currentEffort = msg.effort;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_betas") {
      sm.currentBetas = msg.betas || [];
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas, thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    if (msg.type === "set_thinking") {
      sm.currentThinking = msg.thinking || "adaptive";
      if (msg.budgetTokens) sm.currentThinkingBudget = msg.budgetTokens;
      send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
      return true;
    }

    // Codex-specific settings (stored on sessionManager, passed to adapter via adapterOptions)
    if (msg.type === "set_codex_approval") {
      sm.codexApproval = msg.approval || CODEX_DEFAULTS.approval;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }
    if (msg.type === "set_codex_sandbox") {
      sm.codexSandbox = msg.sandbox || CODEX_DEFAULTS.sandbox;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }
    if (msg.type === "set_codex_websearch") {
      sm.codexWebSearch = msg.webSearch || CODEX_DEFAULTS.webSearch;
      send(Object.assign({ type: "codex_config" }, getCodexConfig(sm)));
      return true;
    }

    if (msg.type === "rewind_preview") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      if (session._rewindInProgress) return true;

      (async function () {
        try {
          var r = await sdk.rewindPreview(session, msg.uuid);
          sendTo(ws, { type: "rewind_preview_result", preview: r.preview, diffs: r.diffs, uuid: msg.uuid, chatOnly: r.chatOnly || false });
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Failed to preview rewind: " + err.message });
        }
      })();
      return true;
    }

    if (msg.type === "rewind_execute") {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId || !msg.uuid) return true;
      // Guard against concurrent rewind executions
      if (session._rewindInProgress) {
        sendTo(ws, { type: "rewind_error", text: "Rewind already in progress." });
        return true;
      }
      session._rewindInProgress = true;
      var mode = msg.mode || "both";

      (async function () {
        try {
          // File restoration (delegated to adapter via sdk-bridge)
          if (mode !== "chat") {
            await sdk.rewindExecuteFiles(session, msg.uuid);
          }

          // Conversation rollback (skip for files-only mode)
          if (mode !== "files") {
            var targetIdx = -1;
            for (var i = 0; i < session.messageUUIDs.length; i++) {
              if (session.messageUUIDs[i].uuid === msg.uuid) {
                targetIdx = i;
                break;
              }
            }

            // Count turns to roll back BEFORE trimming local history
            var turnsToRollBack = 0;
            if (targetIdx >= 0) {
              for (var ri = targetIdx; ri < session.messageUUIDs.length; ri++) {
                if (session.messageUUIDs[ri].type === "user") turnsToRollBack++;
              }
            }

            if (targetIdx >= 0) {
              var trimTo = session.messageUUIDs[targetIdx].historyIndex;
              for (var k = trimTo - 1; k >= 0; k--) {
                if (session.history[k].type === "user_message") {
                  trimTo = k;
                  break;
                }
              }
              session.history = session.history.slice(0, trimTo);
              session.messageUUIDs = session.messageUUIDs.slice(0, targetIdx);
              // Reset digest checkpoint if it points past the trimmed history
              if (typeof session._dmLastDigestedIndex === "number" && session._dmLastDigestedIndex > trimTo) {
                session._dmLastDigestedIndex = trimTo;
              }
            }

            // Notify adapter of conversation rollback (e.g. Codex thread/rollback)
            if (turnsToRollBack > 0) {
              try {
                await sdk.rollbackConversation(session, turnsToRollBack);
              } catch (rbErr) {
                console.error("[project-sessions] conversation rollback failed:", rbErr.message || rbErr);
              }
            }

            var kept = session.messageUUIDs;
            session.lastRewindUuid = kept.length > 0 ? kept[kept.length - 1].uuid : null;
          }

          if (session.abortController) {
            try { session.abortController.abort(); } catch (e) {}
          }
          if (session.messageQueue) {
            try { session.messageQueue.end(); } catch (e) {}
          }
          session.queryInstance = null;
          session.messageQueue = null;
          session.abortController = null;
          session.blocks = {};
          session.sentToolResults = {};
          session.pendingPermissions = {};
          session.pendingAskUser = {};
          session.isProcessing = false;
          onProcessingChanged();

          sm.saveSessionFile(session);
          sm.switchSession(session.localId, ws, hydrateImageRefs);
          sm.sendAndRecord(session, { type: "rewind_complete", mode: mode });
          sm.broadcastSessionList();
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Rewind failed: " + err.message });
        } finally {
          session._rewindInProgress = false;
        }
      })();
      return true;
    }

    if (msg.type === "fork_session" && msg.uuid) {
      var session = getSessionForWs(ws);
      if (!session || !session.cliSessionId) {
        sendTo(ws, { type: "error", text: "Cannot fork: no CLI session" });
        return true;
      }
      var forkTitle = (session.title || "New Session") + " (fork)";

      sdk.forkSession(session, msg.uuid).then(function(result) {
        if (result.useLocalHistory) {
          // Copy local history up to the target UUID
          var targetIdx = -1;
          for (var fi = 0; fi < session.messageUUIDs.length; fi++) {
            if (session.messageUUIDs[fi].uuid === msg.uuid) { targetIdx = fi; break; }
          }
          var forkHistory = [];
          if (targetIdx >= 0) {
            var trimTo = session.messageUUIDs[targetIdx].historyIndex;
            forkHistory = session.history.slice(0, trimTo);
          } else {
            forkHistory = session.history.slice();
          }
          var forked = sm.createSession({ vendor: session.vendor, ownerId: session.ownerId || null }, ws);
          forked.cliSessionId = result.sessionId;
          forked.title = forkTitle;
          forked.history = forkHistory;
          forked.messageUUIDs = [];
          for (var hi = 0; hi < forkHistory.length; hi++) {
            if (forkHistory[hi].type === "message_uuid") {
              forked.messageUUIDs.push({ uuid: forkHistory[hi].uuid, type: forkHistory[hi].messageType, historyIndex: hi });
            }
          }
          sm.saveSessionFile(forked);
          sm.switchSession(forked.localId, ws, hydrateImageRefs);
          sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
          sm.broadcastSessionList();
        } else {
          // Read history from CLI session files
          var cliSess = require("./cli-sessions");
          return cliSess.readCliSessionHistory(cwd, result.sessionId).then(function(history) {
            var forked = sm.resumeSession(result.sessionId, { history: history, title: forkTitle }, ws);
            if (forked) {
              ws._clayActiveSession = forked.localId;
              sendTo(ws, { type: "fork_complete", sessionId: forked.localId });
            }
          });
        }
      }).catch(function(e) {
        sendTo(ws, { type: "error", text: "Fork failed: " + (e.message || e) });
      });
      return true;
    }

    if (msg.type === "ask_user_response") {
      var session = getSessionForWs(ws);
      if (!session) return true;
      var toolId = msg.toolId;
      var answers = msg.answers || {};
      var pending = session.pendingAskUser[toolId];
      if (!pending) return true;
      delete session.pendingAskUser[toolId];
      sm.sendAndRecord(session, { type: "ask_user_answered", toolId: toolId, answers: answers });

      if (pending.mode === "mcp") {
        // Stateless MCP path: the tool already returned. Inject the user's
        // answer as a new user message so the conversation continues
        // naturally on the next turn. This matches how the mate would see
        // any other user input.
        var answerText = formatAskUserAnswerAsMessage(pending.input, answers);
        var userMsg = { type: "user_message", text: answerText };
        session.history.push(userMsg);
        sm.appendToSessionFile(session, userMsg);
        sendToSession(session.localId, userMsg);

        if (!session.isProcessing) {
          session.isProcessing = true;
          onProcessingChanged();
          session.sentToolResults = {};
          sendToSession(session.localId, { type: "status", status: "processing" });
          if (!session.queryInstance && !session.worker) {
            sdk.startQuery(session, answerText, undefined, ensureProjectAccessForSession(session));
          } else {
            sdk.pushMessage(session, answerText);
          }
        } else {
          // Turn is still running; queue for the next turn.
          sdk.pushMessage(session, answerText);
        }
      } else {
        // Claude native AskUserQuestion path (canUseTool). The SDK's
        // AskUserQuestionOutput schema keys answers by question text, not
        // by the numeric index the UI sends. Remap before resolving or
        // the model receives blank answers.
        var qs = (pending.input && Array.isArray(pending.input.questions)) ? pending.input.questions : [];
        var answersByText = {};
        for (var qi = 0; qi < qs.length; qi++) {
          var qText = (qs[qi] && qs[qi].question) ? qs[qi].question : ("Question " + (qi + 1));
          var av = (answers[qi] != null) ? answers[qi] : answers[String(qi)];
          if (av != null) answersByText[qText] = String(av);
        }
        pending.resolve({
          behavior: "allow",
          updatedInput: Object.assign({}, pending.input, { answers: answersByText }),
        });
      }
      return true;
    }

    if (msg.type === "input_sync") {
      sendToSessionOthers(ws, ws._clayActiveSession, msg);
      return true;
    }

    if (msg.type === "cursor_move" || msg.type === "cursor_leave" || msg.type === "text_select") {
      if (!usersModule.isMultiUser() || !ws._clayUser) return true;
      var u = ws._clayUser;
      var p = u.profile || {};
      var cursorMsg = {
        type: msg.type,
        userId: u.id,
        displayName: p.name || u.displayName || u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
        avatarCustom: p.avatarCustom || "",
      };
      if (msg.type === "cursor_move") {
        cursorMsg.turn = msg.turn;
        if (msg.rx != null) cursorMsg.rx = msg.rx;
        if (msg.ry != null) cursorMsg.ry = msg.ry;
      }
      if (msg.type === "text_select") {
        cursorMsg.ranges = msg.ranges || [];
      }
      sendToSessionOthers(ws, ws._clayActiveSession, cursorMsg);
      return true;
    }

    if (msg.type === "permission_response") {
      var requestId = msg.requestId;
      var decision = msg.decision;
      // Look up session by requestId index (O(1)), fall back to active session
      var sessionId = sm.permissionRequestIndex[requestId];
      var session = sessionId ? sm.sessions.get(sessionId) : getSessionForWs(ws);
      if (!session) return true;
      var pending = session.pendingPermissions[requestId];
      if (!pending) return true;
      delete sm.permissionRequestIndex[requestId];
      delete session.pendingPermissions[requestId];
      onProcessingChanged(); // update cross-project permission badge

      // --- Plan approval: "allow_accept_edits" -- approve + switch to acceptEdits mode ---
      if (decision === "allow_accept_edits") {
        sdk.setPermissionMode(session, "acceptEdits");
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });
        return true;
      }

      // --- Plan approval: "allow_clear_context" -- new session + plan as first message + acceptEdits ---
      if (decision === "allow_clear_context") {
        // Deny current plan to end the turn
        pending.resolve({ behavior: "deny", message: "User chose to clear context and restart" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Abort the old session's query -- but defer to next tick so the SDK's
        // deny write (scheduled as microtask by pending.resolve) completes first.
        // Aborting synchronously would kill the subprocess before the write,
        // causing an "Operation aborted" crash in the SDK.
        session.isProcessing = false;
        onProcessingChanged();
        session.pendingPermissions = {};
        session.pendingAskUser = {};
        sm.broadcastSessionList();
        setImmediate(function () {
          if (session.abortController) {
            session.abortController.abort();
          }
        });

        // Update permission mode for the new session
        sm.currentPermissionMode = "acceptEdits";
        send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [], thinking: sm.currentThinking || "adaptive", thinkingBudget: sm.currentThinkingBudget || 10000 });

        // Build prompt from plan content (sent from client) or plan file path
        var clientPlanContent = msg.planContent || "";
        var planPrompt;
        if (clientPlanContent) {
          planPrompt = "Execute the following plan. Do NOT re-enter plan mode -- just implement it step by step.\n\n" + clientPlanContent;
        } else {
          var planFilePath = (pending.toolInput && pending.toolInput.planFilePath) || "";
          planPrompt = "Execute the plan in " + planFilePath + ". Do NOT re-enter plan mode -- read the plan file and implement it step by step.";
        }

        // Wait for old query stream to fully terminate, then create new session + send plan
        var oldStreamPromise = session.streamPromise || Promise.resolve();
        Promise.race([
          oldStreamPromise,
          new Promise(function (resolve) { setTimeout(resolve, 3000); }),
        ]).then(function () {
          try {
            var newSession = sm.createSession(null, ws);
            // Send the plan as the first user message (with planContent for UI rendering)
            var userMsg = { type: "user_message", text: planPrompt, planContent: clientPlanContent || null };
            newSession.history.push(userMsg);
            sm.appendToSessionFile(newSession, userMsg);
            newSession.title = "Plan execution (cleared context)";
            sm.saveSessionFile(newSession);
            sm.broadcastSessionList();
            sendToSession(newSession.localId, userMsg);

            newSession.isProcessing = true;
            onProcessingChanged();
            newSession.sentToolResults = {};
            sendToSession(newSession.localId, { type: "status", status: "processing" });
            newSession.acceptEditsAfterStart = true;
            sdk.startQuery(newSession, planPrompt, undefined, ensureProjectAccessForSession(newSession));
          } catch (e) {
            console.error("[project] Error starting plan execution:", e);
            sendTo(ws, { type: "error", text: "Failed to start plan execution: " + (e.message || e) });
          }
        }).catch(function (e) {
          console.error("[project] Plan execution stream wait failed:", e.message || e);
        });
        return true;
      }

      // --- Plan approval: "deny_with_feedback" -- deny + send feedback as follow-up message ---
      if (decision === "deny_with_feedback") {
        var feedback = msg.feedback || "";
        pending.resolve({ behavior: "deny", message: feedback || "User provided feedback" });
        sm.sendAndRecord(session, { type: "permission_resolved", requestId: requestId, decision: decision });

        // Send feedback as next user message if there's text
        if (feedback) {
          setTimeout(function () {
            var userMsg = { type: "user_message", text: feedback };
            session.history.push(userMsg);
            sm.appendToSessionFile(session, userMsg);
            sendToSession(session.localId, userMsg);

            if (!session.isProcessing) {
              session.isProcessing = true;
              onProcessingChanged();
              session.sentToolResults = {};
              sendToSession(session.localId, { type: "status", status: "processing" });
              if (!session.queryInstance && !session.worker) {
                sdk.startQuery(session, feedback, undefined, ensureProjectAccessForSession(session));
              } else {
                sdk.pushMessage(session, feedback);
              }
            } else {
              sdk.pushMessage(session, feedback);
            }
          }, 200);
        }
        return true;
      }

      if (decision === "allow" || decision === "allow_always") {
        if (decision === "allow_always") {
          if (!session.allowedTools) session.allowedTools = {};
          session.allowedTools[pending.toolName] = true;
        }
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "User denied permission" });
      }

      sm.sendAndRecord(session, {
        type: "permission_resolved",
        requestId: requestId,
        decision: decision,
      });
      return true;
    }

    // --- MCP elicitation response ---
    if (msg.type === "elicitation_response") {
      var session = getSessionForWs(ws);
      if (!session) return true;
      var pending = session.pendingElicitations && session.pendingElicitations[msg.requestId];
      if (!pending) return true;
      delete session.pendingElicitations[msg.requestId];
      if (msg.action === "accept") {
        pending.resolve({ action: "accept", content: msg.content || {} });
      } else {
        pending.resolve({ action: "reject" });
      }
      sm.sendAndRecord(session, {
        type: "elicitation_resolved",
        requestId: msg.requestId,
        action: msg.action,
      });
      return true;
    }

    // --- Browse directories (for add-project autocomplete) ---
    if (msg.type === "browse_dir") {
      var rawPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
      var absTarget = path.resolve(rawPath);
      // Multi-user mode: non-admins can only browse their home directory
      if (osUsers && osUsers.length > 0 && ws._clayUser && ws._clayUser.role !== "admin") {
        var browseHome = ws._clayUser.linuxUser ? "/home/" + ws._clayUser.linuxUser : null;
        if (!browseHome || (absTarget !== browseHome && (absTarget + "/").indexOf(browseHome + "/") !== 0)) {
          sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: "Access restricted to your home directory" });
          return true;
        }
      }
      var parentDir, prefix;
      try {
        var stat = fs.statSync(absTarget);
        if (stat.isDirectory()) {
          // Input is an existing directory -- list its children
          parentDir = absTarget;
          prefix = "";
        } else {
          parentDir = path.dirname(absTarget);
          prefix = path.basename(absTarget).toLowerCase();
        }
      } catch (e) {
        // Path doesn't exist -- list parent and filter by typed prefix
        parentDir = path.dirname(absTarget);
        prefix = path.basename(absTarget).toLowerCase();
      }
      try {
        var dirItems = fs.readdirSync(parentDir, { withFileTypes: true });
        var dirEntries = [];
        for (var di = 0; di < dirItems.length; di++) {
          var d = dirItems[di];
          if (!d.isDirectory()) continue;
          if (d.name.charAt(0) === ".") continue;
          if (IGNORED_DIRS.has(d.name)) continue;
          if (prefix && !d.name.toLowerCase().startsWith(prefix)) continue;
          dirEntries.push({ name: d.name, path: path.join(parentDir, d.name) });
        }
        dirEntries.sort(function (a, b) { return a.name.localeCompare(b.name); });
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: dirEntries });
      } catch (e) {
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: e.message });
      }
      return true;
    }

    // --- Add project from web UI ---
    if (msg.type === "add_project") {
      var addPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
      var addAbs = path.resolve(addPath);
      // Multi-user mode: normal users restricted to their home directory
      if (osUsers && osUsers.length > 0 && ws._clayUser && ws._clayUser.role !== "admin") {
        if (!ws._clayUser.linuxUser) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "No Linux user assigned" });
          return true;
        }
        var userHome = "/home/" + ws._clayUser.linuxUser;
        if (addAbs !== userHome && (addAbs + "/").indexOf(userHome + "/") !== 0) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Path not allowed. You can only add directories under " + userHome });
          return true;
        }
      }
      try {
        var addStat = fs.statSync(addAbs);
        if (!addStat.isDirectory()) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Not a directory" });
          return true;
        }
      } catch (e) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Directory not found" });
        return true;
      }
      if (typeof opts.onAddProject === "function") {
        var result = opts.onAddProject(addAbs, ws._clayUser);
        sendTo(ws, { type: "add_project_result", ok: result.ok, slug: result.slug, error: result.error, existing: result.existing });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Create new empty project ---
    if (msg.type === "create_project" || msg.type === "clone_project") {
      if (ws._clayUser) {
        var cpPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!cpPerms.createProject) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "You do not have permission to create projects" });
          return true;
        }
      }
    }
    if (msg.type === "create_project") {
      var createName = (msg.name || "").trim();
      if (!createName || !/^[a-zA-Z0-9_-]+$/.test(createName)) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid name. Use only letters, numbers, dashes, and underscores." });
        return true;
      }
      if (typeof opts.onCreateProject === "function") {
        var createResult = opts.onCreateProject(createName, ws._clayUser);
        sendTo(ws, { type: "add_project_result", ok: createResult.ok, slug: createResult.slug, error: createResult.error });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Clone project from GitHub ---
    if (msg.type === "clone_project") {
      var cloneUrl = (msg.url || "").trim();
      if (!cloneUrl || (!/^https?:\/\//.test(cloneUrl) && !/^git@/.test(cloneUrl))) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid URL. Use https:// or git@ format." });
        return true;
      }
      sendTo(ws, { type: "clone_project_progress", status: "cloning" });
      if (typeof opts.onCloneProject === "function") {
        opts.onCloneProject(cloneUrl, ws._clayUser, function (cloneResult) {
          sendTo(ws, { type: "add_project_result", ok: cloneResult.ok, slug: cloneResult.slug, error: cloneResult.error });
        });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Create worktree from web UI ---
    if (msg.type === "create_worktree") {
      var wtBranch = (msg.branch || "").trim();
      var wtDirName = (msg.dirName || "").trim() || wtBranch.replace(/\//g, "-");
      var wtBase = (msg.baseBranch || "").trim() || null;
      if (!wtBranch || !/^[a-zA-Z0-9_\/.@-]+$/.test(wtBranch)) {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Invalid branch name" });
        return true;
      }
      if (typeof onCreateWorktree === "function") {
        var wtResult = onCreateWorktree(slug, wtBranch, wtDirName, wtBase);
        sendTo(ws, { type: "create_worktree_result", ok: wtResult.ok, slug: wtResult.slug, error: wtResult.error });
      } else {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Pre-check: does the project have tasks/schedules? ---
    if (msg.type === "remove_project_check") {
      var checkSlug = msg.slug;
      if (!checkSlug) {
        sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: 0 });
        return true;
      }
      var schedCount = getScheduleCount(checkSlug);
      sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: schedCount });
      return true;
    }

    // --- Remove project from web UI ---
    if (msg.type === "remove_project") {
      if (ws._clayUser) {
        var dpPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!dpPerms.deleteProject) {
          sendTo(ws, { type: "remove_project_result", ok: false, error: "You do not have permission to delete projects" });
          return true;
        }
      }
      var removeSlug = msg.slug;
      if (!removeSlug) {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Missing slug" });
        return true;
      }
      // If client chose to move tasks to another project before removing
      if (msg.moveTasksTo) {
        moveAllSchedulesToProject(removeSlug, msg.moveTasksTo);
      }
      if (typeof opts.onRemoveProject === "function") {
        // Send result before removing so the WS is still open
        sendTo(ws, { type: "remove_project_result", ok: true, slug: removeSlug });
        var removeUserId = ws._clayUser ? ws._clayUser.id : null;
        opts.onRemoveProject(removeSlug, removeUserId);
      } else {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Move a single schedule to another project ---
    if (msg.type === "schedule_move") {
      var moveResult = moveScheduleToProject(msg.recordId, msg.fromSlug, msg.toSlug);
      if (moveResult.ok) {
        // Re-broadcast updated records to this project's clients
        send({ type: "loop_registry_updated", records: getHubSchedules() });
      }
      sendTo(ws, { type: "schedule_move_result", ok: moveResult.ok, error: moveResult.error });
      return true;
    }

    // --- Reorder projects ---
    if (msg.type === "reorder_projects") {
      var slugs = msg.slugs;
      if (!Array.isArray(slugs) || slugs.length === 0) {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Missing slugs" });
        return true;
      }
      if (typeof opts.onReorderProjects === "function") {
        var reorderResult = opts.onReorderProjects(slugs);
        sendTo(ws, { type: "reorder_projects_result", ok: reorderResult.ok, error: reorderResult.error });
      } else {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project title (rename) ---
    if (msg.type === "set_project_title") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectTitle === "function") {
        var titleResult = opts.onSetProjectTitle(msg.slug, msg.title || null);
        sendTo(ws, { type: "set_project_title_result", ok: titleResult.ok, slug: msg.slug, error: titleResult.error });
      } else {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project icon (emoji) ---
    if (msg.type === "set_project_icon") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectIcon === "function") {
        var iconResult = opts.onSetProjectIcon(msg.slug, msg.icon || null);
        sendTo(ws, { type: "set_project_icon_result", ok: iconResult.ok, slug: msg.slug, error: iconResult.error });
      } else {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Set project label (icon-strip text override) ---
    if (msg.type === "set_project_label") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_label_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectLabel === "function") {
        var labelResult = opts.onSetProjectLabel(msg.slug, msg.label || null);
        sendTo(ws, { type: "set_project_label_result", ok: labelResult.ok, slug: msg.slug, label: (msg.label || null), error: labelResult.error });
      } else {
        sendTo(ws, { type: "set_project_label_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    // --- Daemon config / server management (admin-only in multi-user mode) ---
    if (msg.type === "get_daemon_config" || msg.type === "set_pin" || msg.type === "set_keep_awake" ||
        msg.type === "set_auto_continue" || msg.type === "set_image_retention" || msg.type === "shutdown_server" || msg.type === "restart_server") {
      if (usersModule.isMultiUser()) {
        var _wsUser = ws._clayUser;
        if (!_wsUser || _wsUser.role !== "admin") {
          sendTo(ws, { type: "error", message: "Admin access required" });
          return true;
        }
      }
    }

    if (msg.type === "get_daemon_config") {
      if (typeof opts.onGetDaemonConfig === "function") {
        var daemonConfig = opts.onGetDaemonConfig();
        sendTo(ws, { type: "daemon_config", config: daemonConfig });
      }
      return true;
    }

    if (msg.type === "set_pin") {
      if (typeof opts.onSetPin === "function") {
        var pinResult = opts.onSetPin(msg.pin || null);
        sendTo(ws, { type: "set_pin_result", ok: pinResult.ok, pinEnabled: pinResult.pinEnabled });
      }
      return true;
    }

    if (msg.type === "set_keep_awake") {
      if (typeof opts.onSetKeepAwake === "function") {
        var kaResult = opts.onSetKeepAwake(msg.value);
        sendTo(ws, { type: "set_keep_awake_result", ok: kaResult.ok, keepAwake: kaResult.keepAwake });
        send({ type: "keep_awake_changed", keepAwake: kaResult.keepAwake });
      }
      return true;
    }

    if (msg.type === "set_auto_continue") {
      if (typeof opts.onSetAutoContinue === "function") {
        var acResult = opts.onSetAutoContinue(msg.value);
        sendTo(ws, { type: "set_auto_continue_result", ok: acResult.ok, autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
        send({ type: "auto_continue_changed", autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
      }
      return true;
    }

    if (msg.type === "set_claude_open_mode") {
      // Per-user preference: when Clay opens a Claude session, render it as
      // the SDK-driven custom chat ("gui") or as an embedded `claude` TUI
      // ("tui"). Applies to the next session open; currently displayed
      // sessions are not re-rendered retroactively. In single-user mode the
      // userId is null and the setter falls through to daemon.json storage.
      var comUserId = ws._clayUser ? ws._clayUser.id : null;
      var comResult = usersModule.setClaudeOpenMode(comUserId, msg.value);
      if (comResult && comResult.ok) {
        sendTo(ws, { type: "set_claude_open_mode_result", ok: true, claudeOpenMode: comResult.claudeOpenMode });
        // Echo as a "changed" broadcast for this user's other tabs/devices.
        sendTo(ws, { type: "claude_open_mode_changed", claudeOpenMode: comResult.claudeOpenMode });
      } else {
        sendTo(ws, { type: "set_claude_open_mode_result", ok: false, error: (comResult && comResult.error) || "unknown" });
      }
      return true;
    }

    if (msg.type === "set_always_restart_in_tui") {
      // Per-user preference: when on, resuming a born-GUI Claude session
      // spawns a transient runtime PTY so it renders as TUI without mutating
      // the on-disk session. Default on. Takes effect on the next session
      // open (or pref flip). In single-user mode the userId is null and the
      // setter falls through to daemon.json storage.
      var artUserId = ws._clayUser ? ws._clayUser.id : null;
      var artResult = usersModule.setAlwaysRestartInTui(artUserId, !!msg.value);
      if (artResult && artResult.ok) {
        sendTo(ws, { type: "set_always_restart_in_tui_result", ok: true, alwaysRestartInTui: artResult.alwaysRestartInTui });
        sendTo(ws, { type: "always_restart_in_tui_changed", alwaysRestartInTui: artResult.alwaysRestartInTui });
      } else {
        sendTo(ws, { type: "set_always_restart_in_tui_result", ok: false, error: (artResult && artResult.error) || "unknown" });
      }
      return true;
    }

    if (msg.type === "set_show_codex") {
      // Daemon-wide toggle: hide the Codex new-session button (and other
      // Codex-specific UI surfaces) unless explicitly enabled. Defaults
      // off. Modeled on the matesEnabled daemon setting.
      if (typeof opts.onSetShowCodex === "function") {
        var scResult = opts.onSetShowCodex(!!msg.value);
        sendTo(ws, { type: "set_show_codex_result", ok: !!(scResult && scResult.ok), showCodex: !!(scResult && scResult.showCodex) });
      } else {
        sendTo(ws, { type: "set_show_codex_result", ok: false, error: "not_supported" });
      }
      return true;
    }

    if (msg.type === "set_image_retention") {
      if (typeof opts.onSetImageRetention === "function") {
        var irResult = opts.onSetImageRetention(msg.days);
        sendTo(ws, { type: "set_image_retention_result", ok: irResult.ok, days: irResult.days });
      }
      return true;
    }

    if (msg.type === "shutdown_server") {
      if (typeof opts.onShutdown === "function") {
        sendTo(ws, { type: "shutdown_server_result", ok: true });
        send({ type: "toast", level: "warn", message: "Server is shutting down..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onShutdown();
        }, 500);
      } else {
        sendTo(ws, { type: "shutdown_server_result", ok: false, error: "Shutdown not supported" });
      }
      return true;
    }

    if (msg.type === "restart_server") {
      if (typeof opts.onRestart === "function") {
        sendTo(ws, { type: "restart_server_result", ok: true });
        send({ type: "toast", level: "info", message: "Server is restarting..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onRestart();
        }, 500);
      } else {
        sendTo(ws, { type: "restart_server_result", ok: false, error: "Restart not supported" });
      }
      return true;
    }

    return false;
  }

  return {
    handleSessionsMessage: handleSessionsMessage,
  };
}

module.exports = { attachSessions: attachSessions };
