// ==UserScript==
// @name         bm_access_cfg Helper (PAT Setter)
// @namespace    local
// @version      1.0
// @description  UI zum Setzen von bm_access_cfg in localStorage
// @match        https://www.leitstellenspiel.de/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  const LS_KEY = "bm_access_cfg";
  const GM_KEY = "bm_access_pat";
  const SUFFIX = "@Taskforce-Nord/public";

  // 1) Früh setzen, damit andere Scripts es direkt finden
  try {
    const pat = GM_getValue(GM_KEY, "");
    if (pat) localStorage.setItem(LS_KEY, `${pat}${SUFFIX}`);
  } catch (e) {
    // document-start: UI noch nicht da. Ignorieren oder später anzeigen.
  }

  // 2) UI erst bauen, wenn DOM da ist
  window.addEventListener("DOMContentLoaded", () => {
    GM_addStyle(`
      #bmPatBtn{position:fixed;right:14px;bottom:14px;z-index:2147483647;
        padding:10px 12px;border-radius:999px;border:1px solid #777;
        background:#111;color:#fff;font:14px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial;
        box-shadow:0 6px 18px rgba(0,0,0,.25);}
      #bmPatModal{position:fixed;inset:0;z-index:2147483647;display:none;
        background:rgba(0,0,0,.35);align-items:center;justify-content:center;}
      #bmPatCard{width:min(520px,92vw);background:#fff;border-radius:14px;padding:14px 14px 12px;
        box-shadow:0 10px 30px rgba(0,0,0,.25);font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial;}
      #bmPatCard h3{margin:0 0 10px;font-size:16px}
      #bmPatRow{display:flex;gap:8px;align-items:center}
      #bmPatInput{flex:1;padding:10px;border:1px solid #bbb;border-radius:10px;font-size:14px}
      #bmPatToggle{padding:10px;border:1px solid #bbb;border-radius:10px;background:#f6f6f6}
      #bmPatActions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
      .bmBtn{padding:10px 12px;border-radius:10px;border:1px solid #999;background:#f6f6f6}
      .bmBtnPrimary{background:#111;color:#fff;border-color:#111}
      #bmPatHint{margin-top:8px;color:#444;font-size:12px;word-break:break-all}
      #bmPatStatus{margin-top:6px;color:#0a7a0a;font-size:12px;min-height:16px}
    `);

    const btn = document.createElement("button");
    btn.id = "bmPatBtn";
    btn.textContent = "PAT setzen";
    document.documentElement.appendChild(btn);

    const modal = document.createElement("div");
    modal.id = "bmPatModal";
    modal.innerHTML = `
      <div id="bmPatCard" role="dialog" aria-modal="true">
        <h3>bm_access_cfg setzen</h3>
        <div id="bmPatRow">
          <input id="bmPatInput" type="password" placeholder="github_pat_..." autocomplete="off" spellcheck="false" />
          <button id="bmPatToggle" type="button">anzeigen</button>
        </div>
        <div id="bmPatHint">Wird gespeichert als: <b><span id="bmPatPreview"></span></b></div>
        <div id="bmPatStatus"></div>
        <div id="bmPatActions">
          <button class="bmBtn" id="bmPatClear" type="button">Clear</button>
          <button class="bmBtn" id="bmPatClose" type="button">Schließen</button>
          <button class="bmBtn bmBtnPrimary" id="bmPatSave" type="button">Save + Reload</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(modal);

    const input = modal.querySelector("#bmPatInput");
    const toggle = modal.querySelector("#bmPatToggle");
    const preview = modal.querySelector("#bmPatPreview");
    const status = modal.querySelector("#bmPatStatus");

    const updatePreview = () => {
      const pat = (input.value || "").trim();
      preview.textContent = pat ? `${pat}${SUFFIX}` : `(leer)`;
      status.textContent = "";
    };

    // Prefill aus GM storage (nicht aus localStorage)
    const existing = GM_getValue(GM_KEY, "");
    if (existing) input.value = existing;
    updatePreview();

    btn.addEventListener("click", () => {
      modal.style.display = "flex";
      setTimeout(() => input.focus(), 0);
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });

    modal.querySelector("#bmPatClose").addEventListener("click", () => {
      modal.style.display = "none";
    });

    toggle.addEventListener("click", () => {
      const isPw = input.type === "password";
      input.type = isPw ? "text" : "password";
      toggle.textContent = isPw ? "verbergen" : "anzeigen";
    });

    input.addEventListener("input", updatePreview);

    modal.querySelector("#bmPatClear").addEventListener("click", () => {
      input.value = "";
      GM_deleteValue(GM_KEY);
      try { localStorage.removeItem(LS_KEY); } catch {}
      updatePreview();
      status.style.color = "#a00";
      status.textContent = "Gelöscht (localStorage + gespeicherter PAT).";
    });

    modal.querySelector("#bmPatSave").addEventListener("click", () => {
      const pat = (input.value || "").trim();

      // Minimalcheck – wenn du willst, strenger machen
      if (!pat.startsWith("github_pat_")) {
        status.style.color = "#a00";
        status.textContent = "Sieht nicht nach github_pat_... aus. Trotzdem speichern? -> Token prüfen.";
        // kein return; du kannst hier ein return machen, wenn du hart validieren willst
      }

      GM_setValue(GM_KEY, pat);
      try {
        localStorage.setItem(LS_KEY, `${pat}${SUFFIX}`);
      } catch (e) {
        status.style.color = "#a00";
        status.textContent = "Konnte localStorage nicht schreiben (Private Mode / Storage blockiert?).";
        return;
      }

      status.style.color = "#0a7a0a";
      status.textContent = "Gespeichert. Seite wird neu geladen…";
      setTimeout(() => location.reload(), 400);
    });
  });
})();
