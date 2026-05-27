// session-tui-view.js
//
// Renders a Claude Code TUI inside the main session view area when the
// active session is a `mode: 'tui'` session. The PTY itself is managed by
// the server's terminal-manager (same infra that powers the bottom-panel
// shell tabs); this module is responsible only for the embedded xterm and
// for relaying input/output/resize for the bound terminal.
//
// Lifecycle (driven by app-messages.js on session_switched):
//   attachTuiView(terminalId)  - mount xterm, send term_attach
//   detachTuiView()            - send term_detach, dispose xterm
//
// PTY survives detach (server keeps the terminal alive). On `/exit` or
// claude exit the server's onExit hook deletes the session and broadcasts
// the new session list; this view tears itself down via handleTermExited.

import { getWs } from './ws-ref.js';
import { showTuiKeybar, hideTuiKeybar } from './tui-keybar-overlay.js';

// Claude TUI sessions intentionally ignore Clay's dark/light theme and
// always render with a classic black terminal look. The bottom-panel
// shell terminal still follows the theme; this is specific to the TUI
// session view so `claude` renders consistently across themes.
var TUI_TERMINAL_THEME = {
  background: "#000000",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#000000",
  selectionBackground: "#3a3a3a",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

var hostEl = null;       // container div mounted over #messages
var xterm = null;        // xterm.js instance
var fitAddon = null;
var webglAddon = null;
var currentTermId = null;
var resizeObserver = null;
var windowResizeBound = false;
var viewportResizeBound = false;
function onWindowResize() {
  if (currentTermId != null) fitNow();
}
function onViewportChange() {
  if (currentTermId != null) fitNow();
}

function ensureHostEl() {
  if (hostEl) return hostEl;
  // Anchor the host to the chat content area (the bounding box of
  // #messages) rather than the viewport. Using `position: fixed` worked
  // visually but broke layout when the sidebar, header, or any side panel
  // was open - the xterm slid under them. Re-position on every show via
  // syncHostBounds() so resizes and panel toggles stay in sync.
  hostEl = document.createElement("div");
  hostEl.id = "tui-session-host";
  hostEl.style.position = "fixed";
  hostEl.style.display = "none";
  hostEl.style.background = "#000000";
  hostEl.style.zIndex = "5";
  hostEl.style.overflow = "hidden";
  hostEl.style.boxSizing = "border-box";
  document.body.appendChild(hostEl);
  installFileAttachUI(hostEl);
  return hostEl;
}

// --- File attach: + button and drag-drop ---
// Both paths POST the file bytes to /api/upload, which saves them to a
// per-cwd /tmp/clay-<hash>/ directory and returns an absolute path on
// the server. We then write the path(s) into the PTY as if the user
// typed them — claude reads them as part of its current prompt buffer
// and can use Read on them or attach as images per its usual rules.

var MAX_TUI_UPLOAD_BYTES = 50 * 1024 * 1024; // matches MAX_UPLOAD_BYTES in /api/upload

function installFileAttachUI(host) {
  // Hidden file input — driven by the + button. accept="*/*" so iOS
  // and Android pickers offer both Photos and Files; the user can pick
  // any kind of file.
  var fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.style.position = "absolute";
  fileInput.style.left = "-9999px";
  fileInput.style.opacity = "0";
  fileInput.style.pointerEvents = "none";
  fileInput.addEventListener("change", function () {
    var files = Array.from(fileInput.files || []);
    fileInput.value = ""; // reset so re-selecting the same file fires change again
    handleAttachFiles(files);
  });
  host.appendChild(fileInput);

  // Floating + button at bottom-right of the TUI host. Sized for touch.
  // Sits above the iOS keyboard because the host itself is sized via
  // visualViewport (see syncHostBounds).
  var addBtn = document.createElement("button");
  addBtn.id = "tui-attach-btn";
  addBtn.type = "button";
  addBtn.setAttribute("aria-label", "Attach files");
  addBtn.title = "Attach files";
  addBtn.textContent = "+";
  addBtn.style.position = "absolute";
  addBtn.style.right = "12px";
  addBtn.style.bottom = "12px";
  addBtn.style.width = "44px";
  addBtn.style.height = "44px";
  addBtn.style.borderRadius = "50%";
  addBtn.style.border = "1px solid #444";
  addBtn.style.background = "rgba(40, 40, 40, 0.85)";
  addBtn.style.color = "#e5e5e5";
  addBtn.style.fontSize = "24px";
  addBtn.style.lineHeight = "1";
  addBtn.style.fontWeight = "300";
  addBtn.style.cursor = "pointer";
  addBtn.style.zIndex = "10";
  addBtn.style.display = "flex";
  addBtn.style.alignItems = "center";
  addBtn.style.justifyContent = "center";
  addBtn.style.padding = "0";
  addBtn.style.userSelect = "none";
  addBtn.style.webkitTapHighlightColor = "transparent";
  addBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });
  host.appendChild(addBtn);

  // Drag-and-drop on the host. Touch devices don't fire drag events,
  // so this is desktop-only — the + button is the mobile path.
  host.addEventListener("dragover", function (e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    host.style.outline = "2px dashed #4a90e2";
    host.style.outlineOffset = "-4px";
  });
  host.addEventListener("dragleave", function (e) {
    if (e.target === host) {
      host.style.outline = "";
      host.style.outlineOffset = "";
    }
  });
  host.addEventListener("drop", function (e) {
    e.preventDefault();
    host.style.outline = "";
    host.style.outlineOffset = "";
    var files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    handleAttachFiles(files);
  });
}

