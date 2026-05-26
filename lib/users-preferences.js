function attachPreferences(deps) {
  var loadUsers = deps.loadUsers;
  var saveUsers = deps.saveUsers;

  // --- DM Favorites ---

  function getDmFavorites(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].dmFavorites || [];
      }
    }
    return [];
  }

  function addDmFavorite(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmFavorites) data.users[i].dmFavorites = [];
        if (data.users[i].dmFavorites.indexOf(targetUserId) === -1) {
          data.users[i].dmFavorites.push(targetUserId);
          saveUsers(data);
        }
        return data.users[i].dmFavorites;
      }
    }
    return [];
  }

  function removeDmFavorite(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmFavorites) data.users[i].dmFavorites = [];
        data.users[i].dmFavorites = data.users[i].dmFavorites.filter(function (id) {
          return id !== targetUserId;
        });
        saveUsers(data);
        return data.users[i].dmFavorites;
      }
    }
    return [];
  }

  // --- DM Hidden (dismissed from strip) ---

  function getDmHidden(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].dmHidden || [];
      }
    }
    return [];
  }

  function addDmHidden(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmHidden) data.users[i].dmHidden = [];
        if (data.users[i].dmHidden.indexOf(targetUserId) === -1) {
          data.users[i].dmHidden.push(targetUserId);
          saveUsers(data);
        }
        return data.users[i].dmHidden;
      }
    }
    return [];
  }

  function removeDmHidden(userId, targetUserId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].dmHidden) data.users[i].dmHidden = [];
        data.users[i].dmHidden = data.users[i].dmHidden.filter(function (id) {
          return id !== targetUserId;
        });
        saveUsers(data);
        return data.users[i].dmHidden;
      }
    }
    return [];
  }

  // --- Deleted built-in mate keys tracking ---
  //
  // In single-user mode there is no users.json, so the user row lookup
  // below returns nothing and the key is silently dropped. That made
  // "Remove mate" in the sidebar picker a no-op: the key was never
  // persisted, ensureBuiltinMates re-created the mate on next mate_list,
  // and the user could not actually get rid of built-in mates.
  //
  // Fallback: when the user record isn't found (single-user mode), read
  // and write deletedBuiltinKeys on daemon.json via lib/config.js. This
  // preserves multi-user behavior (users.json row still wins) while
  // giving single-user deploys a place to persist the setting.

  function loadSingleUserDeletedKeys() {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      return Array.isArray(cfg.deletedBuiltinKeys) ? cfg.deletedBuiltinKeys : [];
    } catch (e) {
      return [];
    }
  }

  function saveSingleUserDeletedKeys(keys) {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      cfg.deletedBuiltinKeys = keys;
      config.saveConfig(cfg);
    } catch (e) {}
  }

  function getDeletedBuiltinKeys(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].deletedBuiltinKeys || [];
      }
    }
    return loadSingleUserDeletedKeys();
  }

  function addDeletedBuiltinKey(userId, key) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].deletedBuiltinKeys) data.users[i].deletedBuiltinKeys = [];
        if (data.users[i].deletedBuiltinKeys.indexOf(key) === -1) {
          data.users[i].deletedBuiltinKeys.push(key);
          saveUsers(data);
        }
        return;
      }
    }
    // Single-user fallback
    var keys = loadSingleUserDeletedKeys();
    if (keys.indexOf(key) === -1) {
      keys.push(key);
      saveSingleUserDeletedKeys(keys);
    }
  }

  function removeDeletedBuiltinKey(userId, key) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].deletedBuiltinKeys) return;
        data.users[i].deletedBuiltinKeys = data.users[i].deletedBuiltinKeys.filter(function (k) {
          return k !== key;
        });
        saveUsers(data);
        return;
      }
    }
    // Single-user fallback
    var keys = loadSingleUserDeletedKeys();
    var filtered = keys.filter(function (k) { return k !== key; });
    if (filtered.length !== keys.length) {
      saveSingleUserDeletedKeys(filtered);
    }
  }

  // --- Per-user chat layout setting ---

  function getChatLayout(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].chatLayout || "channel";
      }
    }
    return "channel";
  }

  function setChatLayout(userId, layout) {
    var val = (layout === "bubble") ? "bubble" : "channel";
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].chatLayout = val;
        saveUsers(data);
        return { ok: true, chatLayout: val };
      }
    }
    return { error: "User not found" };
  }

  // --- Per-user auto-continue setting ---

  function getAutoContinue(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return !!data.users[i].autoContinueOnRateLimit;
      }
    }
    return false;
  }

  function setAutoContinue(userId, enabled) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].autoContinueOnRateLimit = !!enabled;
        saveUsers(data);
        return { ok: true, autoContinueOnRateLimit: !!enabled };
      }
    }
    return { error: "User not found" };
  }

  // --- Per-user Claude open mode ---
  //
  // Decides how Claude sessions are rendered when the user clicks into one:
  //   'gui' - Clay's custom chat UI driven by the Claude Agent SDK.
  //   'tui' - Embedded xterm running the real `claude` CLI (default). Keeps
  //           usage in the Interactive billing bucket post 2026-06-15.
  //
  // The preference applies to newly-created sessions. Existing sessions
  // resume in the mode they were created in (see also alwaysRestartInTui
  // below for the one runtime-override path).
  //
  // Storage: multi-user writes to the users.json row; single-user mode has
  // no user record, so we fall back to daemon.json. Without the fallback,
  // the WS handler would silently fail to persist and the toggle would be
  // a no-op for single-user deploys.

  function loadSingleUserClaudeOpenMode() {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      return (cfg.claudeOpenMode === "gui") ? "gui" : "tui";
    } catch (e) {
      return "tui";
    }
  }

  function saveSingleUserClaudeOpenMode(mode) {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      cfg.claudeOpenMode = mode;
      config.saveConfig(cfg);
    } catch (e) {}
  }

  function getClaudeOpenMode(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        var m = data.users[i].claudeOpenMode;
        return (m === "gui") ? "gui" : "tui";
      }
    }
    return loadSingleUserClaudeOpenMode();
  }

  function setClaudeOpenMode(userId, mode) {
    var normalized = (mode === "gui") ? "gui" : "tui";
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].claudeOpenMode = normalized;
        saveUsers(data);
        return { ok: true, claudeOpenMode: normalized };
      }
    }
    // Single-user fallback
    saveSingleUserClaudeOpenMode(normalized);
    return { ok: true, claudeOpenMode: normalized };
  }

  // --- Per-user "always restart Claude sessions in TUI" toggle ---
  //
  // When ON, opening any existing Claude session renders it in TUI regardless
  // of the session's born mode: born-TUI sessions stay TUI (always did), and
  // born-GUI sessions get a transient runtime PTY running `claude --resume
  // <cliSessionId>`. The on-disk session record is never mutated; flipping the
  // pref back to OFF returns subsequent opens to the session's born mode.
  //
  // Default is ON. Storage mirrors claudeOpenMode above: multi-user writes
  // to the users.json row; single-user falls back to daemon.json.

  function loadSingleUserAlwaysRestartInTui() {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      return cfg.alwaysRestartInTui !== false;
    } catch (e) {
      return true;
    }
  }

  function saveSingleUserAlwaysRestartInTui(enabled) {
    try {
      var config = require("./config");
      var cfg = config.loadConfig() || {};
      cfg.alwaysRestartInTui = !!enabled;
      config.saveConfig(cfg);
    } catch (e) {}
  }

  function getAlwaysRestartInTui(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].alwaysRestartInTui !== false;
      }
    }
    return loadSingleUserAlwaysRestartInTui();
  }

  function setAlwaysRestartInTui(userId, enabled) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].alwaysRestartInTui = !!enabled;
        saveUsers(data);
        return { ok: true, alwaysRestartInTui: !!enabled };
      }
    }
    // Single-user fallback
    saveSingleUserAlwaysRestartInTui(enabled);
    return { ok: true, alwaysRestartInTui: !!enabled };
  }

  // --- Per-user Claude Code auto-approve allow-list ---
  //
  // Strings appended to Clay's managed CLAY_MANAGED_ALLOW list when
  // generating ~/.claude/settings.json permissions.allow. User-authored
  // patterns survive Clay reinstalls because the installer only strips
  // entries that match CLAY_MANAGED_ALLOW exactly. Format is Claude Code's
  // own (e.g. "Bash(npm test:*)", "Read", "mcp__foo__bar").

  function getClaudeUserAllowList(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        var v = data.users[i].claudeUserAllowList;
        return Array.isArray(v) ? v : [];
      }
    }
    return [];
  }

  function setClaudeUserAllowList(userId, patterns) {
    if (!Array.isArray(patterns)) return { error: "patterns must be an array" };
    var seen = {};
    var clean = [];
    for (var i = 0; i < patterns.length; i++) {
      var p = String(patterns[i] || "").trim();
      if (!p) continue;
      if (seen[p]) continue;
      seen[p] = true;
      clean.push(p);
    }
    var data = loadUsers();
    for (var j = 0; j < data.users.length; j++) {
      if (data.users[j].id === userId) {
        data.users[j].claudeUserAllowList = clean;
        saveUsers(data);
        return { ok: true, claudeUserAllowList: clean };
      }
    }
    return { error: "User not found" };
  }

  // --- Per-user Mates UI toggle ---
  //
  // When false, the entire Mates surface (sidebar avatars, DM "Create a
  // Mate" entry, home-hub mates strip) is hidden for this user. Default
  // is ON: Mates is opt-out, not opt-in. Stored as `matesEnabled`; we
  // treat any value other than the literal `false` as enabled so brand-
  // new users (no field set) get the default-on experience.

  function getMatesEnabled(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].matesEnabled !== false;
      }
    }
    return true;
  }

  function setMatesEnabled(userId, enabled) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].matesEnabled = !!enabled;
        saveUsers(data);
        return { ok: true, matesEnabled: !!enabled };
      }
    }
    return { error: "User not found" };
  }


  // --- Per-user tool palette preferences ---
  //
  // Each user can customize the sidebar tool grid by reordering or
  // hiding individual tools. Stored as an object keyed by palette name
  // ("session" or "mate"), each holding { order: [...ids], hidden: [...ids] }.
  // Missing ids are treated as "use registry default at the end", so new
  // tools added in future releases show up for existing users without a
  // migration.

  var VALID_PALETTES = { session: true, mate: true };

  function getToolPalettes(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        return data.users[i].toolPalettes || {};
      }
    }
    return {};
  }

  function setToolPalette(userId, paletteName, order, hidden) {
    if (!VALID_PALETTES[paletteName]) {
      return { error: "Unknown palette" };
    }
    var safeOrder = Array.isArray(order)
      ? order.filter(function (s) { return typeof s === "string"; })
      : [];
    var safeHidden = Array.isArray(hidden)
      ? hidden.filter(function (s) { return typeof s === "string"; })
      : [];
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        if (!data.users[i].toolPalettes) data.users[i].toolPalettes = {};
        data.users[i].toolPalettes[paletteName] = {
          order: safeOrder,
          hidden: safeHidden,
        };
        saveUsers(data);
        return { ok: true, palette: paletteName, order: safeOrder, hidden: safeHidden };
      }
    }
    return { error: "User not found" };
  }

  // --- Mate onboarding ---

  function setMateOnboarded(userId) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].mateOnboardingShown = true;
        saveUsers(data);
        return { ok: true };
      }
    }
    return { error: "User not found" };
  }

  return {
    getDmFavorites: getDmFavorites,
    addDmFavorite: addDmFavorite,
    removeDmFavorite: removeDmFavorite,
    getDmHidden: getDmHidden,
    addDmHidden: addDmHidden,
    removeDmHidden: removeDmHidden,
    getDeletedBuiltinKeys: getDeletedBuiltinKeys,
    addDeletedBuiltinKey: addDeletedBuiltinKey,
    removeDeletedBuiltinKey: removeDeletedBuiltinKey,
    getChatLayout: getChatLayout,
    setChatLayout: setChatLayout,
    getAutoContinue: getAutoContinue,
    setAutoContinue: setAutoContinue,
    getClaudeOpenMode: getClaudeOpenMode,
    setClaudeOpenMode: setClaudeOpenMode,
    getAlwaysRestartInTui: getAlwaysRestartInTui,
    setAlwaysRestartInTui: setAlwaysRestartInTui,
    getMatesEnabled: getMatesEnabled,
    setMatesEnabled: setMatesEnabled,
    getClaudeUserAllowList: getClaudeUserAllowList,
    setClaudeUserAllowList: setClaudeUserAllowList,
    getToolPalettes: getToolPalettes,
    setToolPalette: setToolPalette,
    setMateOnboarded: setMateOnboarded,
  };
}

module.exports = { attachPreferences: attachPreferences };
