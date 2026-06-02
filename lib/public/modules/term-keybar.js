// term-keybar.js
//
// Shared mobile/touch keybar primitive for xterm-hosting views. Renders the
// row of accessory buttons (Tab, Ctrl, Esc, arrows, Alt, pipe/slash/tilde),
// owns sticky Ctrl/Alt state, and emits {key, seq} events via an EventBus.
// The host wires the events to its own term_input send path.
//
// This module is the intended future single source of truth for the
// bottom-panel shell terminal's inline keybar (currently inlined in
// `terminal.js` near KEY_MAP / initToolbar). A follow-up PR will delete
// that inline copy and switch terminal.js to import this module. v1
// consumer is the TUI keybar overlay only.
//
// Public API:
//   createKeybar(toolbarEl, opts) -> {
//     events,                // EventBus; 'key' fires {key, seq}
//     hasCtrl(), hasAlt(),
//     clearStickyModifiers(),
//     destroy()
//   }
//   consumeCtrlKey(ev, keybar) -> string | null
//     Pure helper used inside an xterm `attachCustomKeyEventHandler`.
//     Returns the Ctrl-letter byte (\x01..\x1A) when sticky-Ctrl is armed
//     and ev.key is a single letter; clears sticky-Ctrl on a non-null
//     return. Otherwise returns null.
//
// CLAUDE.md compliance: `var` only, no arrow functions, no `_ctx` capture.

import { EventBus } from "./events.js";

var KEY_MAP = {
  tab: "\t",
  esc: "\x1b",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pipe: "|",
  slash: "/",
  tilde: "~",
};

// Default button definitions matching the existing #terminal-toolbar markup
// in index.html so the same .term-key / .term-key-toggle / .term-key-arrow
// CSS rules (defined class-only in filebrowser.css) style this bar too.
var DEFAULT_BUTTONS = [
  { key: "tab", label: "Tab", classes: ["term-key"] },
  { key: "ctrl", label: "Ctrl", classes: ["term-key", "term-key-toggle"] },
  { key: "esc", label: "Esc", classes: ["term-key"] },
  { key: "enter", label: "⏎", classes: ["term-key"] },
  { spacer: true },
  { key: "up", label: "▲", classes: ["term-key", "term-key-arrow"] },
  { key: "down", label: "▼", classes: ["term-key", "term-key-arrow"] },
  { key: "left", label: "◀", classes: ["term-key", "term-key-arrow"] },
  { key: "right", label: "▶", classes: ["term-key", "term-key-arrow"] },
  { spacer: true },
  { key: "alt", label: "Alt", classes: ["term-key", "term-key-toggle"] },
  { key: "pipe", label: "|", classes: ["term-key"] },
  { key: "slash", label: "/", classes: ["term-key"] },
  { key: "tilde", label: "~", classes: ["term-key"] },
  { key: "paste", label: "Paste", classes: ["term-key"], utility: true },
];

function buildDefaultButtons(toolbarEl) {
  for (var i = 0; i < DEFAULT_BUTTONS.length; i++) {
    var def = DEFAULT_BUTTONS[i];
    if (def.spacer) {
      var s = document.createElement("span");
      s.className = "term-key-spacer";
      toolbarEl.appendChild(s);
      continue;
    }
    var btn = document.createElement("button");
    btn.type = "button";
    for (var j = 0; j < def.classes.length; j++) btn.classList.add(def.classes[j]);
    btn.setAttribute("data-key", def.key);
    if (def.utility) btn.setAttribute("data-keybar-utility", "true");
    btn.textContent = def.label;
    toolbarEl.appendChild(btn);
  }
}

