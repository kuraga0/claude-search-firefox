/**
 * Claude Search — Content Script
 *
 * Runs on claude.ai. When the URL contains a ?ext_prompt= parameter
 * (set by the search engine redirect), this script:
 *   1. Reads and parses the query (extracting model flags)
 *   2. Cleans the URL (removes ?q= so it looks normal)
 *   3. Attempts to select the requested model
 *   4. Injects the prompt into the chat editor
 *   5. Auto-submits by default (use -wait to disable)
 *
 * Flags (parsed from the query string):
 *   -opus   | -o    → Claude Opus   (default)
 *   -sonnet | -s    → Claude Sonnet
 *   -haiku  | -h    → Claude Haiku
 *   -wait   | -w    → Do NOT auto-submit (review first)
 */

(async function () {
  "use strict";

  // ── Guard: only run once per page ──────────────────────────────
  if (window.__claudeSearchInjected) return;
  window.__claudeSearchInjected = true;

  // ── Read the ?ext_prompt= parameter ─────────────────────────────
  const url = new URL(window.location.href);
  const rawQuery = url.searchParams.get("ext_prompt");

  if (!rawQuery) return;

  // ── Clean the URL immediately ──────────────────────────────────
  url.searchParams.delete("ext_prompt");
  const cleanUrl = url.pathname + (url.search || "") + (url.hash || "");
  history.replaceState(null, "", cleanUrl);

  // ── Parse flags ────────────────────────────────────────────────
  const MODEL_FLAGS = {
    "-opus": "opus",     "-o": "opus",
    "-sonnet": "sonnet", "-s": "sonnet",
    "-haiku": "haiku",   "-h": "haiku",
  };

  let model = "opus";
  let autoSend = true; // ON by default
  const promptTokens = [];

  for (const tok of rawQuery.trim().split(/\s+/)) {
    const lower = tok.toLowerCase();
		model = localStorage.getItem("lastModel");
		if (MODEL_FLAGS[lower]) {
      model = MODEL_FLAGS[lower];
    } else if (lower === "-wait" || lower === "-w") {
      autoSend = false;
    } else {
      promptTokens.push(tok);
    }
  }

  const prompt = promptTokens.join(" ");
  if (!prompt) return;

  console.log(`[Claude Search] Prompt: "${prompt}" | Model: ${model} | Auto-send: ${autoSend}`);

  // ── Constants ──────────────────────────────────────────────────
  const MAX_WAIT_MS = 15000;
  const POLL_MS = 300;

  // ── Helpers ────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findEditor() {
    return (
      document.querySelector(".ProseMirror[contenteditable='true']") ||
      document.querySelector("[contenteditable='true'][data-placeholder]") ||
      document.querySelector("div.ProseMirror") ||
      document.querySelector("div[contenteditable='true']")
    );
  }

  async function waitForEditor() {
    let elapsed = 0;
    while (elapsed < MAX_WAIT_MS) {
      const el = findEditor();
      if (el) return el;
      await sleep(POLL_MS);
      elapsed += POLL_MS;
    }
    return null;
  }

  // ── Inject text into editor ────────────────────────────────────
  // FIX: Only ONE strategy fires. The previous version fell through
  // when execCommand succeeded but the DOM hadn't updated for the
  // textContent check, causing double injection.
  function injectText(editor, text) {
    editor.focus();

    // Strategy 1: execCommand — best for ProseMirror
    // Trust the return value and STOP. Do not fall through.
    try {
      if (document.execCommand("insertText", false, text)) {
        return;
      }
    } catch (e) { /* not available */ }

    // Strategy 2: InputEvent dispatch (only runs if execCommand failed)
    try {
      editor.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
      editor.dispatchEvent(new InputEvent("input", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
      return;
    } catch (e) { /* not fully supported */ }

    // Strategy 3: Direct DOM write (last resort)
    const p = document.createElement("p");
    p.textContent = text;
    while (editor.firstChild) editor.removeChild(editor.firstChild);
    editor.appendChild(p);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── Model selection (best-effort) ──────────────────────────────
  async function trySelectModel(targetModel) {
    const candidates = [
      ...document.querySelectorAll("button[data-testid*='model']"),
      ...document.querySelectorAll("[class*='model-selector']"),
      ...document.querySelectorAll("[class*='ModelSelector']"),
      ...document.querySelectorAll("[aria-label*='odel']"),
    ];

    if (candidates.length === 0) {
      for (const btn of document.querySelectorAll("button")) {
        const txt = btn.textContent.toLowerCase();
        if (
          (txt.includes("opus") || txt.includes("sonnet") || txt.includes("haiku")) &&
          !txt.includes("send") && !txt.includes("stop")
        ) {
          candidates.push(btn);
        }
      }
    }

    if (candidates.length === 0) return;

    const selectorBtn = candidates[0];
    if (selectorBtn.textContent.toLowerCase().includes(targetModel)) return;

    selectorBtn.click();
    await sleep(500);

    const options = document.querySelectorAll(
      "[role='option'], [role='menuitem'], [role='menuitemradio'], [role='listbox'] *, [class*='option'], [class*='Option'], li"
    );

    for (const opt of options) {
      if (opt.textContent.toLowerCase().includes(targetModel)) {
        opt.click();
        await sleep(300);
        return;
      }
    }

    document.body.click();
  }

  // ── Auto-submit ────────────────────────────────────────────────
  async function tryAutoSubmit() {
    let attempts = 0;
    const maxAttempts = 20;

    while (attempts < maxAttempts) {
      const selectors = [
        "button[aria-label='Send message']",
        "button[aria-label='Send Message']",
        "[data-testid='send-button']",
        "button[type='submit']",
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) { btn.click(); return true; }
      }

      for (const btn of document.querySelectorAll("button:not([disabled])")) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("send")) { btn.click(); return true; }
      }

      attempts++;
      await sleep(300);
    }

    console.warn("[Claude Search] Send button not found or not enabled.");
    return false;
  }

  // ── Main ───────────────────────────────────────────────────────
  const editor = await waitForEditor();
  if (!editor) {
    console.warn("[Claude Search] Editor not found after timeout.");
    return;
  }

  await sleep(600);

  // Attempt model selection
  try {
    await trySelectModel(model);
		await sleep(400);
  } catch (e) {
    console.warn("[Claude Search] Model selection failed:", e.message);
  }

  const finalEditor = findEditor() || editor;

  // Inject the prompt
  injectText(finalEditor, prompt);

  // Auto-submit by default
  if (autoSend) {
    await sleep(600);
    await tryAutoSubmit();
  }

	// Save last used model
	localStorage.setItem("lastModel", model);

  console.log(`[Claude Search] Done — ${prompt.length} chars → ${model}${autoSend ? " [sent]" : " [waiting]"}`);
})();