function handleAttachFiles(files) {
  if (!files || files.length === 0) return;
  if (currentTermId == null) return;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  var ups = files.map(uploadOneFile);
  Promise.allSettled(ups).then(function (results) {
    var paths = [];
    var failed = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled" && results[i].value) {
        paths.push(results[i].value);
      } else {
        var name = (files[i] && files[i].name) || "file";
        failed.push(name);
      }
    }
    if (paths.length > 0) {
      var text = " " + paths.join(" ") + " ";
      var ws2 = getWs();
      if (ws2 && ws2.readyState === 1 && currentTermId != null) {
        ws2.send(JSON.stringify({ type: "term_input", id: currentTermId, data: text }));
      }
    }
    if (failed.length > 0) {
      console.error("[tui-attach] upload failed:", failed.join(", "));
    }
  });
}

function uploadOneFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file) { reject(new Error("no file")); return; }
    if (file.size > MAX_TUI_UPLOAD_BYTES) {
      reject(new Error("File too large (max 50MB): " + file.name));
      return;
    }
    var reader = new FileReader();
    reader.onload = function (ev) {
      var dataUrl = ev.target.result || "";
      var commaIdx = String(dataUrl).indexOf(",");
      var b64 = commaIdx !== -1 ? String(dataUrl).substring(commaIdx + 1) : "";
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "api/upload");
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var resp = JSON.parse(xhr.responseText);
            resolve(resp && resp.path);
          } catch (e) { reject(e); }
        } else {
          reject(new Error("Upload HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error("Upload network error")); };
      xhr.send(JSON.stringify({ name: file.name, data: b64 }));
    };
    reader.onerror = function () { reject(new Error("Could not read file")); };
    reader.readAsDataURL(file);
  });
}

function syncHostBounds() {
  if (!hostEl) return;
  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;
  var r = messagesEl.getBoundingClientRect();
  // Extend down to the bottom of the *visible* viewport — not the layout
  // viewport — so the on-screen keyboard on iOS doesn't cover the xterm.
  // window.innerHeight reports the full viewport even when the keyboard is
  // up; visualViewport.height shrinks accordingly, and offsetTop captures
  // the layout shift iOS applies when the keyboard pushes the page up.
  var vv = window.visualViewport;
  var visibleBottom = vv ? (vv.offsetTop + vv.height) : window.innerHeight;
  hostEl.style.top = r.top + "px";
  hostEl.style.left = r.left + "px";
  hostEl.style.width = r.width + "px";
  hostEl.style.height = Math.max(0, visibleBottom - r.top) + "px";
}

function hideGuiChrome(hide) {
  var messagesEl = document.getElementById("messages");
  var inputArea = document.getElementById("input-area");
  if (messagesEl) messagesEl.style.visibility = hide ? "hidden" : "";
  if (inputArea) inputArea.style.display = hide ? "none" : "";
  var newMsgBtn = document.getElementById("new-msg-btn");
  if (newMsgBtn) newMsgBtn.style.display = hide ? "none" : "";
}

function fitNow() {
  if (!xterm || !fitAddon || !hostEl) return;
  syncHostBounds();
  try {
    fitAddon.fit();
    // Inform the server so its PTY's idea of cols/rows matches what xterm
    // just rendered. Without this, claude TUI redraws using stale dims.
    if (currentTermId != null && getWs() && getWs().readyState === 1) {
      getWs().send(JSON.stringify({
        type: "term_resize",
        id: currentTermId,
        cols: xterm.cols,
        rows: xterm.rows,
      }));
    }
  } catch (e) {}
}

function createXterm() {
  if (typeof Terminal === "undefined") return null;
  var theme = TUI_TERMINAL_THEME;
  // Match the host background to the xterm theme so any sub-cell gap
  // between the last rendered row and the host's bottom blends in.
  if (hostEl) hostEl.style.background = theme.background;
  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    theme: theme,
    scrollback: 5000,
  });
  if (typeof FitAddon !== "undefined") {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  if (typeof WebLinksAddon !== "undefined") {
    try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  }
  term.open(hostEl);
  if (typeof WebglAddon !== "undefined") {
    try {
      webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(function () {
        try { webglAddon.dispose(); } catch (e) {}
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch (e) {}
  }
  // Route keystrokes back to the PTY.
  term.onData(function (data) {
    if (currentTermId == null) return;
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "term_input", id: currentTermId, data: data }));
    }
  });
  return term;
}

