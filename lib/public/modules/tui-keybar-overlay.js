// tui-keybar-overlay.js
//
// TUI-specific singleton that mounts the shared `term-keybar.js` UI as a
// `position: fixed; bottom: 0` overlay on document.body — explicitly NOT
// inside #tui-session-host. A prior approach mounted the keybar as a child
// of the TUI host and reshaped the host's sizing to make room; a bug in the
// keybar module blanked the whole TUI on both PWA and desktop. Decoupling
// the keybar from the TUI host's render flow is the architectural fix.
//
// Public API:
//   showTuiKeybar(getTermId, getXterm)
//   hideTuiKeybar()
//
// Thunks (getTermId, getXterm) are used so the overlay reads the current
// termId / xterm at event time, and so we avoid a circular import with
// `session-tui-view.js` (which imports this module).
//
// xterm.attachCustomKeyEventHandler slot ownership: xterm.js exposes no
// getter for the existing handler. session-tui-view.js's createXterm does
// NOT install one today (verified — only term.onData), so this overlay
// implicitly owns that slot for the TUI's xterm. On hide we install a
// passthrough noop. Future code wanting that slot must coordinate here.
//
// CLAUDE.md compliance: `var` only, no arrow functions, no `_ctx` capture.

import { getWs } from "./ws-ref.js";
import { showToast } from "./utils.js";
import { createKeybar, consumeCtrlKey } from "./term-keybar.js";

var OVERLAY_ID = "tui-keybar-overlay";

var overlayEl = null;
var keybar = null;
var keybarOff = null;          // unsubscribe fn from keybar.events.on
var currentGetTermId = null;
var currentGetXterm = null;
var coarseMql = null;
var coarseListener = null;
var vvResizeListener = null;
var vvScrollListener = null;
var vvRaf = 0;
var lifecycleListenersBound = false;
var sheetObserver = null;       // MutationObserver on #mobile-sheet class
var suppressedBySheet = false;  // true while a mobile sheet covers the TUI

// Tell session-tui-view.js the keybar's effective height changed so it can
// re-fit the xterm (host height reserves room for the bar). Single source
// of truth, no per-module coupling.
function emitKeybarResize() {
  try { window.dispatchEvent(new CustomEvent("tui-keybar-resize")); } catch (e) {}
}

function sendSeq(seq) {
  var termId = currentGetTermId ? currentGetTermId() : null;
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || termId == null) {
    showToast("Disconnected — keystroke not sent");
    return false;
  }
  try {
    ws.send(JSON.stringify({ type: "term_input", id: termId, data: seq }));
    return true;
  } catch (e) {
    showToast("Disconnected — keystroke not sent");
    return false;
  }
}

// Paste from the OS clipboard into the TUI. Wraps the text in bracketed
// paste markers so claude's TUI treats multi-line content as a single
// paste instead of N separate Enter presses. If claude's TUI ever stops
// honoring bracketed paste this is one line to revert.
function handlePasteClick() {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    showToast("Paste not supported on this browser");
    return;
  }
  navigator.clipboard.readText().then(function (text) {
    if (!text) return;
    var wrapped = "\x1b[200~" + text + "\x1b[201~";
    sendSeq(wrapped);
  }, function () {
    showToast("Clipboard permission denied");
  });
}

function positionOverlay() {
  if (!overlayEl) return;
  // Compute soft-keyboard height. When the keyboard is up,
  // (innerHeight - vv.height - vv.offsetTop) is its height; when down, ~0.
  var vv = window.visualViewport;
  var keyboardH = 0;
  if (vv) {
    keyboardH = window.innerHeight - vv.height - vv.offsetTop;
    if (keyboardH < 0) keyboardH = 0;
  }
  // Sit above the mobile bottom-tab nav (so it stays usable for switching
  // sessions / projects) when the keyboard is down. When the keyboard is
  // up, it covers the nav bar anyway and the keyboard height dominates.
  var navEl = document.getElementById("mobile-tab-bar");
  var navH = 0;
  if (navEl) {
    // offsetHeight is 0 when display:none (non-mobile viewport), so this
    // collapses to keyboard-only positioning on desktop/tablet wide modes.
    navH = navEl.offsetHeight || 0;
  }
  var bottom = keyboardH > navH ? keyboardH : navH;
  overlayEl.style.bottom = bottom + "px";
}

function schedulePosition() {
  if (vvRaf) return;
  vvRaf = requestAnimationFrame(function () {
    vvRaf = 0;
    positionOverlay();
  });
}

// The bottom mobile-tab-bar opens a #mobile-sheet (z-index 250) on top of
// the TUI view without detaching the session. While that sheet is up the
// keybar should disappear so it doesn't sit on top of the sheet; when the
// sheet closes the keybar should reappear (we're still on a TUI session).
function isMobileSheetOpen() {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet) return false;
  // The sheet is created in the DOM but stays `.hidden` when not in use.
  if (sheet.classList.contains("hidden")) return false;
  // `.closing` is the slide-down animation state — treat as already gone
  // so the keybar reappears mid-animation rather than after a perceptible
  // delay.
  if (sheet.classList.contains("closing")) return false;
  return true;
}

function applySheetSuppression() {
  if (!overlayEl) return;
  var shouldSuppress = isMobileSheetOpen();
  if (shouldSuppress === suppressedBySheet) return;
  suppressedBySheet = shouldSuppress;
  overlayEl.style.display = shouldSuppress ? "none" : "";
  if (!shouldSuppress) {
    // Sheet just closed — sticky modifiers can become stale across the
    // gap; clear them so we don't surprise the user on the next tap.
    if (keybar) keybar.clearStickyModifiers();
    positionOverlay();
  }
  // Bar's effective height just changed (0 ↔ keybarH). Tell the TUI view.
  emitKeybarResize();
}

