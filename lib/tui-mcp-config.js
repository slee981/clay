// TUI MCP config helper
// ----------------------
// Builds a temporary --mcp-config JSON file that points the claude CLI at
// Clay's clay-tools stdio bridge (lib/yoke/mcp-bridge-server.js), so a TUI
// session can call Clay's in-process MCP tools (clay-sessions, clay-debate,
// clay-history, clay-ask-user). The bridge already exists for Codex; here
// we re-use it for the Claude TUI integration.
//
// Usage:
//   var tuiMcp = require("./tui-mcp-config");
//   var cfgPath = tuiMcp.buildTuiMcpConfig(slug, { port, tls, authToken });
//   // launch: claude --mcp-config <cfgPath> ...
//   // on session exit: tuiMcp.cleanupTuiMcpConfig(cfgPath);

var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");

var BRIDGE_PATH = path.join(__dirname, "yoke", "mcp-bridge-server.js");

function buildTuiMcpConfig(slug, opts) {
  if (!fs.existsSync(BRIDGE_PATH)) return null;
  var clayPort = (opts && opts.port) || 2633;
  var clayTls = !!(opts && opts.tls);
  var clayAuthToken = (opts && opts.authToken) || "";

  var bridgeArgs = [BRIDGE_PATH, "--port", String(clayPort)];
  if (slug) bridgeArgs.push("--slug", slug);
  if (clayTls) bridgeArgs.push("--tls");

  var serverEntry = {
    command: process.execPath,
    args: bridgeArgs,
  };
  if (clayAuthToken) serverEntry.env = { CLAY_AUTH_TOKEN: clayAuthToken };

  var config = { mcpServers: { "clay-tools": serverEntry } };

  var fname = "clay-tui-mcp-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + ".json";
  var cfgPath = path.join(os.tmpdir(), fname);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(config));
    if (process.platform !== "win32") {
      try { fs.chmodSync(cfgPath, 0o600); } catch (e) {}
    }
  } catch (e) {
    console.error("[tui-mcp-config] Failed to write " + cfgPath + ":", e.message);
    return null;
  }
  return cfgPath;
}

function cleanupTuiMcpConfig(cfgPath) {
  if (!cfgPath) return;
  try { fs.unlinkSync(cfgPath); } catch (e) {}
}

// Single-quote a string for inclusion in a shell command. Handles embedded
// single quotes by closing/escaping/reopening: ' -> '\''.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = {
  buildTuiMcpConfig: buildTuiMcpConfig,
  cleanupTuiMcpConfig: cleanupTuiMcpConfig,
  shellQuote: shellQuote,
};
