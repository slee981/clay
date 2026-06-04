// config-defaults.js — Builds the `config_defaults` carrier message.
//
// `config_defaults` surfaces the PERSISTED server/project defaults (effort,
// mode, model) to the client. It is deliberately distinct from `config_state`,
// which carries the LIVE session's current values. The Settings panels bind
// their default bars to this carrier so they show what is actually saved on
// disk rather than whatever the active session happens to be on.
//
// The carrier is field-complete (effort + mode + model) on purpose: only the
// effort bar consumes it today, but carrying mode/model now makes the
// identical mode/model display fix a client-only follow-up with no wire change.
//
// Single source of truth for the config_defaults wire shape — do not duplicate
// this anywhere else.

function readDefault(getter, arg, key) {
  if (typeof getter !== "function") return null;
  var r = arg === undefined ? getter() : getter(arg);
  return (r && r[key]) || null;
}

// Build the config_defaults message from the daemon's persisted-default
// getters. `slug` selects the project scope; `debugLog`, when supplied, logs
// the resolved values so a slug mismatch (project defaults unexpectedly null)
// is visible rather than silent.
function buildConfigDefaults(opts, slug, debugLog) {
  opts = opts || {};
  var serverDefaultEffort = readDefault(opts.onGetServerDefaultEffort, undefined, "effort");
  var serverDefaultMode = readDefault(opts.onGetServerDefaultMode, undefined, "mode");
  var serverDefaultModel = readDefault(opts.onGetServerDefaultModel, undefined, "model");
  var projectDefaultEffort = readDefault(opts.onGetProjectDefaultEffort, slug, "effort");
  var projectDefaultMode = readDefault(opts.onGetProjectDefaultMode, slug, "mode");
  var projectDefaultModel = readDefault(opts.onGetProjectDefaultModel, slug, "model");

  if (typeof debugLog === "function") {
    debugLog(
      "[config_defaults] slug=" + slug +
      " server={effort:" + serverDefaultEffort + ",mode:" + serverDefaultMode + ",model:" + serverDefaultModel + "}" +
      " project={effort:" + projectDefaultEffort + ",mode:" + projectDefaultMode + ",model:" + projectDefaultModel + "}"
    );
  }

  return {
    type: "config_defaults",
    serverDefaultEffort: serverDefaultEffort,
    projectDefaultEffort: projectDefaultEffort,
    serverDefaultMode: serverDefaultMode,
    projectDefaultMode: projectDefaultMode,
    serverDefaultModel: serverDefaultModel,
    projectDefaultModel: projectDefaultModel,
  };
}

module.exports = { buildConfigDefaults: buildConfigDefaults };