function installSheetObserver() {
  if (sheetObserver) return;
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || typeof MutationObserver === "undefined") return;
  sheetObserver = new MutationObserver(function () { applySheetSuppression(); });
  sheetObserver.observe(sheet, { attributes: true, attributeFilter: ["class"] });
}

function uninstallSheetObserver() {
  if (sheetObserver) {
    try { sheetObserver.disconnect(); } catch (e) {}
    sheetObserver = null;
  }
  suppressedBySheet = false;
}

function installXtermKeyHandler() {
  var xt = currentGetXterm ? currentGetXterm() : null;
  if (!xt || typeof xt.attachCustomKeyEventHandler !== "function") return;
  xt.attachCustomKeyEventHandler(function (ev) {
    if (!keybar) return true;
    var ctrl = consumeCtrlKey(ev, keybar);
    if (ctrl != null) {
      sendSeq(ctrl);
      return false;
    }
    return true;
  });
}

function installPassthroughKeyHandler() {
  var xt = currentGetXterm ? currentGetXterm() : null;
  if (!xt || typeof xt.attachCustomKeyEventHandler !== "function") return;
  try {
    xt.attachCustomKeyEventHandler(function () { return true; });
  } catch (e) {}
}

function bindLifecycleListenersOnce() {
  if (lifecycleListenersBound) return;
  lifecycleListenersBound = true;
  window.addEventListener("pagehide", function () { hideTuiKeybar(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") hideTuiKeybar();
  });
}

function ensureCoarseMql() {
  if (coarseMql) return;
  if (!window.matchMedia) return;
  coarseMql = window.matchMedia("(pointer: coarse)");
  coarseListener = function () {
    if (coarseMql.matches) {
      // Switched to coarse pointer while a TUI is active.
      if (currentGetTermId && currentGetXterm && !overlayEl) {
        mountOverlay();
      }
    } else {
      // Switched to fine pointer — drop the overlay but keep thunks so
      // a future flip back to coarse can re-mount.
      if (overlayEl) unmountOverlay();
    }
  };
  if (typeof coarseMql.addEventListener === "function") {
    coarseMql.addEventListener("change", coarseListener);
  } else if (typeof coarseMql.addListener === "function") {
    // Safari < 14 fallback.
    coarseMql.addListener(coarseListener);
  }
}

function mountOverlay() {
  if (overlayEl) return;

  overlayEl = document.createElement("div");
  overlayEl.id = OVERLAY_ID;
  // Body-mount (NOT inside #tui-session-host) is the load-bearing design
  // decision — keeps the TUI render flow untouched.
  document.body.appendChild(overlayEl);

  keybar = createKeybar(overlayEl);
  keybarOff = keybar.events.on("key", function (ev) { sendSeq(ev.seq); });

  // Utility buttons (data-keybar-utility="true") don't go through the
  // keybar's KEY_MAP / EventBus path. Delegate-listen at the overlay so we
  // can route them to overlay-scoped handlers (WS, clipboard, ...).
  overlayEl.addEventListener("click", function (e) {
    var btn = e.target.closest(".term-key[data-keybar-utility='true']");
    if (!btn || !overlayEl.contains(btn)) return;
    var key = btn.dataset.key;
    if (key === "paste") handlePasteClick();
  });

  installXtermKeyHandler();

  installSheetObserver();
  // Apply initial state in case a sheet was already open at mount time
  // (e.g. user navigated to a TUI while the project picker was up).
  applySheetSuppression();

  vvResizeListener = function () { schedulePosition(); };
  vvScrollListener = function () { schedulePosition(); };
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", vvResizeListener);
    window.visualViewport.addEventListener("scroll", vvScrollListener);
  }
  positionOverlay();
  emitKeybarResize();
}

function unmountOverlay() {
  if (!overlayEl) return;

  if (window.visualViewport) {
    if (vvResizeListener) window.visualViewport.removeEventListener("resize", vvResizeListener);
    if (vvScrollListener) window.visualViewport.removeEventListener("scroll", vvScrollListener);
  }
  vvResizeListener = null;
  vvScrollListener = null;
  if (vvRaf) {
    cancelAnimationFrame(vvRaf);
    vvRaf = 0;
  }

  if (keybarOff) {
    try { keybarOff(); } catch (e) {}
    keybarOff = null;
  }
  if (keybar) {
    try { keybar.clearStickyModifiers(); } catch (e) {}
    try { keybar.destroy(); } catch (e) {}
    keybar = null;
  }

  uninstallSheetObserver();

  // We installed a handler on the TUI xterm; on the way out, install a
  // passthrough noop so any post-overlay keystrokes aren't filtered.
  installPassthroughKeyHandler();

  if (overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  overlayEl = null;
  emitKeybarResize();
}

export function showTuiKeybar(getTermId, getXterm) {
  if (typeof getTermId !== "function" || typeof getXterm !== "function") return;

  // Refresh thunks every call so same-session re-attach picks up new state.
  currentGetTermId = getTermId;
  currentGetXterm = getXterm;

  bindLifecycleListenersOnce();
  ensureCoarseMql();

  if (coarseMql && !coarseMql.matches) {
    // Desktop / fine-pointer device — don't render. Thunks are retained
    // so a coarse-flip later in the session can mount.
    return;
  }

  if (overlayEl) {
    // Idempotent: same-session re-attach. Re-install the xterm handler in
    // case the xterm instance changed underneath us.
    installXtermKeyHandler();
    return;
  }

  mountOverlay();
}

export function hideTuiKeybar() {
  if (overlayEl) unmountOverlay();
  // Drop thunks so a stray coarse-flip after detach doesn't re-mount
  // against a torn-down xterm.
  currentGetTermId = null;
  currentGetXterm = null;
}