export function createKeybar(toolbarEl, opts) {
  opts = opts || {};
  if (!toolbarEl) throw new Error("createKeybar: toolbarEl required");

  if (opts.buildDefaultButtons !== false) {
    buildDefaultButtons(toolbarEl);
  }

  var events = new EventBus();
  var ctrlActive = false;
  var altActive = false;
  var destroyed = false;

  // Preserve xterm focus when a button is tapped: preventDefault on
  // mousedown stops the click from stealing focus from the terminal.
  // (Matches `terminal.js:925`.)
  function onMouseDown(e) { e.preventDefault(); }

  function setToggleClass(key, active) {
    var sel = "[data-key='" + key + "']";
    var el = toolbarEl.querySelector(sel);
    if (el) el.classList.toggle("active", active);
  }

  function onClick(e) {
    var btn = e.target.closest(".term-key");
    if (!btn || !toolbarEl.contains(btn)) return;

    // Utility buttons (Paste, A−, A+, etc.) live inside the bar but must
    // not consume sticky modifiers and must not be routed through KEY_MAP.
    if (btn.getAttribute("data-keybar-utility") === "true") return;

    var key = btn.dataset.key;
    if (!key) return;

    if (key === "ctrl") {
      ctrlActive = !ctrlActive;
      setToggleClass("ctrl", ctrlActive);
      return;
    }

    if (key === "alt") {
      altActive = !altActive;
      setToggleClass("alt", altActive);
      return;
    }

    var seq = KEY_MAP[key];
    if (!seq) return;

    if (altActive) {
      seq = "\x1b" + seq;
      altActive = false;
      setToggleClass("alt", false);
    }

    events.emit("key", { key: key, seq: seq });

    if (ctrlActive) {
      ctrlActive = false;
      setToggleClass("ctrl", false);
    }
  }

  toolbarEl.addEventListener("mousedown", onMouseDown);
  toolbarEl.addEventListener("click", onClick);

  function hasCtrl() { return ctrlActive; }
  function hasAlt() { return altActive; }

  function clearStickyModifiers() {
    if (ctrlActive) {
      ctrlActive = false;
      setToggleClass("ctrl", false);
    }
    if (altActive) {
      altActive = false;
      setToggleClass("alt", false);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearStickyModifiers();
    toolbarEl.removeEventListener("mousedown", onMouseDown);
    toolbarEl.removeEventListener("click", onClick);
  }

  return {
    events: events,
    hasCtrl: hasCtrl,
    hasAlt: hasAlt,
    clearStickyModifiers: clearStickyModifiers,
    destroy: destroy,
  };
}

// Pure helper for the consumer's xterm.attachCustomKeyEventHandler. Returns
// the Ctrl-letter byte if sticky-Ctrl is armed and ev is a single-letter
// keydown; clears sticky-Ctrl on a non-null return. Otherwise returns null.
//
// Consumers wire it like:
//   xterm.attachCustomKeyEventHandler(function (ev) {
//     var ctrl = consumeCtrlKey(ev, keybar);
//     if (ctrl != null) { send(ctrl); return false; }
//     return true;
//   });
export function consumeCtrlKey(ev, keybar) {
  if (!ev || !keybar || !keybar.hasCtrl()) return null;
  if (ev.type !== "keydown") return null;
  if (!ev.key || ev.key.length !== 1) return null;
  var charCode = ev.key.toUpperCase().charCodeAt(0);
  if (charCode < 65 || charCode > 90) return null;
  var ctrlChar = String.fromCharCode(charCode - 64);
  keybar.clearStickyModifiers();
  return ctrlChar;
}

// Bytes sent for a Shift+Enter newline. A bare \n (or \r) does NOT work:
// outside a bracketed paste, Claude's TUI treats every \n/\r in the input
// stream as a distinct Enter press and submits — see the keybar Paste path,
// which wraps multi-line clipboard text in the same markers precisely so it
// is inserted as one literal block "instead of N separate Enter presses".
// So we wrap a single newline in bracketed-paste markers (DECSET 2004): the
// TUI inserts it into the prompt buffer literally, without submitting.
var TUI_NEWLINE_SEQ = "\x1b[200~\n\x1b[201~";

// Pure helper for an xterm.attachCustomKeyEventHandler: when the user presses
// Shift+Enter (and only Shift — no Ctrl/Alt/Meta), insert a literal newline
// into Claude's TUI prompt instead of letting xterm emit the default \r that
// the TUI treats as "submit". See TUI_NEWLINE_SEQ for why we use bracketed
// paste rather than a raw \n.
//
// Returns TRUE when the event is the Shift+Enter chord and the caller should
// suppress it (return false from the key handler). It returns true for EVERY
// phase of the chord — keydown, keypress, AND keyup — because xterm emits the
// submitting \r on the keypress phase, not keydown; suppressing only keydown
// lets the keypress \r through and the prompt submits anyway (the bug behind
// "works when the box is empty but submits when it has text"). The newline is
// sent exactly once, on keydown.
//
// We intentionally suppress even if the send fails (e.g. WebSocket down): the
// alternative — letting the default \r through — would submit the prompt,
// which is worse than a no-op keystroke.
//
// The !ev.isComposing guard avoids hijacking IME/CJK candidate commit, where
// Shift+Enter is part of composition rather than a newline request.
//
// NOTE: ev.key === "Enter" also matches NumpadEnter, so Shift+NumpadEnter
// newlines too — intentional and consistent with the main Enter key.
//
// xterm.attachCustomKeyEventHandler is a single-slot API. Every writer of that
// slot (today: session-tui-view.js createXterm, and tui-keybar-overlay.js's
// installXtermKeyHandler + installPassthroughKeyHandler) MUST call this first
// and return false when it returns true, so the behavior holds regardless of
// which writer claimed the slot last. Any future fourth writer must do the same.
export function maybeSendTuiNewline(ev, sendSeq) {
  if (!ev || typeof sendSeq !== "function") return false;
  if (ev.key !== "Enter") return false;
  if (!ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  if (ev.isComposing) return false;
  // Shift+Enter chord: send the newline once (on keydown), suppress all phases.
  if (ev.type === "keydown") sendSeq(TUI_NEWLINE_SEQ);
  return true;
}