function teardownXterm() {
  if (webglAddon) {
    try { webglAddon.dispose(); } catch (e) {}
    webglAddon = null;
  }
  if (xterm) {
    try { xterm.dispose(); } catch (e) {}
    xterm = null;
  }
  fitAddon = null;
}

export function attachTuiView(terminalId) {
  if (typeof terminalId !== "number") return;
  // Re-attaching to the same terminal: just refit and refocus.
  if (currentTermId === terminalId && xterm) {
    if (hostEl) hostEl.style.display = "";
    hideGuiChrome(true);
    fitNow();
    try { xterm.focus(); } catch (e) {}
    showTuiKeybar(function () { return currentTermId; }, function () { return xterm; });
    return;
  }
  // Switching to a different TUI terminal: tear down the old one cleanly.
  if (currentTermId != null && currentTermId !== terminalId) {
    detachTuiView();
  }
  if (!ensureHostEl()) return;
  hostEl.style.display = "";
  hideGuiChrome(true);
  syncHostBounds();

  currentTermId = terminalId;
  if (!xterm) xterm = createXterm();
  if (!xterm) return;

  // Subscribe to the terminal's output stream on the server. The server
  // replays its scrollback buffer on attach so we never start blank.
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "term_attach", id: terminalId }));
  }

  // First fit pass; defer a second pass for layout to settle.
  fitNow();
  setTimeout(fitNow, 50);
  try { xterm.focus(); } catch (e) {}

  if (!resizeObserver && typeof ResizeObserver !== "undefined") {
    // Watch the chat-content area, not the host: the host's size is
    // derived from #messages via syncHostBounds, so observing it would
    // miss the actual source of truth (sidebar toggles, panel opens, etc.)
    var msgEl = document.getElementById("messages");
    if (msgEl) {
      resizeObserver = new ResizeObserver(function () { fitNow(); });
      resizeObserver.observe(msgEl);
    }
  }
  if (!windowResizeBound) {
    window.addEventListener("resize", onWindowResize);
    windowResizeBound = true;
  }
  // iOS keyboard show/hide and address-bar collapse fire visualViewport
  // events, not window resize. Subscribe to both resize and scroll on the
  // visualViewport so the host re-fits above the keyboard.
  if (!viewportResizeBound && window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange);
    window.visualViewport.addEventListener("scroll", onViewportChange);
    viewportResizeBound = true;
  }

  // Mount the mobile keybar overlay (body-level, not inside the TUI host).
  // Idempotent + gated by (pointer: coarse) inside the overlay module.
  showTuiKeybar(function () { return currentTermId; }, function () { return xterm; });
}

export function detachTuiView() {
  // Tear down the keybar overlay BEFORE the xterm so the overlay's
  // passthrough handler reinstall lands on a still-live xterm.
  hideTuiKeybar();
  if (resizeObserver) {
    try { resizeObserver.disconnect(); } catch (e) {}
    resizeObserver = null;
  }
  if (currentTermId != null) {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: "term_detach", id: currentTermId })); } catch (e) {}
    }
  }
  currentTermId = null;
  teardownXterm();
  if (hostEl) hostEl.style.display = "none";
  hideGuiChrome(false);
}

// Route a term_output frame to the embedded xterm if it belongs to the
// current TUI session. Returns true if consumed so app-messages can skip
// the bottom-panel handler.
export function tuiHandleTermOutput(msg) {
  if (!msg || msg.id !== currentTermId || !xterm || !msg.data) return false;
  xterm.write(msg.data);
  return true;
}

export function tuiHandleTermResized(msg) {
  if (!msg || msg.id !== currentTermId || !xterm) return false;
  if (msg.cols > 0 && msg.rows > 0) {
    try { xterm.resize(msg.cols, msg.rows); } catch (e) {}
  }
  return true;
}

export function tuiHandleTermExited(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  if (xterm) {
    try { xterm.write("\r\n\x1b[90m[claude exited - session will close]\x1b[0m\r\n"); } catch (e) {}
  }
  // The server's onExit hook deletes the session record and broadcasts a
  // fresh session_list. The next session_switched (or empty state) will
  // call detachTuiView for us.
  return true;
}

export function tuiHandleTermClosed(msg) {
  if (!msg || msg.id !== currentTermId) return false;
  detachTuiView();
  return true;
}

export function getActiveTuiTerminalId() {
  return currentTermId;
}
