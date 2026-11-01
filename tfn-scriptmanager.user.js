// ==UserScript==
// @name         TFN-Scriptmanager
// @namespace    https://tfn.tw/manager
// @version      1.3.20
// @description  Bootstrap: Session→Katalog→Enable→Fetch+Eval (RAM). UI wie V27.5 inkl. HTML-Anleitungen und Multi-Kategorie-Tabs. Kein GitHub/PAT.
// @author       Masklin
// @match        https://www.leitstellenspiel.de/*
// @match        https://leitstellenspiel.de/*
// @match        https://tfn.tw/0
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @connect      tfn.tw
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const MANAGER_VERSION = '1.3.20';
  const API_BASE = 'https://tfn.tw/manager';
  const API_USE_QUERY_FALLBACK = false; // true → …/index.php?r=api/…
  const DB_NAME = 'BM-DB-TN-v2';
  const DB_VERSION = 2; // v2: codeCache (Content über Navigation)
  const IDB_OPEN_TIMEOUT_MS = 3000;
  const CODE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h, Version-Mismatch invalidiert früher
  const CONTENT_FETCH_GAP_MS = 40;
  const RATE_LIMIT_RETRY_MS = 1600;
  const GM_SYNC_KEY = 'tfn_sync_enabled';
  const GM_SESSION_KEY = 'tfn_session_token';
  const GM_KILLED_KEY = 'tfn_client_killed';
  /** localStorage-Keys die Kill/Session betreffen (Seite) – nie bm_* (alter B&M parallel) */
  const LS_KILL_KEYS = ['tfn_killed', 'tfn_session_token', 'tfn_user_id'];
  const HEARTBEAT_MS = 60000;

  // Sofort sichtbar – darf nicht hinter openDb/IDB-Upgrade hängen
  try {
    console.log('[TFN] boot · v' + MANAGER_VERSION + ' ·', String(location.pathname || ''));
  } catch (_) {}

  /** Einmalig GM-Keys von ≤1.3.12 (bm_*) → tfn_* innerhalb DIESES Userscripts. Page-LS bm_* unberührt. */
  function migrateLegacyTfnGmKeys() {
    const pairs = [
      ['bm_session_token', GM_SESSION_KEY],
      ['bm_sync_enabled', GM_SYNC_KEY],
      ['bm_client_killed', GM_KILLED_KEY],
      ['bm_last_display_name', 'tfn_last_display_name'],
      ['bm_last_user_id', 'tfn_last_user_id'],
    ];
    pairs.forEach(([from, to]) => {
      try {
        const cur = GM_getValue(to, null);
        if (cur != null && cur !== '') return;
        const old = GM_getValue(from, null);
        if (old == null || old === '') return;
        GM_setValue(to, old);
        try { GM_deleteValue(from); } catch (_) {}
      } catch (_) {}
    });
  }

  /**
   * Seiten ohne LSS-user_id → Session-Host (Tool-Popups).
   * Früh definiert, damit document-start die 404-Shell vor dem Paint stoppen kann.
   */
  function isSessionHostPage() {
    try {
      const host = location.hostname || '';
      const path = location.pathname || '';
      if (/(?:^|\.)tfn\.tw$/i.test(host)) return true;
      if (/\/rgbl_by_tfn\/?$/i.test(path)) return true;
      if (!/leitstellenspiel\.de$/i.test(host)) return false;
      if (/^\/tfn\//i.test(path)) return true;
      if (/\/fr-manager\/?$/i.test(path)) return true;
      if (/\/verband\/manager\/?$/i.test(path)) return true;
    } catch (_) {}
    return false;
  }

  /** @deprecated alias */
  function isListHostPage() {
    return isSessionHostPage();
  }

  /** LSS-404 auf /tfn/* (etc.) vor Paint ausblenden */
  function suppressSessionHostFlash() {
    try { window.stop(); } catch (_) {}
    try {
      window.__TFN_HOST_SUPPRESSED__ = true;
      if (typeof unsafeWindow !== 'undefined') unsafeWindow.__TFN_HOST_SUPPRESSED__ = true;
    } catch (_) {}
    try {
      const html = document.documentElement;
      if (!html) return;
      html.innerHTML =
        '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>TFN</title>' +
        '<style>html,body{margin:0;background:#1a1a1a;color:#777;height:100%;font:14px/1.45 system-ui,Segoe UI,sans-serif}' +
        '#tfn-host-veil{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:#1a1a1a;z-index:2147483647;letter-spacing:0.02em}</style></head>' +
        '<body><div id="tfn-host-veil">TFN lädt…</div></body>';
    } catch (e) {
      try {
        const st = document.createElement('style');
        st.id = 'tfn-host-blank-css';
        st.textContent = 'html,body{background:#1a1a1a!important}body>*{visibility:hidden!important}#tfn-host-veil{visibility:visible!important;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1a1a;z-index:2147483647;color:#777}';
        (document.documentElement || document).appendChild(st);
      } catch (_) {}
    }
  }

  function setHostVeilMessage(msg) {
    try {
      const v = document.getElementById('tfn-host-veil');
      if (v) v.textContent = String(msg || 'TFN lädt…');
    } catch (_) {}
  }

  function clearHostVeil() {
    try {
      const v = document.getElementById('tfn-host-veil');
      if (v) v.remove();
    } catch (_) {}
  }
  const MANAGER_MANUAL_HTML = `
<div class="bm-manual-scope" style="font-family:Segoe UI,sans-serif;color:#222;line-height:1.55;padding:16px;">
  <h1 style="color:#0d6efd;border-bottom:2px solid #0d6efd;padding-bottom:8px;">TFN-Scriptmanager</h1>
  <p>Scripts kommen vom Server <code>tfn.tw/manager</code> (Session + Stufe). Kein GitHub/PAT.</p>
  <h2 style="color:#0b5ed7;">Bedienung</h2>
  <ol>
    <li>Kachel anklicken = gewählt (blau).</li>
    <li><strong>Änderungen anwenden</strong> oder Manager schließen speichert Enables (lokal + optional Sync).</li>
    <li>📖 auf der Kachel öffnet die Script-Anleitung (wenn hinterlegt).</li>
  </ol>
  <p class="note" style="background:#fff8e6;border-left:4px solid #f0ad4e;padding:10px;">Tool-Popups unter <code>/tfn/…</code> (und Legacy <code>/fr-manager</code>, <code>tfn.tw/0</code>, …) booten per GM-Session – zuerst normales LSS öffnen.</p>
</div>`;

  /** @type {IDBDatabase|null} */
  let db = null;
  /** @type {Map<number, string>} */
  const codeRam = new Map();
  /** @type {Array<object>} */
  let catalog = [];
  /** @type {{scriptId:number, enabled:boolean, config:object}[]} */
  let prefs = [];
  /** Draft-Enable vor „Änderungen anwenden“ (scriptId → bool) */
  let draftEnabled = {};
  /** Einmal-Warnungen für invalid_content / stale Prefs (scriptId) */
  const invalidContentWarned = new Set();
  const stalePrefWarned = new Set();
  let sessionToken = null;
  let permissionLevel = 0;
  let syncEnabled = GM_getValue(GM_SYNC_KEY, true);
  let heartbeatTimer = null;
  let killed = false;
  let managerUiCreated = false;
  let bootStatus = 'starting'; // starting|ok|offline|maintenance|off|error
  let bootMessage = '';
  let filterText = '';
  /** Nach Kill-Wipe: Banner + Server-Prefs-Restore */
  let recoveredFromKill = false;
  let recoveryNote = '';
  /** @type {{id:number,slug:string,title:string,sort_order:number}[]} */
  let categories = [];
  let activeCategoryTab = 'Alle';

  // -------------------------------------------------------------------------
  // Page identity
  // -------------------------------------------------------------------------
  function readPageUser() {
    let uid = null;
    let name = null;
    const pickName = (v) => {
      if (v == null) return;
      const s = String(v).trim();
      if (s) name = s;
    };
    try {
      if (typeof unsafeWindow !== 'undefined') {
        if (typeof unsafeWindow.user_id !== 'undefined') uid = unsafeWindow.user_id;
        if (typeof unsafeWindow.username !== 'undefined') pickName(unsafeWindow.username);
        if (!name && typeof unsafeWindow.user_name !== 'undefined') pickName(unsafeWindow.user_name);
      }
    } catch (_) {}
    try {
      if (uid == null && typeof user_id !== 'undefined') uid = user_id;
      if (!name && typeof username !== 'undefined') pickName(username);
      if (!name && typeof user_name !== 'undefined') pickName(user_name);
    } catch (_) {}
    if (uid == null) {
      const el = document.querySelector('[data-user-id], #user_id');
      if (el) uid = el.getAttribute('data-user-id') || el.textContent;
    }
    if (!name) {
      const profile =
        document.querySelector('#navbar_profile_link, a[href*="/profile/"] .navbar-username, .navbar-user-name, #profile_name');
      if (profile) pickName(profile.textContent);
    }
    if (!name) {
      try {
        const cached = GM_getValue('tfn_last_display_name', '');
        if (cached) pickName(cached);
      } catch (_) {}
    }
    const userId = parseInt(String(uid), 10);
    const displayName = name ? String(name).slice(0, 128) : null;
    return {
      user_id: Number.isFinite(userId) && userId > 0 ? userId : null,
      display_name: displayName,
    };
  }

  // -------------------------------------------------------------------------
  // IndexedDB – prefs + codeCache (Content, versioniert)
  // openDb darf session/start NIE blockieren: Timeout + onblocked.
  // -------------------------------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, database) => {
        if (settled) return;
        settled = true;
        try { clearTimeout(timer); } catch (_) {}
        if (err) {
          db = null;
          reject(err);
        } else {
          db = database || null;
          resolve(db);
        }
      };

      const timer = setTimeout(() => {
        console.warn(
          '[TFN] IndexedDB open Timeout (' + IDB_OPEN_TIMEOUT_MS +
            'ms) – fahre ohne IDB fort (andere Tabs halten evtl. alte DB-Version).'
        );
        finish(new Error('idb_open_timeout'));
      }, IDB_OPEN_TIMEOUT_MS);

      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        finish(e || new Error('idb_open_throw'));
        return;
      }

      req.onupgradeneeded = (ev) => {
        try {
          console.log('[TFN] IndexedDB Upgrade → v' + DB_VERSION);
          const database = ev.target.result;
          if (!database.objectStoreNames.contains('prefs')) {
            database.createObjectStore('prefs', { keyPath: 'scriptId' });
          }
          if (!database.objectStoreNames.contains('codeCache')) {
            database.createObjectStore('codeCache', { keyPath: 'scriptId' });
          }
        } catch (e) {
          console.warn('[TFN] IndexedDB Upgrade-Fehler', e);
        }
      };
      req.onblocked = () => {
        console.warn(
          '[TFN] IndexedDB open blocked – anderer Tab hält Verbindung. Warte max ' +
            IDB_OPEN_TIMEOUT_MS + 'ms, dann Boot ohne IDB.'
        );
      };
      req.onsuccess = (ev) => {
        const database = ev.target.result;
        try {
          database.onversionchange = () => {
            try { database.close(); } catch (_) {}
            if (db === database) db = null;
            console.warn('[TFN] IndexedDB versionchange – Verbindung geschlossen.');
          };
        } catch (_) {}
        finish(null, database);
      };
      req.onerror = () => {
        finish(req.error || new Error('idb_open_error'));
      };
    });
  }

  function idbGetCode(scriptId) {
    return new Promise((resolve) => {
      if (!db || !db.objectStoreNames.contains('codeCache')) return resolve(null);
      try {
        const tx = db.transaction('codeCache', 'readonly');
        const r = tx.objectStore('codeCache').get(Number(scriptId));
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  function idbPutCode(entry) {
    return new Promise((resolve) => {
      if (!db || !db.objectStoreNames.contains('codeCache')) return resolve();
      try {
        const tx = db.transaction('codeCache', 'readwrite');
        tx.objectStore('codeCache').put({
          scriptId: Number(entry.scriptId),
          version: String(entry.version || ''),
          content: String(entry.content || ''),
          cachedAt: Number(entry.cachedAt) || Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function idbAllPrefs() {
    return new Promise((resolve, reject) => {
      if (!db) return resolve([]);
      const tx = db.transaction('prefs', 'readonly');
      const r = tx.objectStore('prefs').getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  function idbPutPref(pref) {
    return new Promise((resolve, reject) => {
      if (!db) return resolve();
      const tx = db.transaction('prefs', 'readwrite');
      tx.objectStore('prefs').put({
        scriptId: pref.scriptId,
        enabled: !!pref.enabled,
        config: pref.config && typeof pref.config === 'object' ? pref.config : {},
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function idbClearAll() {
    return new Promise((resolve) => {
      const finish = () => {
        try {
          const keys = GM_listValues();
          keys.forEach((k) => GM_deleteValue(k));
        } catch (_) {}
        resolve();
      };
      if (!db) {
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = finish;
        del.onerror = finish;
        del.onblocked = finish;
        return;
      }
      try { db.close(); } catch (_) {}
      db = null;
      const del = indexedDB.deleteDatabase(DB_NAME);
      del.onsuccess = finish;
      del.onerror = finish;
      del.onblocked = finish;
    });
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------
  function apiUrl(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    if (API_USE_QUERY_FALLBACK) {
      return API_BASE + '/index.php?r=' + encodeURIComponent(p.replace(/^\//, ''));
    }
    return API_BASE + p;
  }

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (sessionToken) {
        headers['Authorization'] = 'Bearer ' + sessionToken;
        headers['X-BM-Session'] = sessionToken;
      }
      GM_xmlhttpRequest({
        method,
        url: apiUrl(path),
        headers,
        data: body != null ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload: (res) => {
          const raw = String(res.responseText || '');
          const trimmed = raw.trim();
          // HTML-Fehlerseite (DOCTYPE / <br / PHP warning) nie als JSON/Content behandeln
          if (/^</.test(trimmed) || /^<!DOCTYPE/i.test(trimmed)) {
            const err = new Error('API lieferte HTML statt JSON (Route/Proxy/PHP-Fehler).');
            err.status = res.status;
            err.kind = 'http';
            err.payload = { error: 'html_response', preview: trimmed.slice(0, 120) };
            reject(err);
            return;
          }
          let data = null;
          let parseOk = false;
          try {
            data = JSON.parse(raw);
            parseOk = true;
          } catch (_) {}
          if (res.status >= 200 && res.status < 300) {
            if (!parseOk || data == null || typeof data !== 'object') {
              const err = new Error('API-Antwort kein JSON.');
              err.status = res.status;
              err.kind = 'http';
              err.payload = { error: 'invalid_json', preview: trimmed.slice(0, 120) };
              reject(err);
              return;
            }
            resolve(data);
          } else {
            const err = new Error((data && data.message) || ('HTTP ' + res.status));
            err.status = res.status;
            err.payload = data;
            err.kind = 'http';
            reject(err);
          }
        },
        onerror: () => {
          const err = new Error('network_error');
          err.kind = 'network';
          reject(err);
        },
        ontimeout: () => {
          const err = new Error('timeout');
          err.kind = 'network';
          reject(err);
        },
      });
    });
  }

  function formatApiError(e) {
    if (!e) return 'Unbekannter Fehler';
    if (e.kind === 'network' || e.message === 'network_error' || e.message === 'timeout') {
      return 'Server nicht erreichbar (Netzwerk/@connect). Es werden keine Scripts ausgeführt.';
    }
    const msg = (e.payload && e.payload.message) || e.message || 'Fehler';
    const code = (e.payload && e.payload.error) || ('HTTP ' + (e.status || '?'));
    return 'API-Fehler: ' + code + ' – ' + msg;
  }

  // -------------------------------------------------------------------------
  // Kill-Switch + From-scratch-Recovery nach Re-Freigabe
  // -------------------------------------------------------------------------
  /**
   * Wo der Kill lebt:
   * - Server: users.permission_level = −1 und/oder system_state.mode = 'kill'
   *   (entscheidet session/start → action=kill)
   * - Client (nur UI/Prefs wipe, blockiert Boot NICHT dauerhaft wenn Server wieder ok):
   *   GM: tfn_client_killed, tfn_session_token (+ idbClearAll löscht ALLE GM_*-Keys dieses Scripts)
   *   localStorage: tfn_killed, tfn_session_token, tfn_user_id (nie bm_* – B&M parallel)
   *   IndexedDB: BM-DB-TN-v2 (ObjectStore prefs) – wird gelöscht
   *   RAM: Variable killed
   */
  function clientKillFlagsPresent() {
    let gm = false;
    try { gm = !!GM_getValue(GM_KILLED_KEY); } catch (_) {}
    let ls = false;
    try { ls = localStorage.getItem('tfn_killed') === '1'; } catch (_) {}
    let ss = false;
    try { ss = sessionStorage.getItem('tfn_killed') === '1'; } catch (_) {}
    return gm || ls || ss || killed;
  }

  function clearAllKillClientState() {
    killed = false;
    try { GM_deleteValue(GM_KILLED_KEY); } catch (_) {}
    try { GM_deleteValue(GM_SESSION_KEY); } catch (_) {}
    try {
      LS_KILL_KEYS.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
    try {
      sessionStorage.removeItem('tfn_killed');
      sessionStorage.removeItem('tfn_session_token');
    } catch (_) {}
  }

  function clearPageSessionArtifacts() {
    try {
      LS_KILL_KEYS.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }

  async function performKill(reason) {
    if (killed) return;
    killed = true;
    codeRam.clear();
    catalog = [];
    prefs = [];
    draftEnabled = {};
    sessionToken = null;
    bootStatus = 'kill';
    bootMessage = reason || 'gesperrt';
    recoveredFromKill = false;
    recoveryNote = '';
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try { GM_setValue(GM_KILLED_KEY, true); } catch (_) {}
    try { GM_deleteValue(GM_SESSION_KEY); } catch (_) {}
    clearPageSessionArtifacts();
    try { localStorage.setItem('tfn_killed', '1'); } catch (_) {}
    await idbClearAll();
    // Nach idbClearAll sind GM-Values weg – Kill-Marker erneut setzen
    try { GM_setValue(GM_KILLED_KEY, true); } catch (_) {}
    try { localStorage.setItem('tfn_killed', '1'); } catch (_) {}

    const link = document.getElementById('tfn-scriptmanager-link');
    if (link) {
      const li = link.closest('li');
      if (li) li.remove();
      else link.remove();
    }
    const container = document.getElementById('tfn-script-manager-container');
    if (container) container.remove();
    managerUiCreated = false;
    console.warn('[TFN] Kill-Switch (Server sagte kill/level<0):', reason || 'gesperrt');
  }

  /**
   * Bei JEDEM erfolgreichen session/start (action=ok, level≥0):
   * Kill-Flags löschen (kein GM-Zugang nötig). Bei vorherigem Kill:
   * Sync wieder an, IDB neu, Menü neu. Server-Prefs kommen danach per pull.
   * @returns {Promise<boolean>} true wenn Kill-Flags / Wipe vorlagen
   */
  async function recoverFromKillIfNeeded() {
    const wasKilled = clientKillFlagsPresent();
    clearAllKillClientState();
    bootStatus = 'starting';
    bootMessage = '';

    if (wasKilled) {
      // Nach Wipe ist GM_SYNC_KEY weg – Sync wieder an, damit Server-Enables zurückkommen
      syncEnabled = true;
      try { GM_setValue(GM_SYNC_KEY, true); } catch (_) {}
    } else {
      syncEnabled = GM_getValue(GM_SYNC_KEY, true);
    }

    try {
      if (db) {
        try { db.close(); } catch (_) {}
        db = null;
      }
      await openDb();
      prefs = (await idbAllPrefs()).map((p) => ({
        scriptId: Number(p.scriptId),
        enabled: !!p.enabled,
        config: p.config || {},
      }));
    } catch (e) {
      console.warn('[TFN] DB nach Recovery:', e);
      prefs = [];
      try { await openDb(); } catch (_) {}
    }

    managerUiCreated = false;
    initUIHooks();
    if (wasKilled) {
      console.log('[TFN] Kill-State cleared (GM/localStorage) · from-scratch · warte auf Server-Prefs');
    }
    return wasKilled;
  }

  // -------------------------------------------------------------------------
  // Match + Exec (RAM) – Verhalten angelehnt an V27.5
  // -------------------------------------------------------------------------
  function normalizePatterns(patterns) {
    if (patterns == null) return [];
    if (typeof patterns === 'string') {
      const t = patterns.trim();
      if (!t) return [];
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch (_) {}
      return [t];
    }
    if (Array.isArray(patterns)) return patterns.map(String);
    return [];
  }

  /**
   * Pattern → RegExp. Tampermonkey-nah:
   * - `*.host` matcht auch Apex `host` (Subdomain optional)
   * - übrige `*` → `.*` (V27.5)
   * - ohne Protokoll: gegen Host+Pfad bzw. volle href
   */
  function patternToRegExp(pattern) {
    let p = String(pattern).trim();
    if (!p) return null;
    // *.host.tld → optionaler Subdomain-Prefix (nicht „mindestens ein Label“)
    p = p.replace(/\*\./g, '<<<SUB>>>');
    p = p.replace(/\*/g, '<<<STAR>>>');
    p = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    p = p.replace(/<<<SUB>>>/g, '(?:.*\\.)?');
    p = p.replace(/<<<STAR>>>/g, '.*');
    return new RegExp(p, 'i');
  }

  function urlMatches(patterns) {
    const href = String(location.href);
    let hostPath = '';
    try {
      const u = new URL(href);
      hostPath = u.host + u.pathname + u.search + u.hash;
    } catch (_) {
      hostPath = href;
    }
    const list = normalizePatterns(patterns);
    if (!list.length) return true;
    return list.some((pattern) => {
      const raw = String(pattern).trim();
      if (!raw) return false;
      try {
        const re = patternToRegExp(raw);
        if (!re) return false;
        if (re.test(href)) return true;
        // Pattern ohne Schema (z.B. *.leitstellenspiel.de/*)
        if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && re.test(hostPath)) return true;
        // Apex-Variante zusätzlich: https://*.host → https://host
        if (raw.includes('*.')) {
          const apex = raw.replace('://*.', '://');
          if (apex !== raw) {
            const reApex = patternToRegExp(apex);
            if (reApex && reApex.test(href)) return true;
          }
        }
        return false;
      } catch (_) {
        return href.indexOf(raw) !== -1;
      }
    });
  }

  function getConfigFor(scriptId) {
    const id = Number(scriptId);
    const p = prefs.find((x) => Number(x.scriptId) === id);
    return (p && p.config) || {};
  }

  function isEnabled(scriptId) {
    const id = Number(scriptId);
    const p = prefs.find((x) => Number(x.scriptId) === id);
    return !!(p && p.enabled);
  }

  function prepareCode(code) {
    let body = String(code).replace(/^\uFEFF/, '');
    // Vollständige Userscript-Metablöcke entfernen (api-fetcher o.ä.)
    body = body.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/m, '\n');
    return body;
  }

  /**
   * Echte Tampermonkey-GM-APIs in den Seitenkontext spiegeln
   * (Gebäudeliste / API-Fetcher: Cross-Origin GM_xmlhttpRequest / GM_setValue / Listener).
   * Wichtig: Child-Scripts haben kein eigenes @connect – Aufrufe laufen über dieses
   * Manager-Skript (@connect *). TM fragt einmal „Allow all domains?“ ab.
   */
  function installPageGmBridge() {
    try {
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!uw || uw.__TFN_GM_BRIDGE__) return;
      uw.__TFN_GM_BRIDGE__ = true;
      uw.GM_getValue = GM_getValue;
      uw.GM_setValue = GM_setValue;
      uw.GM_deleteValue = GM_deleteValue;
      uw.GM_listValues = GM_listValues;
      uw.GM_xmlhttpRequest = GM_xmlhttpRequest;
      if (typeof GM_addValueChangeListener === 'function') {
        uw.GM_addValueChangeListener = GM_addValueChangeListener;
      }
      if (typeof GM_addStyle === 'function') {
        uw.GM_addStyle = GM_addStyle;
      }
      console.log('[TFN] GM-Bridge aktiv (Seitenkontext, @connect *)');
    } catch (e) {
      console.warn('[TFN] GM-Bridge fehlgeschlagen', e);
    }
  }

  /** Host-Seiten: diese Slugs ggf. forcen, falls Prefs leer / from-scratch */
  const HOST_AUTO_ENABLE_SLUGS = ['reale-gebaeudeliste', 'lss-fr-pro', 'verbands-gebaeude-manager'];

  /**
   * Im Seitenkontext ausführen (wie @grant none). Sandbox-new Function
   * sieht LSS-Globals nicht – deshalb unsafeWindow.eval.
   */
  function looksLikeHtmlNotJs(code) {
    const t = String(code || '').replace(/^\uFEFF/, '').trim();
    if (!t) return true;
    if (/^</.test(t)) return true;
    if (/^<!DOCTYPE/i.test(t)) return true;
    if (/^<html[\s>]/i.test(t)) return true;
    return false;
  }

  function executeScriptCode(code, label) {
    const body = prepareCode(code);
    if (!body.trim()) {
      console.warn('[TFN] Leerer Code nach Prepare:', label);
      return false;
    }
    if (looksLikeHtmlNotJs(body)) {
      console.error(
        '[TFN] Exec verweigert – Content ist HTML/kein JS:',
        label,
        'preview=',
        body.trim().slice(0, 80)
      );
      return false;
    }
    try {
      installPageGmBridge();
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
      if (uw && typeof uw.eval === 'function') {
        uw.eval(body);
      } else {
        // eslint-disable-next-line no-eval
        (0, eval)(body);
      }
      return true;
    } catch (e) {
      console.error('[TFN] Exec-Fehler', label, e);
      return false;
    }
  }

  // Manager-API auf der Seite (TFN-only). BMScriptManager nur setzen wenn frei –
  // alten B&M-Manager nicht überschreiben (Parallelbetrieb).
  const managerApi = {
    version: MANAGER_VERSION,
    get sessionToken() { return sessionToken; },
    /** Server-Stufe aus session/start – für Child-Scripts (z. B. Mastermind Extended ≥ 10) */
    get permissionLevel() { return permissionLevel; },
    getConfig: function (slugOrId) {
      if (typeof slugOrId === 'number') return getConfigFor(slugOrId);
      const s = catalog.find((c) => c.slug === slugOrId || Number(c.id) === Number(slugOrId));
      return s ? getConfigFor(s.id) : {};
    },
  };
  /** Page-native Plain-Values (Sandbox-Getter auf managerApi sind aus unsafeWindow.eval oft tot). */
  function publishPageGlobal(name, value, scriptId) {
    const assign = (target) => {
      if (!target) return;
      try { target[name] = value; } catch (_) {}
      try {
        Object.defineProperty(target, name, {
          value: value,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (_) {
        try { target[name] = value; } catch (_) {}
      }
    };
    try { assign(typeof unsafeWindow !== 'undefined' ? unsafeWindow : null); } catch (_) {}
    try { assign(window); } catch (_) {}
    try {
      const doc = (typeof unsafeWindow !== 'undefined' && unsafeWindow.document)
        ? unsafeWindow.document
        : document;
      let el = doc.getElementById(scriptId);
      if (!el) {
        el = doc.createElement('script');
        el.id = scriptId;
        el.type = 'text/javascript';
        (doc.documentElement || doc.head || doc.body || doc).appendChild(el);
      }
      el.textContent = 'window.' + name + '=' + JSON.stringify(value) + ';';
    } catch (_) {}
  }

  function publishPermissionLevelToPage(level) {
    const n = Number(level);
    const v = Number.isFinite(n) ? n : 0;
    publishPageGlobal('__TFN_PERMISSION_LEVEL__', v, 'tfn-permission-level-boot');
    try { localStorage.setItem('tfn_permission_level', String(v)); } catch (_) {}
  }

  function publishSessionTokenToPage(token) {
    const t = token ? String(token) : '';
    if (!t) return;
    publishPageGlobal('__TFN_SESSION_TOKEN__', t, 'tfn-session-token-boot');
    try { localStorage.setItem('tfn_session_token', t); } catch (_) {}
  }

  function publishManagerApi() {
    try { window.TFNScriptManager = managerApi; } catch (_) {}
    try {
      if (typeof unsafeWindow !== 'undefined') unsafeWindow.TFNScriptManager = managerApi;
    } catch (_) {}
    // Compat für TFN-Content: nur wenn B&M den Namen noch nicht belegt
    try {
      if (typeof window.BMScriptManager === 'undefined') window.BMScriptManager = managerApi;
    } catch (_) {}
    try {
      if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.BMScriptManager === 'undefined') {
        unsafeWindow.BMScriptManager = managerApi;
      }
    } catch (_) {}
    publishPermissionLevelToPage(permissionLevel);
    if (sessionToken) publishSessionTokenToPage(sessionToken);
  }
  publishManagerApi();

  function publishSessionToPage(userId) {
    // Nur tfn_*-Keys – bm_session_token / bm_user_id / bm_killed dem alten B&M überlassen
    try {
      if (userId) localStorage.setItem('tfn_user_id', String(userId));
    } catch (_) {}
    if (sessionToken) publishSessionTokenToPage(sessionToken);
    publishPermissionLevelToPage(permissionLevel);
    publishManagerApi();
  }

  /**
   * Pref für kaputten Content (422/HTML) dauerhaft aus – einmal warnen, optional Sync.
   * @param {number} sid
   * @param {string} label
   * @param {string} reason
   */
  async function disablePrefInvalidContent(sid, label, reason) {
    const id = Number(sid);
    let pref = prefs.find((p) => Number(p.scriptId) === id);
    if (!pref) {
      pref = { scriptId: id, enabled: false, config: {} };
      prefs.push(pref);
    }
    const wasEnabled = !!pref.enabled;
    pref.enabled = false;
    draftEnabled[id] = false;
    codeRam.delete(id);
    try { await idbPutPref(pref); } catch (_) {}
    if (!invalidContentWarned.has(id)) {
      invalidContentWarned.add(id);
      console.warn(
        '[TFN] Pref deaktiviert (invalid content):',
        label,
        'id=' + id,
        reason || '',
        wasEnabled ? '(war enabled)' : ''
      );
    }
    if (wasEnabled && syncEnabled) {
      try { await pushServerPrefs(); } catch (_) {}
    }
  }

  /** Enabled-Prefs deren Script nicht (mehr) im Katalog ist → skip + Pref aus. */
  async function pruneStaleEnabledPrefs() {
    const catalogIds = new Set(catalog.map((s) => Number(s.id)));
    let pruned = 0;
    for (const pref of prefs) {
      const sid = Number(pref.scriptId);
      if (!pref.enabled || catalogIds.has(sid)) continue;
      pref.enabled = false;
      draftEnabled[sid] = false;
      try { await idbPutPref(pref); } catch (_) {}
      pruned++;
      if (!stalePrefWarned.has(sid)) {
        stalePrefWarned.add(sid);
        console.warn(
          '[TFN] Stale Pref deaktiviert (Script nicht im Katalog / inaktiv): id=' + sid
        );
      }
    }
    if (pruned && syncEnabled) {
      try { await pushServerPrefs(); } catch (_) {}
    }
    return pruned;
  }

  function isRateLimitError(e) {
    if (!e) return false;
    if (Number(e.status) === 429) return true;
    const code = e.payload && e.payload.error;
    return code === 'rate_limited';
  }

  function rememberCode(sid, version, rawContent) {
    const id = Number(sid);
    codeRam.set(id, rawContent);
    idbPutCode({
      scriptId: id,
      version: version || '',
      content: rawContent,
      cachedAt: Date.now(),
    }).catch(() => {});
  }

  /** IDB/RAM-Cache wenn Version zum Katalog passt und nicht zu alt. */
  async function hydrateCodeFromCache(script) {
    const sid = Number(script.id);
    if (codeRam.has(sid)) return true;
    const cached = await idbGetCode(sid);
    if (!cached || !cached.content) return false;
    const catVer = String(script.version || '');
    if (catVer && String(cached.version || '') !== catVer) return false;
    const age = Date.now() - Number(cached.cachedAt || 0);
    if (age > CODE_CACHE_MAX_AGE_MS) return false;
    if (looksLikeHtmlNotJs(cached.content)) return false;
    codeRam.set(sid, cached.content);
    return true;
  }

  /**
   * Einzel-Content mit einmaligem 429-Backoff. Rate-Limit deaktiviert KEINE Prefs.
   * @returns {Promise<string|null>}
   */
  async function fetchScriptContent(script) {
    const sid = Number(script.id);
    const label = script.slug || ('#' + sid);
    const tryOnce = () => api('GET', '/api/scripts/' + sid + '/content');
    let res;
    try {
      res = await tryOnce();
    } catch (e) {
      if (isRateLimitError(e)) {
        console.warn('[TFN] Rate-Limit 429 – Retry in', RATE_LIMIT_RETRY_MS, 'ms:', label);
        await sleepMs(RATE_LIMIT_RETRY_MS);
        try {
          res = await tryOnce();
        } catch (e2) {
          if (isRateLimitError(e2)) {
            console.warn('[TFN] Rate-Limit weiter – Pref bleibt enabled:', label);
            throw e2;
          }
          throw e2;
        }
      } else {
        throw e;
      }
    }
    const rawContent = res && typeof res.content === 'string' ? res.content : '';
    if (!rawContent.trim()) {
      console.error('[TFN] Content leer/ungültig:', label, res && res.error ? res : '(kein content)');
      return null;
    }
    if (looksLikeHtmlNotJs(rawContent)) {
      await disablePrefInvalidContent(
        sid,
        label,
        'HTML statt JS (preview=' + rawContent.trim().slice(0, 60) + ')'
      );
      return null;
    }
    rememberCode(sid, (res && res.version) || script.version, rawContent);
    return rawContent;
  }

  /** Bulk-Content; fehlende IDs bleiben ohne codeRam-Eintrag. */
  async function fetchContentBulk(scripts) {
    if (!scripts.length) return;
    const ids = scripts.map((s) => Number(s.id));
    const byId = new Map(scripts.map((s) => [Number(s.id), s]));
    let res;
    try {
      res = await api('POST', '/api/scripts/content/bulk', { ids });
    } catch (e) {
      if (isRateLimitError(e)) {
        console.warn('[TFN] Bulk Rate-Limit 429 – Retry einmal');
        await sleepMs(RATE_LIMIT_RETRY_MS);
        try {
          res = await api('POST', '/api/scripts/content/bulk', { ids });
        } catch (e2) {
          console.warn('[TFN] Bulk weiterhin rate-limited – Fallback sequentiell');
          return;
        }
      } else {
        console.warn('[TFN] Bulk-Content fehlgeschlagen – Fallback sequentiell', e);
        return;
      }
    }
    const list = res && Array.isArray(res.scripts) ? res.scripts : [];
    for (const item of list) {
      const sid = Number(item && item.id);
      const script = byId.get(sid);
      const label = (script && script.slug) || (item && item.slug) || ('#' + sid);
      if (!item || item.ok === false || item.error) {
        const err = item && item.error;
        if (err === 'rate_limited') {
          console.warn('[TFN] Bulk Teil-429 – Pref bleibt enabled:', label);
          continue;
        }
        if (err === 'invalid_content') {
          await disablePrefInvalidContent(sid, label, 'bulk invalid_content');
          continue;
        }
        if (err === 'not_found') {
          await disablePrefInvalidContent(sid, label, 'bulk 404 not_found');
          continue;
        }
        continue;
      }
      const rawContent = typeof item.content === 'string' ? item.content : '';
      if (!rawContent.trim() || looksLikeHtmlNotJs(rawContent)) {
        await disablePrefInvalidContent(sid, label, 'bulk HTML/leer');
        continue;
      }
      rememberCode(sid, item.version || (script && script.version), rawContent);
    }
  }

  async function fetchAndRunEnabled() {
    if (killed) return;
    if (bootStatus !== 'ok' && bootStatus !== 'starting') {
      console.warn('[TFN] Kein Script-Lauf, Status:', bootStatus);
      return;
    }

    await pruneStaleEnabledPrefs();

    const enabledIds = new Set(
      prefs.filter((p) => p.enabled).map((p) => Number(p.scriptId))
    );
    const active = [];
    let ran = 0;

    if (!enabledIds.size) {
      console.log('[TFN] Keine aktivierten Scripts (Prefs). UI-Blau ohne „Änderungen anwenden“ zählt nicht.');
    }

    /** @type {object[]} */
    const toFetch = [];
    for (const script of catalog) {
      const sid = Number(script.id);
      const label = script.slug || ('#' + sid);
      if (!enabledIds.has(sid)) continue;
      if (!urlMatches(script.match_patterns)) {
        console.warn('[TFN] Skip (match):', label, script.match_patterns, 'href=', location.href);
        continue;
      }
      const hit = await hydrateCodeFromCache(script);
      if (!hit) toFetch.push(script);
    }

    if (toFetch.length) {
      await fetchContentBulk(toFetch);
    }

    for (const script of toFetch) {
      const sid = Number(script.id);
      if (codeRam.has(sid)) continue;
      const label = script.slug || ('#' + sid);
      try {
        await sleepMs(CONTENT_FETCH_GAP_MS);
        await fetchScriptContent(script);
      } catch (e) {
        const errCode = e && e.payload && e.payload.error;
        if (isRateLimitError(e)) {
          // absichtlich kein disablePref
          console.warn('[TFN] Fetch übersprungen (429 rate_limited), Pref bleibt:', label);
          continue;
        }
        const isInvalidContent =
          (e && Number(e.status) === 422) || errCode === 'invalid_content';
        if (isInvalidContent) {
          await disablePrefInvalidContent(
            sid,
            label,
            'HTTP 422 ' + (errCode || 'invalid_content')
          );
          continue;
        }
        if (e && Number(e.status) === 404) {
          await disablePrefInvalidContent(sid, label, 'HTTP 404 not_found');
          continue;
        }
        console.error('[TFN] Fetch/Exec-Fehler', label, e);
      }
    }

    for (const script of catalog) {
      const sid = Number(script.id);
      const label = script.slug || ('#' + sid);
      if (!enabledIds.has(sid)) continue;
      if (!urlMatches(script.match_patterns)) continue;
      const code = codeRam.get(sid);
      if (!code) continue;
      try {
        if (executeScriptCode(code, label)) {
          active.push(sid);
          ran++;
        }
      } catch (e) {
        console.error('[TFN] Exec-Fehler', label, e);
      }
    }

    console.log('[TFN]', ran, 'Module geladen (enabled=' + enabledIds.size + ', katalog=' + catalog.length + ').');

    try {
      await api('POST', '/api/stats/heartbeat', { active_script_ids: active });
    } catch (_) {}
  }

  /**
   * Server-Prefs holen und in RAM+IDB schreiben.
   * @param {{force?: boolean}} [opts] force=true auch wenn Sync-Toggle aus (Kill-Recovery)
   * @returns {Promise<{pulled:number, enabledFromServer:number, error?: string}>}
   */
  async function pullServerPrefs(opts) {
    const force = !!(opts && opts.force);
    if (!syncEnabled && !force) {
      return { pulled: 0, enabledFromServer: 0 };
    }
    try {
      const res = await api('GET', '/api/prefs/sync');
      if (!res || !Array.isArray(res.prefs)) {
        return { pulled: 0, enabledFromServer: 0 };
      }
      let pulled = 0;
      let enabledFromServer = 0;
      for (const item of res.prefs) {
        const scriptId = Number(item.script_id);
        if (!scriptId) continue;
        let local = prefs.find((p) => Number(p.scriptId) === scriptId);
        if (!local) {
          local = { scriptId, enabled: false, config: {} };
          prefs.push(local);
        }
        if (item.config && typeof item.config === 'object') {
          local.config = Object.assign({}, local.config, item.config);
        }
        if (item.enabled != null) {
          local.enabled = !!item.enabled;
          if (local.enabled) enabledFromServer++;
        }
        local.scriptId = scriptId;
        await idbPutPref(local);
        pulled++;
      }
      console.log('[TFN] prefs/sync GET:', pulled, 'Einträge,', enabledFromServer, 'enabled');
      return { pulled, enabledFromServer };
    } catch (e) {
      console.warn('[TFN] prefs/sync GET fehlgeschlagen', e);
      return { pulled: 0, enabledFromServer: 0, error: formatApiError(e) };
    }
  }

  async function pushServerPrefs() {
    if (!syncEnabled) return;
    try {
      await api('PUT', '/api/prefs/sync', {
        sync_enabled: true,
        prefs: prefs.map((p) => ({
          script_id: p.scriptId,
          enabled: p.enabled,
          config: p.config || {},
        })),
      });
    } catch (_) {}
  }

  function ensurePrefsForCatalog() {
    for (const s of catalog) {
      const sid = Number(s.id);
      if (!prefs.find((p) => Number(p.scriptId) === sid)) {
        prefs.push({ scriptId: sid, enabled: false, config: {} });
      }
    }
    // IDs normalisieren (IndexedDB kann Number/String mischen)
    prefs = prefs.map((p) => ({
      scriptId: Number(p.scriptId),
      enabled: !!p.enabled,
      config: p.config && typeof p.config === 'object' ? p.config : {},
    }));
    draftEnabled = {};
    prefs.forEach((p) => { draftEnabled[p.scriptId] = !!p.enabled; });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -------------------------------------------------------------------------
  // UI – Look/Feel wie V27.5, Einstieg über Profilmenü
  // -------------------------------------------------------------------------
  function ensureStyles() {
    if (document.getElementById('tfn-mvp-styles')) return;
    GM_addStyle(`
      :root {
        --bm-bg-dark: #1e2126;
        --bm-bg-panel: #2c313a;
        --bm-text-main: #eeeeee;
        --bm-text-muted: #aaaaaa;
        --bm-primary-blue: #0d6efd;
        --bm-primary-blue-hover: #0b5ed7;
        --bm-success-color: #28a745;
        --bm-warning-color: #f0ad4e;
        --bm-danger-color: #dc3545;
        --bm-btn-secondary: #5a6268;
        --bm-border-color: #444c5e;
        --bm-shadow-soft: 0 4px 6px rgba(0,0,0,0.3);
        --bm-font: "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif;
        --bm-input-bg: #f0f2f5;
      }

      #tfn-script-manager-container {
        font-family: var(--bm-font); color: var(--bm-text-main); font-size: 14px;
        position: fixed; top: 8vh; left: 50%; transform: translateX(-50%); z-index: 10000;
        background-color: var(--bm-bg-dark); border: 1px solid var(--bm-border-color);
        border-radius: 8px; height: 80vh; width: 90%; max-width: 1200px;
        display: none; flex-direction: column; box-sizing: border-box;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;
      }
      #tfn-script-manager-container.visible { display: flex; }

      #tfn-script-manager-container .bm-manager-header {
        flex-shrink: 0; padding: 20px 20px 0 20px; background-color: var(--bm-bg-dark);
        border-bottom: 1px solid var(--bm-border-color); z-index: 20; position: relative;
      }
      #tfn-script-manager-container .bm-manager-body {
        flex-grow: 1; overflow-y: auto; padding: 20px; background: rgba(0,0,0,0.1);
      }
      #tfn-script-manager-container .bm-manager-footer {
        flex-shrink: 0; padding: 15px 20px; background-color: var(--bm-bg-dark);
        border-top: 1px solid var(--bm-border-color);
      }
      #tfn-script-manager-container .bm-manager-body::-webkit-scrollbar { width: 8px; }
      #tfn-script-manager-container .bm-manager-body::-webkit-scrollbar-thumb {
        background-color: var(--bm-border-color); border-radius: 4px;
      }

      #tfn-script-manager-container h3 {
        text-align: center; border-bottom: 2px solid var(--bm-primary-blue);
        padding-bottom: 12px; margin: 0 0 20px 0; font-weight: 300; font-size: 1.8em; letter-spacing: 1px;
      }
      #tfn-script-manager-container .bm-level-chip {
        display: inline-block; margin-left: 10px; padding: 2px 8px; vertical-align: middle;
        font-size: 0.45em; font-weight: 500; letter-spacing: 0.02em;
        color: var(--bm-text-muted); background: #2a3038; border: 1px solid #3d4554;
        border-radius: 4px; opacity: 0.85;
      }
      #tfn-script-manager-container .bm-toolbar {
        display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 15px; flex-wrap: wrap;
      }
      #tfn-script-manager-container #tfn-script-filter {
        background-color: var(--bm-input-bg); color: #222; border: 1px solid #999;
        border-radius: 6px; padding: 8px 12px; font-size: 1em; width: 300px; max-width: 100%;
      }
      #tfn-script-manager-container .bm-toolbar-right { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      #tfn-script-manager-container .bm-actions { display: flex; gap: 14px; align-items: center; }
      #tfn-script-manager-container .bm-actions span,
      #tfn-script-manager-container .bm-actions label {
        font-size: 1.05em; cursor: pointer; color: var(--bm-text-muted); user-select: none;
      }
      #tfn-script-manager-container .bm-actions span:hover { color: var(--bm-text-main); }
      #tfn-script-manager-container #tfn-stats-bar { color: var(--bm-text-muted); font-size: 0.95em; }

      #tfn-script-manager-container #tfn-tabs-area { margin: 0 0 12px 0; }
      #tfn-script-manager-container .bm-tabs {
        display: flex; flex-wrap: nowrap; width: 100%; gap: 2px; overflow-x: auto;
      }
      #tfn-script-manager-container .bm-tab {
        flex: 1; min-width: 0; padding: 10px 6px; background: #333; color: #aaa; cursor: pointer;
        border-radius: 5px 5px 0 0; font-weight: 500; text-align: center;
        border: 1px solid #444; border-bottom: none;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #tfn-script-manager-container .bm-tab:hover { color: #eee; }
      #tfn-script-manager-container .bm-tab.active {
        flex-grow: 3; background-color: var(--bm-primary-blue) !important; color: white !important; font-weight: bold;
      }

      #tfn-script-manager-container .bm-category-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, 200px);
        grid-auto-rows: 118px;
        gap: 12px; padding-bottom: 10px; align-items: stretch; justify-content: start;
      }
      #tfn-script-manager-container .script-button {
        padding: 12px 12px 28px 12px; border-radius: 6px; cursor: pointer; position: relative;
        background: var(--bm-bg-panel); text-align: center;
        width: 200px; height: 118px; min-width: 200px; max-width: 200px;
        min-height: 118px; max-height: 118px; box-sizing: border-box;
        display: flex; flex-direction: column; justify-content: center; align-items: center;
        transition: transform 0.2s, box-shadow 0.2s; border: 1px solid transparent;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2); overflow: hidden;
      }
      #tfn-script-manager-container .script-button:hover { transform: translateY(-3px); box-shadow: var(--bm-shadow-soft); z-index: 10; }
      #tfn-script-manager-container .script-button.active { background: var(--bm-primary-blue); color: white; border: none; }
      #tfn-script-manager-container .script-button.inactive { background: #343a40; color: #aaa; border: 1px solid var(--bm-border-color); opacity: 0.9; }
      #tfn-script-manager-container .script-button .bm-script-title {
        font-size: 1em; line-height: 1.25; max-width: 100%;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; word-break: break-word;
      }
      #tfn-script-manager-container .script-button .version {
        font-size: 0.85em; margin-top: 6px; opacity: 0.9; flex-shrink: 0;
      }
      #tfn-script-manager-container .script-button .bm-tile-footer {
        position: absolute; left: 0; right: 0; bottom: 0;
        height: 22px; padding: 0 28px 0 10px; text-align: left;
        display: flex; align-items: center;
        font-size: 0.68em; font-weight: 500; letter-spacing: 0.04em;
        opacity: 0.55; border-top: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.22); line-height: 1; box-sizing: border-box;
      }
      #tfn-script-manager-container .script-button.inactive .bm-tile-footer {
        border-top-color: rgba(255,255,255,0.08); background: rgba(0,0,0,0.28);
      }

      #tfn-script-manager-container #tfn-save-scripts-button {
        width: 100%; padding: 14px; font-weight: bold; color: white;
        background-color: var(--bm-primary-blue); border: none; border-radius: 6px;
        cursor: pointer; font-size: 1.1em;
      }
      #tfn-script-manager-container #tfn-save-scripts-button:hover { background-color: var(--bm-primary-blue-hover); }
      #tfn-script-manager-container #tfn-save-scripts-button[disabled] { opacity: 0.45; cursor: default; }

      #tfn-script-manager-container .bm-close-btn {
        position: absolute; top: 15px; right: 20px; font-size: 24px; cursor: pointer; color: var(--bm-text-muted);
      }
      #tfn-script-manager-container .bm-banner {
        background: #422006; color: #fde68a; border: 1px solid #a16207;
        border-radius: 6px; padding: 12px; margin-bottom: 12px;
      }
      #tfn-script-manager-container .bm-loader-container {
        padding: 40px; text-align: center; color: var(--bm-text-muted); grid-column: 1 / -1;
      }

      #tfn-script-manager-container .bm-manual-btn {
        position: absolute; bottom: 3px; right: 6px; font-size: 1em; opacity: 0.7;
        cursor: pointer; z-index: 2; line-height: 1; padding: 2px 4px;
      }
      #tfn-script-manager-container .bm-manual-btn:hover { opacity: 1; transform: scale(1.15); }
      #tfn-script-manager-container .script-button.active .bm-manual-btn { filter: drop-shadow(0 0 1px #000); }

      #tfn-manual-modal {
        display: none; position: fixed; inset: 0; z-index: 10006;
        background: rgba(0,0,0,0.55); align-items: center; justify-content: center;
        font-family: var(--bm-font, sans-serif);
      }
      #tfn-manual-modal.visible { display: flex; }
      #tfn-manual-modal .bm-manual-panel {
        width: 90%; max-width: 900px; height: 85vh; background: #2c313a; color: #eee;
        border: 1px solid #444c5e; border-radius: 8px; display: flex; flex-direction: column;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;
      }
      #tfn-manual-modal .bm-manual-header {
        padding: 14px 18px; border-bottom: 1px solid #444c5e; font-size: 1.15em; font-weight: 600;
      }
      #tfn-manual-modal #tfn-manual-body {
        flex: 1; overflow-y: auto; padding: 0; background: #fff; color: #222;
      }
      #tfn-manual-modal .bm-manual-footer {
        padding: 12px 18px; border-top: 1px solid #444c5e; text-align: right;
      }
      #tfn-manual-modal .bm-manual-footer button {
        padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer;
        background: #5a6268; color: #fff; font-weight: 600;
      }

      #tfn-scriptmanager-link.bm-update-highlight,
      #menu_profile.bm-update-highlight {
        background-color: var(--bm-primary-blue) !important; color: #ffffff !important; border-radius: 4px;
      }
    `);
    const marker = document.createElement('meta');
    marker.id = 'tfn-mvp-styles';
    (document.head || document.documentElement).appendChild(marker);
  }

  function createManagerUI() {
    if (managerUiCreated) return;
    ensureStyles();
    const div = document.createElement('div');
    div.id = 'tfn-script-manager-container';
    div.innerHTML = `
      <div class="bm-manager-header">
        <span class="bm-close-btn" title="Schließen">&times;</span>
        <h3>TFN-Scriptmanager <span class="bm-level-chip" id="tfn-level-label" title="Berechtigungsstufe">Stufe ?</span></h3>
        <div class="bm-toolbar">
          <input type="text" id="tfn-script-filter" placeholder="Suche...">
          <div class="bm-toolbar-right">
            <div id="tfn-stats-bar">…</div>
            <div class="bm-actions">
              <label title="Config-Sync zum Server"><input type="checkbox" id="tfn-sync-toggle" ${syncEnabled ? 'checked' : ''}/> Sync</label>
              <span id="tfn-manager-manual-btn" title="Manager-Anleitung">📖</span>
              <span id="tfn-refresh-btn" title="Katalog neu laden">🔄</span>
            </div>
          </div>
        </div>
      </div>
      <div class="bm-manager-body">
        <div id="tfn-status-banner"></div>
        <div id="tfn-tabs-area"></div>
        <div id="tfn-grid-area" class="bm-category-grid"></div>
      </div>
      <div class="bm-manager-footer">
        <button type="button" id="tfn-save-scripts-button">Änderungen anwenden</button>
        <div style="text-align:right;font-size:0.7em;color:var(--bm-text-muted);margin-top:5px;opacity:0.6;">
          v${MANAGER_VERSION} · ${escapeHtml(API_BASE)}
        </div>
      </div>
    `;
    document.body.appendChild(div);

    div.querySelector('.bm-close-btn').onclick = async () => {
      // Wie alter Manager: offene Entwürfe beim Schließen übernehmen
      if (hasDraftChanges()) {
        await applyChanges();
        return;
      }
      div.classList.remove('visible');
    };
    document.getElementById('tfn-refresh-btn').onclick = () => reloadCatalogIntoUI();
    document.getElementById('tfn-manager-manual-btn').onclick = () => {
      showManualUI('TFN-Scriptmanager', MANAGER_MANUAL_HTML);
    };
    document.getElementById('tfn-script-filter').addEventListener('input', (e) => {
      filterText = (e.target.value || '').toLowerCase();
      renderGrid();
    });
    document.getElementById('tfn-sync-toggle').addEventListener('change', (e) => {
      syncEnabled = !!e.target.checked;
      GM_setValue(GM_SYNC_KEY, syncEnabled);
      if (syncEnabled) {
        pullServerPrefs({ force: true }).then(() => {
          ensurePrefsForCatalog();
          renderGrid();
        });
      }
    });
    document.getElementById('tfn-save-scripts-button').addEventListener('click', () => applyChanges());

    managerUiCreated = true;
  }


  const manualCache = {};

  function ensureManualModal() {
    let modal = document.getElementById('tfn-manual-modal');
    if (modal) return modal;
    ensureStyles();
    modal = document.createElement('div');
    modal.id = 'tfn-manual-modal';
    modal.innerHTML = `
      <div class="bm-manual-panel">
        <div class="bm-manual-header">📖 Anleitung</div>
        <div id="tfn-manual-body">Lade Inhalt…</div>
        <div class="bm-manual-footer">
          <button type="button" id="tfn-manual-close">Schließen</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('visible');
    });
    document.getElementById('tfn-manual-close').onclick = () => modal.classList.remove('visible');
    return modal;
  }

  function showManualUI(scriptName, htmlContent) {
    const modal = ensureManualModal();
    modal.querySelector('.bm-manual-header').textContent = '📖 Anleitung: ' + scriptName;
    document.getElementById('tfn-manual-body').innerHTML = htmlContent || '<p style="padding:16px;">Keine Anleitung.</p>';
    modal.classList.add('visible');
  }

  async function openScriptManual(script) {
    const sid = Number(script.id);
    const title = script.title || script.slug || ('#' + sid);
    if (manualCache[sid]) {
      showManualUI(title, manualCache[sid]);
      return;
    }
    showManualUI(title, '<p style="padding:16px;color:#555;">Lade Anleitung…</p>');
    try {
      const res = await api('GET', '/api/scripts/' + sid + '/manual');
      const html = (res && res.manual_html) ? String(res.manual_html) : '';
      if (!html) {
        showManualUI(title, '<p style="padding:16px;">Keine Anleitung hinterlegt.</p>');
        return;
      }
      manualCache[sid] = html;
      showManualUI(title, html);
    } catch (e) {
      showManualUI(title, '<p style="padding:16px;color:#b91c1c;">Anleitung nicht ladbar: ' + escapeHtml(formatApiError(e)) + '</p>');
    }
  }


  /** Katalog: categories[] (M:N); Fallback category / Sonstiges */
  function scriptCategories(s) {
    if (s && Array.isArray(s.categories) && s.categories.length) {
      return s.categories;
    }
    if (s && s.category && s.category.slug) {
      return [s.category];
    }
    return [{ slug: 'sonstiges', title: 'Sonstiges', sort_order: 999 }];
  }

  function scriptCategoryTitles(s) {
    return scriptCategories(s).map((c) => String(c.title || c.slug || '')).filter(Boolean).join(', ') || 'Sonstiges';
  }

  function scriptInCategory(s, slug) {
    return scriptCategories(s).some((c) => String(c.slug) === slug);
  }

  function renderCategoryTabs(visibleItems) {
    const tabsArea = document.getElementById('tfn-tabs-area');
    if (!tabsArea) return;
    tabsArea.innerHTML = '';
    const counts = {};
    visibleItems.forEach((s) => {
      scriptCategories(s).forEach((c) => {
        const key = String(c.slug || 'sonstiges');
        counts[key] = (counts[key] || 0) + 1;
      });
    });

    const bar = document.createElement('div');
    bar.className = 'bm-tabs';

    const allTab = document.createElement('div');
    allTab.className = 'bm-tab' + (activeCategoryTab === 'Alle' ? ' active' : '');
    allTab.textContent = 'Alle (' + visibleItems.length + ')';
    allTab.onclick = () => { activeCategoryTab = 'Alle'; renderGrid(); };
    bar.appendChild(allTab);

    const ordered = (categories && categories.length)
      ? categories.slice()
      : [{ slug: 'sonstiges', title: 'Sonstiges', sort_order: 999 }];

    // Also show unknown categories present in catalog
    const known = {};
    ordered.forEach((c) => { known[c.slug] = true; });
    visibleItems.forEach((s) => {
      scriptCategories(s).forEach((c) => {
        const key = String(c.slug || 'sonstiges');
        if (!known[key]) {
          ordered.push({
            slug: key,
            title: String(c.title || key),
            sort_order: 500,
          });
          known[key] = true;
        }
      });
    });

    // Tabs alphabetisch (de); „Alle“ bleibt davor
    ordered.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'de', { sensitivity: 'base' }));

    ordered.forEach((c) => {
      const n = counts[c.slug] || 0;
      if (!n) return;
      const tab = document.createElement('div');
      tab.className = 'bm-tab' + (activeCategoryTab === c.slug ? ' active' : '');
      tab.textContent = c.title + ' (' + n + ')';
      tab.title = c.title;
      tab.onclick = () => { activeCategoryTab = c.slug; renderGrid(); };
      bar.appendChild(tab);
    });

    tabsArea.appendChild(bar);
  }

  function hasDraftChanges() {
    for (const s of catalog) {
      const sid = Number(s.id);
      if (!!draftEnabled[sid] !== isEnabled(sid)) return true;
    }
    return false;
  }

  function renderGrid() {
    const grid = document.getElementById('tfn-grid-area');
    const banner = document.getElementById('tfn-status-banner');
    const stats = document.getElementById('tfn-stats-bar');
    const levelLabel = document.getElementById('tfn-level-label');
    const saveBtn = document.getElementById('tfn-save-scripts-button');
    if (!grid) return;

    if (levelLabel) levelLabel.textContent = 'Stufe ' + String(permissionLevel);

    if (bootStatus !== 'ok') {
      if (banner) {
        banner.innerHTML = `<div class="bm-banner"><strong>${escapeHtml(bootStatus)}</strong><br>${escapeHtml(bootMessage || '')}</div>`;
      }
      grid.innerHTML = '';
      if (saveBtn) saveBtn.disabled = true;
      if (stats) stats.textContent = 'Keine Scripts';
      return;
    }

    const visibleCount = catalog.length;
    const savedCount = catalog.filter((s) => isEnabled(Number(s.id))).length;
    if (banner) {
      if (recoveryNote) {
        banner.innerHTML = `<div class="bm-banner">${escapeHtml(recoveryNote)}</div>`;
      } else if (!savedCount && visibleCount) {
        banner.innerHTML = `<div class="bm-banner"><strong>Nichts aktiv</strong> – Kachel anklicken (blau = gewählt), dann „Änderungen anwenden“ oder Manager schließen (übernimmt Auswahl). Allein blau startet keine Scripts.</div>`;
      } else {
        banner.innerHTML = '';
      }
    }
    if (saveBtn) saveBtn.disabled = false;

    const filtered = catalog.filter((s) => {
      if (!filterText) return true;
      const hay = ((s.title || '') + ' ' + (s.slug || '') + ' ' + (s.description || '') + ' ' + scriptCategoryTitles(s)).toLowerCase();
      return hay.includes(filterText);
    });
    renderCategoryTabs(filtered);
    const items = filtered.filter((s) => {
      if (activeCategoryTab === 'Alle') return true;
      return scriptInCategory(s, activeCategoryTab);
    });

    grid.innerHTML = '';
    if (!items.length) {
      grid.innerHTML = '<div class="bm-loader-container">Kein Skript in dieser Kategorie.</div>';
    } else {
      items.forEach((s) => {
        const sid = Number(s.id);
        const on = !!draftEnabled[sid];
        const saved = isEnabled(sid);
        const tile = document.createElement('div');
        tile.className = 'script-button ' + (on ? 'active' : 'inactive');
        // Kurzinfo nur per Hover (title) – nicht auf der Kachel (überdeckt 📖)
        tile.title = (s.description || s.title || '').replace(/<[^>]*>?/gm, '');
        tile.innerHTML =
          `<strong class="bm-script-title">${escapeHtml(s.title)}</strong>` +
          `<div class="version">v${escapeHtml(s.version)}` +
          (on && !saved ? ' · gewählt' : (saved ? ' · aktiv' : '')) +
          `</div>` +
          `<div class="bm-tile-footer" title="Min. Stufe">L${escapeHtml(String(s.permission_level))}</div>`;
        if (s.has_manual) {
          const man = document.createElement('span');
          man.className = 'bm-manual-btn';
          man.title = 'Anleitung öffnen';
          man.textContent = '📖';
          man.onclick = (e) => {
            e.stopPropagation();
            openScriptManual(s);
          };
          tile.appendChild(man);
        }
        tile.onclick = () => {
          draftEnabled[sid] = !draftEnabled[sid];
          renderGrid();
          updateSaveVisibility();
        };
        grid.appendChild(tile);
      });
    }

    if (stats) {
      stats.innerHTML = `Scripts: <span style="color:#eee;font-weight:bold;">${visibleCount}</span> | Aktiv: <span style="color:var(--bm-primary-blue);font-weight:bold;">${savedCount}</span>`;
    }
    updateSaveVisibility();
  }

  function updateSaveVisibility() {
    const saveBtn = document.getElementById('tfn-save-scripts-button');
    if (!saveBtn) return;
    saveBtn.style.display = hasDraftChanges() ? 'block' : 'none';
  }

  async function applyChanges() {
    for (const s of catalog) {
      const sid = Number(s.id);
      let pref = prefs.find((p) => Number(p.scriptId) === sid);
      if (!pref) {
        pref = { scriptId: sid, enabled: false, config: {} };
        prefs.push(pref);
      }
      pref.scriptId = sid;
      pref.enabled = !!draftEnabled[sid];
      await idbPutPref(pref);
    }
    await pushServerPrefs();
    // Reload wie V27.5 – Boot holt Content und führt im Seitenkontext aus
    const container = document.getElementById('tfn-script-manager-container');
    if (container) container.classList.remove('visible');
    location.reload();
  }

  async function reloadCatalogIntoUI() {
    const grid = document.getElementById('tfn-grid-area');
    if (grid) grid.innerHTML = '<div class="bm-loader-container">Lade Katalog…</div>';
    try {
      const cat = await api('GET', '/api/scripts/catalog');
      catalog = (cat.scripts || []).map((s) => Object.assign({}, s, { id: Number(s.id) }));
      categories = Array.isArray(cat.categories) ? cat.categories : [];
      ensurePrefsForCatalog();
      renderGrid();
    } catch (e) {
      bootStatus = 'error';
      bootMessage = formatApiError(e);
      renderGrid();
    }
  }

  function openManager() {
    createManagerUI();
    const container = document.getElementById('tfn-script-manager-container');
    if (!container) return;
    container.classList.add('visible');
    renderGrid();
  }

  function initUIHooks() {
    ensureStyles();
    const tryInsert = () => {
      if (killed) return true;
      // Nur eigenes TFN-Menü prüfen – #b-m-scriptmanager-link (alter B&M) unberührt lassen
      if (document.getElementById('tfn-scriptmanager-link')) return true;
      const settingsLink = document.querySelector('a[href="/settings/index"]');
      const userMenu = settingsLink && settingsLink.parentNode;
      if (!userMenu || !userMenu.parentNode) return false;

      const li = document.createElement('li');
      li.setAttribute('data-tfn-menu', '1');
      li.innerHTML = `<a href="#" id="tfn-scriptmanager-link"><img class="icon icons8-Settings" src="/images/icons8-settings.svg" width="24" height="24"> TFN-Scriptmanager</a>`;
      // Neben Einstellungen einfügen; vorhandenes B&M-Menü (#b-m-scriptmanager-link) nicht ersetzen
      userMenu.parentNode.insertBefore(li, userMenu.nextSibling);
      document.getElementById('tfn-scriptmanager-link').addEventListener('click', (e) => {
        e.preventDefault();
        openManager();
      });
      return true;
    };

    if (tryInsert()) return;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (tryInsert() || Date.now() - t0 > 15000) clearInterval(iv);
    }, 250);
  }

  /**
   * Host ohne LSS-user_id (/tfn/*, Legacy fr-manager / verband/manager / tfn.tw/0, …):
   * Session aus GM/Hash → Katalog → matching Scripts (GM-Bridge + Eval).
   */
  function readHostSessionCandidates() {
    const out = [];
    const push = (tok, source) => {
      const t = tok ? String(tok).trim() : '';
      if (!/^[a-f0-9]{64}$/i.test(t)) return;
      if (out.some((x) => x.token === t)) return;
      out.push({ token: t, source: source });
    };
    try {
      const m = String(location.hash || '').match(/tfn_sess=([a-f0-9]{64})/i);
      if (m) push(m[1], 'hash');
    } catch (_) {}
    try { push(localStorage.getItem('tfn_session_token'), 'ls'); } catch (_) {}
    try { push(window.__TFN_SESSION_TOKEN__, 'page'); } catch (_) {}
    try { push(GM_getValue(GM_SESSION_KEY, null), 'gm'); } catch (_) {}
    return out;
  }

  async function bootListHost() {
    migrateLegacyTfnGmKeys();
    installPageGmBridge();
    killed = false;

    const candidates = readHostSessionCandidates();
    try {
      const m = String(location.hash || '').match(/tfn_sess=([a-f0-9]{64})/i);
      if (m) history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}

    if (!candidates.length) {
      bootStatus = 'error';
      bootMessage = 'Host-Seite ohne Session. Bitte zuerst normales LSS mit TFN-Scriptmanager öffnen (Session anlegen), dann diesen Tab neu laden.';
      console.warn('[TFN]', bootMessage);
      setHostVeilMessage(bootMessage);
      return;
    }

    try {
      await openDb();
      prefs = (await idbAllPrefs()).map((p) => ({
        scriptId: Number(p.scriptId),
        enabled: !!p.enabled,
        config: p.config || {},
      }));
    } catch (e) {
      console.warn('[TFN] IndexedDB Host übersprungen', e && e.message ? e.message : e);
      db = null;
      prefs = [];
    }

    let catOk = false;
    let lastErr = null;
    for (const c of candidates) {
      sessionToken = c.token;
      try { GM_setValue(GM_SESSION_KEY, sessionToken); } catch (_) {}
      publishSessionToPage(GM_getValue('tfn_last_user_id', null));
      console.log('[TFN] Host-Auth Versuch source=' + c.source + ' token=' + c.token.slice(0, 8) + '…');
      try {
        const cat = await api('GET', '/api/scripts/catalog');
        catalog = (cat.scripts || []).map((s) => Object.assign({}, s, { id: Number(s.id) }));
        categories = Array.isArray(cat.categories) ? cat.categories : [];
        catOk = true;
        console.log('[TFN] Host-Katalog OK · authSource=' + c.source + ' · scripts=' + catalog.length);
        break;
      } catch (e) {
        lastErr = e;
        const code = (e && e.payload && e.payload.error) || '';
        console.warn('[TFN] Host-Katalog fail source=' + c.source, code || e.message || e);
        if (code !== 'unauthorized' && code !== 'session_expired' && e.status !== 401) {
          break;
        }
      }
    }

    if (!catOk) {
      bootStatus = 'error';
      bootMessage = 'Katalog auf Host-Seite fehlgeschlagen. ' + formatApiError(lastErr) +
        ' Tipp: Hauptspiel-Tab neu laden, dann Liste erneut über das Profilmenü öffnen.';
      console.warn('[TFN]', bootMessage, lastErr);
      setHostVeilMessage(bootMessage);
      return;
    }

    ensurePrefsForCatalog();
    await pullServerPrefs({ force: true });
    ensurePrefsForCatalog();

    // Host-Scripts: wenn URL matcht und Pref noch aus/fehlend → aktivieren
    // (sonst bleibt /tfn/… leer, obwohl Katalog den Eintrag hat).
    for (const s of catalog) {
      const sid = Number(s.id);
      const slug = String(s.slug || '');
      const matchesHere = urlMatches(s.match_patterns);
      if (!matchesHere) continue;
      const forceSlug = HOST_AUTO_ENABLE_SLUGS.indexOf(slug) !== -1;
      let pref = prefs.find((p) => Number(p.scriptId) === sid);
      if (!pref) {
        pref = { scriptId: sid, enabled: forceSlug, config: {} };
        prefs.push(pref);
      } else if (forceSlug && !pref.enabled) {
        pref.enabled = true;
      }
      draftEnabled[sid] = !!pref.enabled;
      try { await idbPutPref(pref); } catch (_) {}
    }

    bootStatus = 'ok';
    bootMessage = '';
    setHostVeilMessage('TFN startet Script…');
    await fetchAndRunEnabled();
    clearHostVeil();
    console.log('[TFN] Host-Seite bereit ·', location.pathname, '· v' + MANAGER_VERSION,
      '· aktiv', prefs.filter((p) => p.enabled).length);
  }

  // -------------------------------------------------------------------------
  // Boot – session/start sofort beim Seitenladen (Auto-Create User), UI nur Menü
  // -------------------------------------------------------------------------
  async function boot() {
    migrateLegacyTfnGmKeys();
    const user = readPageUser();
    if (!user.user_id) {
      if (isSessionHostPage()) {
        await bootListHost();
        return;
      }
      console.warn('[TFN] Keine user_id auf der Seite – Abbruch.');
      return;
    }

    console.log('[TFN] session/start vorbereiten · user_id=', user.user_id, '· v' + MANAGER_VERSION);

    try {
      await openDb();
      prefs = (await idbAllPrefs()).map((p) => ({
        scriptId: Number(p.scriptId),
        enabled: !!p.enabled,
        config: p.config || {},
      }));
    } catch (e) {
      console.warn('[TFN] IndexedDB übersprungen (Boot geht weiter)', e && e.message ? e.message : e);
      db = null;
      prefs = Array.isArray(prefs) ? prefs : [];
    }

    // Profilmenü früh einhängen (auch bei Fehler später nutzbar)
    initUIHooks();

    let session;
    try {
      const startBody = {
        user_id: user.user_id,
        manager_version: MANAGER_VERSION,
      };
      if (user.display_name) startBody.display_name = user.display_name;
      session = await api('POST', '/api/session/start', startBody);
    } catch (e) {
      console.warn('[TFN] session/start fehlgeschlagen', e);
      bootStatus = e && e.kind === 'http' ? 'error' : 'offline';
      bootMessage = formatApiError(e);
      return;
    }

    const action = session.action || session.mode;
    const lvl = Number(session.permission_level);
    if (session.display_name) {
      try { GM_setValue('tfn_last_display_name', String(session.display_name).slice(0, 128)); } catch (_) {}
    } else if (user.display_name) {
      try { GM_setValue('tfn_last_display_name', user.display_name); } catch (_) {}
    }
    console.log('[TFN] session/start →', {
      action: action,
      mode: session.mode,
      permission_level: lvl,
      display_name: session.display_name || user.display_name || null,
      has_token: !!session.session_token,
      version: MANAGER_VERSION,
    });

    if (action === 'kill' || lvl < 0) {
      await performKill(session.message || 'kill');
      return;
    }
    if (action === 'maintenance' || action === 'off') {
      bootStatus = action;
      bootMessage = session.message || 'Keine Scripts aktiv.';
      return;
    }

    // Jeder erfolgreiche Start: Kill-Flags weg (kein GM-Surgery nötig)
    const wasKilled = await recoverFromKillIfNeeded();
    recoveredFromKill = wasKilled;

    sessionToken = session.session_token;
    permissionLevel = Number.isFinite(lvl) ? lvl : 0;
    if (sessionToken) GM_setValue(GM_SESSION_KEY, sessionToken);
    try { GM_setValue('tfn_last_user_id', session.user_id || user.user_id); } catch (_) {}
    try { GM_setValue('tfn_last_permission_level', permissionLevel); } catch (_) {}
    publishSessionToPage(session.user_id || user.user_id);
    installPageGmBridge();

    try {
      const cat = await api('GET', '/api/scripts/catalog');
      catalog = (cat.scripts || []).map((s) => Object.assign({}, s, { id: Number(s.id) }));
      categories = Array.isArray(cat.categories) ? cat.categories : [];
    } catch (e) {
      bootStatus = 'error';
      bootMessage = 'Katalog konnte nicht geladen werden. ' + formatApiError(e);
      return;
    }

    ensurePrefsForCatalog();
    // Nach Kill: Sync immer vom Server ziehen (auch wenn Toggle vorher aus war)
    const pull = await pullServerPrefs({ force: wasKilled || syncEnabled });
    ensurePrefsForCatalog();

    const enabledCount = prefs.filter((p) => p.enabled).length;
    if (wasKilled) {
      if (pull.error) {
        recoveryNote = 'Nach Sperre: Server-Prefs nicht ladbar (' + pull.error + '). localStorage leer ist OK. Kacheln aktivieren, dann Anwenden oder Manager schließen.';
      } else if (enabledCount > 0) {
        recoveryNote = 'Nach Sperre: ' + enabledCount + ' Script(s) vom Server-Sync wiederhergestellt – starten automatisch. (leeres localStorage ist OK)';
      } else {
        recoveryNote = 'Nach Sperre: nichts aktiv – lokale Prefs waren geleert, Server hatte keine gespeicherten Enables. Kacheln einschalten, dann „Änderungen anwenden“ oder Manager schließen. Kein GM-Zugriff nötig.';
      }
      console.log('[TFN] Recovery-Hinweis:', recoveryNote);
    } else {
      recoveryNote = '';
    }

    bootStatus = 'ok';
    bootMessage = '';

    // Stufe nochmals page-nativ publizieren (vor unsafeWindow.eval – Sandbox-Getter unzuverlässig)
    publishPermissionLevelToPage(permissionLevel);
    publishManagerApi();

    // Scripts sofort ausführen – unabhängig davon, ob UI geöffnet wird
    await fetchAndRunEnabled();

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      const active = prefs.filter((p) => p.enabled).map((p) => Number(p.scriptId))
        .filter((id) => codeRam.has(id));
      api('POST', '/api/stats/heartbeat', { active_script_ids: active }).catch(() => {});
    }, HEARTBEAT_MS);

    console.log('[TFN] bereit · v' + MANAGER_VERSION + ' · Stufe', permissionLevel, '· Katalog', catalog.length,
      '· gespeichert aktiv', enabledCount,
      wasKilled ? '· nach-Kill-Recovery' : '');
  }

  /** Normales LSS: document-start → auf user_id warten, dann boot */
  function startNormalBoot() {
    const tryBoot = () => {
      const u = readPageUser();
      if (u.user_id) {
        boot().catch(console.error);
        return true;
      }
      return false;
    };
    const poll = () => {
      if (tryBoot()) return;
      let n = 0;
      const iv = setInterval(() => {
        if (tryBoot() || ++n >= 120) {
          clearInterval(iv);
          if (n >= 120) boot().catch(console.error);
        }
      }, 50);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', poll);
    } else {
      poll();
    }
  }

  // document-start: Session-Host sofort stoppen/blanken (kein 404-Flash), sonst normales Boot
  if (isSessionHostPage()) {
    suppressSessionHostFlash();
    Promise.resolve()
      .then(() => bootListHost())
      .catch((e) => {
        console.error('[TFN] Host-Boot fehlgeschlagen', e);
        setHostVeilMessage('TFN Host-Boot fehlgeschlagen.');
      });
  } else {
    startNormalBoot();
  }
})();
