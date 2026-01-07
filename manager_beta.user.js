// ==UserScript==
// @name         B&M Scriptmanager (V17.3 - Stats & Updates)
// @namespace    https://github.com/taskforce-Nord/manager
// @version      17.3.0
// @description  Vollständige Version mit Statistik, Update-Anzeige, Private-Repo Support und Anti-Loop.
// @author       B&M
// @match        https://www.leitstellenspiel.de/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_getResourceURL
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // --- KONFIGURATION ---
    const GITHUB_REPO_OWNER = 'Taskforce-Nord';
    const GITHUB_REPO_NAME = 'public'; // Privat!
    const REPO_PATH_FULL = `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;

    const SYNC_CONFIG_FILE = 'sync_meta.json';
    const DB_NAME = 'BM-DB-TN';
    const DB_VERSION = 1;
    const DEFAULT_CATEGORY = "Sonstiges";

    const GM_TOKEN_KEY = "bm_access_pat";
    const LS_ACCESS_KEY = "bm_access_cfg";

    // Globals
    let scriptStates = {};
    let initialScriptStates = {};
    let scriptMetadataCache = {};
    let db;
    let managerUiCreated = false;
    let settingsModalUiCreated = false;
    let tokenModalUiCreated = false;
    let filterMode = 'all'; // 'all' oder 'updates'

    // --- INIT ---
    try {
        const savedPat = GM_getValue(GM_TOKEN_KEY, "");
        if (savedPat) localStorage.setItem(LS_ACCESS_KEY, `${savedPat}@${REPO_PATH_FULL}`);
    } catch (e) {}

    window.BMScriptManager = {
        _settingsCache: {},
        _branchCache: {},

        // --- DATENBANK ---
        openDatabase: function() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('scripts')) {
                        db.createObjectStore('scripts', { keyPath: 'name' });
                    }
                };
                request.onsuccess = (event) => { db = event.target.result; resolve(); };
                request.onerror = (event) => reject(event.target.error);
            });
        },
        getScriptsFromDB: function() {
            return new Promise((resolve, reject) => {
                if (!db) { resolve([]); return; }
                const transaction = db.transaction(['scripts'], 'readonly');
                const request = transaction.objectStore('scripts').getAll();
                request.onsuccess = (event) => resolve(event.target.result);
                request.onerror = (event) => reject(event.target.error);
            });
        },
        getSingleScriptFromDB: function(scriptName) {
             return new Promise((resolve, reject) => {
                if (!db) { resolve(null); return; }
                const request = db.transaction(['scripts'], 'readonly').objectStore('scripts').get(scriptName);
                request.onsuccess = (event) => resolve(event.target.result);
                request.onerror = (event) => reject(event.target.error);
            });
        },
        saveScriptToDB: function(script) {
            return new Promise((resolve, reject) => {
                if (!db) { resolve(); return; }
                const request = db.transaction(['scripts'], 'readwrite').objectStore('scripts').put(script);
                request.onsuccess = () => resolve();
                request.onerror = (event) => reject(event.target.error);
            });
        },
        deleteScriptFromDB: function(scriptName) {
            localStorage.removeItem(`BMSettings_${scriptName}`);
            return new Promise((resolve, reject) => {
                if (!db) { resolve(); return; }
                const request = db.transaction(['scripts'], 'readwrite').objectStore('scripts').delete(scriptName);
                request.onsuccess = () => resolve();
                request.onerror = (event) => reject(event.target.error);
            });
        },

        // --- SYSTEM START ---
        initSystem: async function() {
            try {
                // 1. Check Primary Repo Access
                const token = GM_getValue(GM_TOKEN_KEY, "");
                const access = await this._checkRepoAccess(token);

                if (access === 'DENIED') {
                    console.error("[B&M] Access Denied. Token invalid/missing for private repo.");
                    this._showSetupScreen("Zugriff auf Haupt-Repository verweigert.<br>Bitte Token prüfen.");
                    return; // STOP.
                }

                // 2. Load DB & Scripts
                await this.openDatabase();
                await this._executeInstalledScripts(token);
                this._initUIHooks();

                // 3. Background Check für Update-Indikator am Button
                this.checkForUpdatesInBackground();

            } catch (e) {
                console.error("[B&M Init Error]", e);
            }
        },

        _checkRepoAccess: function(token) {
            const url = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/manifest.json`;
            const headers = token ? { "Authorization": `token ${token}` } : {};

            return new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: "GET", url: url, headers: headers,
                    onload: (res) => {
                        if (res.status === 200) resolve('OK');
                        else if (res.status === 401 || res.status === 404) resolve('DENIED');
                        else resolve('OFFLINE_OK');
                    },
                    onerror: () => resolve('OFFLINE_OK')
                });
            });
        },

        _showSetupScreen: function(msg) {
            const checkBody = setInterval(() => {
                if (document.body) {
                    clearInterval(checkBody);
                    this._createTokenModalUI();
                    const status = document.getElementById('bm-pat-status');
                    if(status) {
                        status.innerHTML = msg;
                        status.style.color = 'orange';
                    }
                    const btn = document.createElement('div');
                    btn.innerHTML = '⚠️ B&M Setup';
                    btn.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#d33;color:white;padding:10px;border-radius:5px;cursor:pointer;';
                    btn.onclick = () => this._createTokenModalUI();
                    document.body.appendChild(btn);
                }
            }, 100);
        },

        _executeInstalledScripts: async function(token) {
            if (!db) return;
            const scripts = await this.getScriptsFromDB();
            let count = 0;

            for (const script of scripts.filter(s => s.isActive !== false)) {
                const isPrimary = script.repoInfo && script.repoInfo.owner === GITHUB_REPO_OWNER && script.repoInfo.name === GITHUB_REPO_NAME;

                if (isPrimary && !token) {
                    console.warn(`[B&M] Blocked '${script.name}': Private repo script without token.`);
                    script.isActive = false;
                    script.authSuspended = true;
                    this.saveScriptToDB(script);
                    continue;
                }

                if (script.authSuspended) continue;

                try {
                    const isMatch = script.match.some(pattern => new RegExp(pattern.replace(/\*/g, '.*')).test(window.location.href));
                    if (isMatch) {
                        eval(script.code);
                        count++;
                    }
                } catch (e) { console.error(`[B&M] Exec Error '${script.name}':`, e); }
            }
            console.log(`[B&M] ${count} Modules loaded.`);
        },

        _initUIHooks: function() {
            const userMenu = document.querySelector('a[href="/settings/index"]')?.parentNode;
            if (userMenu && !document.getElementById('b-m-scriptmanager-link')) {
                const li = document.createElement('li');
                li.innerHTML = `<a href="#" id="b-m-scriptmanager-link"><img class="icon icons8-Settings" src="/images/icons8-settings.svg" width="24" height="24"> B&M Manager</a>`;
                userMenu.parentNode.insertBefore(li, userMenu.nextSibling);
                document.getElementById('b-m-scriptmanager-link').addEventListener('click', (e) => {
                    e.preventDefault();
                    this._createManagerUI();
                    const container = document.getElementById('lss-script-manager-container');
                    container.classList.toggle('visible');
                    if (container.classList.contains('visible')) {
                        if(!db) this.openDatabase().then(() => this.loadAndDisplayScripts());
                        else this.loadAndDisplayScripts();
                    }
                });
            }
        },

        checkForUpdatesInBackground: async function() {
            try {
                const token = GM_getValue(GM_TOKEN_KEY, "");
                if(!token) return;

                const repoInfo = { owner: GITHUB_REPO_OWNER, name: GITHUB_REPO_NAME, token: token };
                // Wir laden nur das Manifest, geht schnell
                const onlineScripts = await this.fetchScriptsWithManifest(repoInfo);
                if(onlineScripts.length === 0) return;

                if(!db) await this.openDatabase();
                const localScripts = await this.getScriptsFromDB();

                const activeLocals = localScripts.filter(s => s.isActive);
                let updateFound = false;

                for (const local of activeLocals) {
                    const remote = onlineScripts.find(s => s.name === local.name);
                    if (remote && this.compareVersions(remote.version, local.version) > 0) {
                        updateFound = true;
                        break;
                    }
                }

                if (updateFound) {
                    const link = document.getElementById('b-m-scriptmanager-link');
                    if (link) link.classList.add('bm-update-highlight');
                }
            } catch (e) { }
        },

        // --- HELPER ---
        getScriptNameAndVersion: function(fileName) {
            const regex = /(.+)\.v(\d+\.\d+\.\d+)\.user\.js/;
            const match = fileName.match(regex);
            return match ? { name: match[1], version: match[2], fullName: fileName } : null;
        },
        extractMatchFromCode: function(code) {
            const matchRegex = /@match\s+(.+)/g;
            let match;
            const matches = [];
            while ((match = matchRegex.exec(code)) !== null) matches.push(match[1]);
            return matches;
        },
        codeHasSettings: function(code) { return /\/\*--BMScriptConfig([\s\S]*?)--\*\//.test(code); },
        compareVersions: function(v1, v2) {
            const parts1 = v1.split('.').map(Number);
            const parts2 = v2.split('.').map(Number);
            const len = Math.max(parts1.length, parts2.length);
            for (let i = 0; i < len; i++) {
                const p1 = parts1[i] || 0;
                const p2 = parts2[i] || 0;
                if (p1 > p2) return 1;
                if (p1 < p2) return -1;
            }
            return 0;
        },

        // --- API & LOADING ---
        _fetchRESTContents: function(path, token) {
            return new Promise((resolve) => {
                const fullUrl = 'https://api.github.com/repos/' + path;
                const headers = token ? { 'Authorization': `token ${token}` } : {};
                GM_xmlhttpRequest({
                    method: 'GET', url: fullUrl, headers,
                    onload: res => {
                        if (res.status === 200) resolve({ success: true, data: JSON.parse(res.responseText) });
                        else resolve({ success: false, status: res.status });
                    },
                    onerror: () => resolve({ success: false, status: 'NETWORK' })
                });
            });
        },
        fetchScriptsWithManifest: async function(repoInfo) {
            const apiPath = `${repoInfo.owner}/${repoInfo.name}/contents/manifest.json`;
            const result = await this._fetchRESTContents(apiPath, repoInfo.token);
            if (result.success && result.data.content) {
                try {
                    const content = decodeURIComponent(escape(window.atob(result.data.content)));
                    const manifest = JSON.parse(content);
                    manifest.forEach(s => {
                        s.repoInfo = repoInfo;
                        s.dirName = s.name;
                        s.fullName = s.fileName;
                        if (!s.categories || !s.categories.length) s.categories = [DEFAULT_CATEGORY];
                    });
                    return manifest;
                } catch (e) { return []; }
            }
            return [];
        },
        fetchRawScript: async function(dirName, fileName, repoInfo) {
            const apiPath = `${repoInfo.owner}/${repoInfo.name}/contents/${dirName}/${fileName}`;
            const result = await this._fetchRESTContents(apiPath, repoInfo.token);
            if (result.success && result.data.content) {
                try {
                    const content = decodeURIComponent(escape(window.atob(result.data.content)));
                    return { success: true, content: content };
                } catch(e) { return { success: false, error: e }; }
            }
            return { success: false, error: "API Status " + (result.status || "Unknown") };
        },

        // --- UI CORE ---
        loadAndDisplayScripts: async function(forceRefresh = false) {
            const scriptList = document.getElementById('script-list');
            const updateContainer = document.getElementById('bm-update-list-container');

            scriptList.innerHTML = '<div class="bm-loader-container"><div class="bm-loader"></div> Lade Daten...</div>';
            if(filterMode === 'updates') updateContainer.style.display = 'block';
            else updateContainer.style.display = 'none';

            if (forceRefresh) {
                sessionStorage.removeItem('bm_cache_data');
                sessionStorage.removeItem('bm_cache_timestamp');
            }

            try {
                const token = GM_getValue(GM_TOKEN_KEY, "");
                const repoInfo = { owner: GITHUB_REPO_OWNER, name: GITHUB_REPO_NAME, token: token };

                const onlineScripts = await this.fetchScriptsWithManifest(repoInfo);
                const localScripts = await this.getScriptsFromDB();

                this._populateUI(onlineScripts, localScripts);
                sessionStorage.setItem('bm_cache_data', JSON.stringify(onlineScripts));
                sessionStorage.setItem('bm_cache_timestamp', Date.now());

            } catch (e) {
                scriptList.innerHTML = `<p style="color:red; text-align:center;">Fehler: ${e.message}</p>`;
            }
        },

        _populateUI: function(onlineScripts, localScripts) {
            const scriptList = document.getElementById('script-list');
            const updateContainer = document.getElementById('bm-update-list-container');
            const updateList = document.getElementById('bm-update-list');
            const statsBar = document.getElementById('bm-stats-bar');

            scriptList.innerHTML = '';
            updateList.innerHTML = '';

            scriptStates = {};
            initialScriptStates = {};
            scriptMetadataCache = {};

            const categoryMap = new Map();
            const detailsMap = new Map();

            onlineScripts.forEach(meta => {
                scriptMetadataCache[meta.name] = meta;
                const local = localScripts.find(s => s.name === meta.name);

                let state = 'install';
                let info = (meta.description || "") + (meta.changelog || "");

                if (local) {
                    if(local.isActive === false) state = 'inactive';
                    else {
                        const cmp = this.compareVersions(meta.version, local.version);
                        if (cmp > 0) state = 'update';
                        else if (cmp < 0) state = 'downgrade';
                        else state = 'active';
                    }
                    if (local.hasSettings) meta.hasSettings = true;
                }

                if (meta.authSuspended || (local && local.authSuspended)) {
                    state = 'inactive';
                    meta.authSuspended = true;
                    info = `<strong style="color:red">GESPERRT (Token Fehler)</strong><br>${info}`;
                }

                scriptStates[meta.name] = state;
                initialScriptStates[meta.name] = state;

                const item = { meta, info, state };
                detailsMap.set(meta.name, item);

                const cats = meta.categories || [DEFAULT_CATEGORY];
                cats.forEach(c => {
                    if(!categoryMap.has(c)) categoryMap.set(c, []);
                    categoryMap.get(c).push(item);
                });
            });

            // Statistik Berechnung
            const totalAvailable = detailsMap.size;
            const totalInstalled = [...detailsMap.values()].filter(d => d.state !== 'install').length;
            const totalActive = [...detailsMap.values()].filter(d => ['active','update','downgrade'].includes(d.state)).length;
            const totalUpdates = [...detailsMap.values()].filter(d => ['update','downgrade'].includes(d.state)).length;

            let statsHTML = `Verfügbar: <span class="stat-count">${totalAvailable}</span> | Installiert: <span class="stat-count">${totalInstalled}</span> (Aktiv: <span class="stat-count active">${totalActive}</span>)`;
            if (totalUpdates > 0) {
                statsHTML += ` | <span id="bm-stats-updates-trigger" title="Nur Updates anzeigen" style="cursor:pointer; color:#ffc107; font-weight:bold;">Updates: <span class="stat-count updates">${totalUpdates}</span></span>`;
            }
            if(statsBar) statsBar.innerHTML = statsHTML;

            // Render Logik basierend auf Filter
            if (filterMode === 'updates') {
                scriptList.style.display = 'none';
                updateContainer.style.display = 'block';

                const updates = [...detailsMap.values()].filter(d => ['update','downgrade'].includes(d.state));
                if(updates.length > 0) {
                    updates.forEach(item => updateList.appendChild(this.createUIElement(item)));
                } else {
                    updateList.innerHTML = "<p>Keine Updates verfügbar.</p>";
                }
            } else {
                scriptList.style.display = 'flex';
                updateContainer.style.display = 'none';

                [...categoryMap.keys()].sort().forEach(cat => {
                    const group = document.createElement('details');
                    group.className = 'bm-category-group';
                    group.open = true;

                    const head = document.createElement('summary');
                    head.className = 'bm-category-header';
                    head.textContent = `${cat} (${categoryMap.get(cat).length})`;
                    group.appendChild(head);

                    const grid = document.createElement('div');
                    grid.className = 'bm-category-grid';

                    categoryMap.get(cat).sort((a,b) => a.meta.name.localeCompare(b.meta.name)).forEach(item => {
                        grid.appendChild(this.createUIElement(item));
                    });

                    group.appendChild(grid);
                    scriptList.appendChild(group);
                });
            }

            const btn = document.getElementById('save-scripts-button');
            if(btn.textContent.indexOf("Gespeichert") === -1) {
                btn.textContent = "Änderungen anwenden";
                btn.disabled = false;
            }
            btn.style.display = 'block';
        },

        createUIElement: function(item) {
            const div = document.createElement('div');
            div.className = `script-button ${item.state}`;
            if(item.meta.authSuspended) div.style.opacity = '0.5';

            div.dataset.scriptName = item.meta.name.toLowerCase();
            div.dataset.scriptInfo = item.info.toLowerCase();

            let label = `<strong>${item.meta.name}</strong><br><span class="version">v${item.meta.version}</span>`;
            if (item.state === 'update') label = `<strong>${item.meta.name}</strong><br><span>🔄 v${item.meta.version}</span>`;

            div.innerHTML = label;
            div.title = item.info.replace(/<[^>]*>?/gm, '');

            if (['active', 'update'].includes(item.state) && item.meta.hasSettings && !item.meta.authSuspended) {
                const cfg = document.createElement('span');
                cfg.className = 'bm-config-btn';
                cfg.innerHTML = '⚙️';
                cfg.onclick = (e) => {
                    e.stopPropagation();
                    this._fetchAndShowSettingsUI(item.meta.name);
                };
                div.appendChild(cfg);
            }

            div.onclick = () => {
                if(item.meta.authSuspended) { alert("Skript gesperrt. Bitte Token prüfen."); return; }

                const current = scriptStates[item.meta.name];
                let next = current;

                if (current === 'install') next = 'activate';
                else if (current === 'activate') next = 'install';
                else if (['active', 'update', 'downgrade'].includes(current)) next = 'inactive';
                else if (current === 'inactive') next = 'active';

                scriptStates[item.meta.name] = next;
                div.className = `script-button ${next}`;
            };

            return div;
        },

        applyChanges: async function() {
            const btn = document.getElementById('save-scripts-button');
            btn.disabled = true;
            btn.textContent = "Prüfe Änderungen...";

            let changes = [];
            for (const name in scriptStates) {
                if (scriptStates[name] !== initialScriptStates[name] || scriptStates[name] === 'update') {
                    changes.push(name);
                }
            }

            if(changes.length === 0) {
                btn.textContent = "Keine Änderungen";
                setTimeout(() => { btn.disabled = false; btn.textContent = "Änderungen anwenden"; }, 1500);
                return;
            }

            let successCount = 0;
            let errors = [];

            for (let i = 0; i < changes.length; i++) {
                const name = changes[i];
                const state = scriptStates[name];
                btn.textContent = `Speichere ${i+1}/${changes.length}: ${name}...`;

                try {
                    const meta = scriptMetadataCache[name];

                    if (state === 'activate' || state === 'update' || state === 'downgrade' || state === 'active') {
                        const res = await this.fetchRawScript(meta.dirName, meta.fullName, meta.repoInfo);
                        if (res.success) {
                            const hasCfg = this.codeHasSettings(res.content);
                            const match = this.extractMatchFromCode(res.content);
                            const scriptObj = {
                                name: meta.name,
                                version: meta.version,
                                code: res.content,
                                match: match,
                                hasSettings: hasCfg,
                                isActive: true,
                                repoInfo: meta.repoInfo
                            };
                            await this.saveScriptToDB(scriptObj);
                            successCount++;
                        } else {
                            errors.push(`${name}: Fehler beim Download (${res.error || 'Unbekannt'})`);
                        }
                    } else if (state === 'inactive') {
                        const local = await this.getSingleScriptFromDB(name);
                        if(local) { local.isActive = false; await this.saveScriptToDB(local); successCount++; }
                    } else if (state === 'uninstall') {
                        await this.deleteScriptFromDB(name);
                        successCount++;
                    }
                } catch(e) {
                    errors.push(`${name}: ${e.message}`);
                }
            }

            if(errors.length > 0) {
                alert("Fehler aufgetreten:\n" + errors.join("\n"));
                btn.textContent = "Fertig (mit Fehlern)";
            } else {
                btn.textContent = "Gespeichert! (Schließen zum Aktivieren)";
            }

            await this.loadAndDisplayScripts(true);
            const newBtn = document.getElementById('save-scripts-button');
            if(errors.length === 0) newBtn.textContent = "Gespeichert! (Schließen zum Aktivieren)";
            setTimeout(() => { if(newBtn) newBtn.disabled = false; }, 1000);
        },

        // --- SETTINGS UI ---
        getSettings: function(scriptName) {
            if (this._settingsCache[scriptName]) return this._settingsCache[scriptName];
            try { return JSON.parse(localStorage.getItem(`BMSettings_${scriptName}`) || '{}'); } catch (e) { return {}; }
        },
        _saveSettings: function(scriptName, settings) {
            this._settingsCache[scriptName] = settings;
            localStorage.setItem(`BMSettings_${scriptName}`, JSON.stringify(settings));
        },
        _createSettingsModalUI: function() {
            if (settingsModalUiCreated) return;
            const div = document.createElement('div');
            div.id = 'bm-settings-modal';
            div.className = 'bm-modal-overlay';
            div.innerHTML = `<div class="bm-settings-content"></div>`;
            document.body.appendChild(div);
            settingsModalUiCreated = true;
        },
        _fetchAndShowSettingsUI: async function(scriptName) {
            this._createSettingsModalUI();
            const modal = document.getElementById('bm-settings-modal');
            const content = modal.querySelector('.bm-settings-content');
            content.innerHTML = '<div class="bm-loader-container"><div class="bm-loader"></div> Lade Konfiguration...</div>';
            modal.style.display = 'flex';

            let local = await this.getSingleScriptFromDB(scriptName);
            let code = local ? local.code : null;

            if(!code) {
                const meta = scriptMetadataCache[scriptName];
                const res = await this.fetchRawScript(meta.dirName, meta.fullName, meta.repoInfo);
                if(res.success) code = res.content;
            }

            if (code && this.codeHasSettings(code)) {
                try {
                    const match = code.match(/\/\*--BMScriptConfig([\s\S]*?)--\*\//);
                    const schema = JSON.parse(match[1]);
                    this._buildSettingsUI(scriptName, schema);
                } catch (e) { content.innerHTML = '<p style="color:red">Config Fehler.</p><button onclick="this.parentElement.parentElement.style.display=\'none\'">Zu</button>'; }
            } else {
                content.innerHTML = '<p>Keine Einstellungen.</p><button onclick="this.parentElement.parentElement.style.display=\'none\'">Zu</button>';
            }
        },
        _buildSettingsUI: function(scriptName, schema) {
            const settings = this.getSettings(scriptName);
            const modal = document.getElementById('bm-settings-modal');
            const content = modal.querySelector('.bm-settings-content');

            let html = `<div class="bm-settings-header">${scriptName}</div><div class="bm-settings-body">`;

            schema.forEach(item => {
                const val = settings[`param${item.param}`] ?? item.default;
                html += `<div class="bm-settings-row"><label>${item.label}</label>`;

                if(item.type === 'checkbox') html += `<input type="checkbox" id="bm-set-${item.param}" ${val ? 'checked' : ''}>`;
                else if(item.type === 'number') html += `<input type="number" id="bm-set-${item.param}" value="${val}">`;
                else if(item.type === 'select') {
                    html += `<select id="bm-set-${item.param}">`;
                    item.options.forEach(opt => html += `<option value="${opt.value}" ${opt.value===val?'selected':''}>${opt.text}</option>`);
                    html += `</select>`;
                } else html += `<input type="text" id="bm-set-${item.param}" value="${val}">`;

                html += `</div>`;
            });

            html += `</div><div class="bm-settings-footer"><button id="bm-set-save">Speichern</button> <button id="bm-set-cancel" style="background:#666">Abbrechen</button></div>`;
            content.innerHTML = html;

            document.getElementById('bm-set-cancel').onclick = () => modal.style.display = 'none';
            document.getElementById('bm-set-save').onclick = () => {
                const newSets = {};
                schema.forEach(item => {
                    const el = document.getElementById(`bm-set-${item.param}`);
                    newSets[`param${item.param}`] = item.type === 'checkbox' ? el.checked : (item.type === 'number' ? Number(el.value) : el.value);
                });
                this._saveSettings(scriptName, newSets);
                modal.style.display = 'none';
                location.reload();
            };
        },

        // --- MANAGER UI ---
        _createManagerUI: function() {
            if (managerUiCreated) return;
            const div = document.createElement('div');
            div.id = 'lss-script-manager-container';
            div.innerHTML = `
                <span class="bm-close-btn">&times;</span>
                <div class="bm-modal-content">
                    <h3>B&M Scriptmanager</h3>
                    <div class="bm-toolbar">
                        <div id="bm-script-filter-wrapper">
                            <input type="text" id="bm-script-filter" placeholder="Suche...">
                            <span id="bm-refresh-btn" title="Reload">🔄</span>
                            <span id="bm-token-btn" title="Token">🔑</span>
                        </div>
                        <select id="bm-view-switcher"><option value="category">Kategorien</option><option value="alphabetical">Liste</option></select>
                    </div>
                    <div id="bm-stats-bar"></div>
                    <div id="bm-update-list-container" style="display:none"><h4>Updates</h4><div id="bm-update-list"></div></div>
                    <div id="script-list"></div>
                </div>
                <button id="save-scripts-button" style="display:none;">Änderungen anwenden</button>
            `;
            document.body.appendChild(div);

            div.querySelector('.bm-close-btn').onclick = () => location.reload();
            document.getElementById('bm-refresh-btn').onclick = () => { filterMode='all'; this.loadAndDisplayScripts(true); };
            document.getElementById('bm-token-btn').onclick = () => this._createTokenModalUI();
            document.getElementById('save-scripts-button').addEventListener('click', () => this.applyChanges());

            // View Switcher
            document.getElementById('bm-view-switcher').addEventListener('change', () => { filterMode='all'; this.loadAndDisplayScripts(false); });

            // Search
            document.getElementById('bm-script-filter').addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase();
                document.querySelectorAll('.script-button').forEach(btn => {
                    const match = btn.dataset.scriptName.includes(term) || btn.dataset.scriptInfo.includes(term);
                    btn.classList.toggle('hidden', !match);
                });
            });

            // Update Trigger Event
            document.getElementById('bm-stats-bar').addEventListener('click', (e) => {
                if (e.target.id === 'bm-stats-updates-trigger' || e.target.parentElement.id === 'bm-stats-updates-trigger') {
                    filterMode = 'updates';
                    this.loadAndDisplayScripts(false);
                }
            });

            managerUiCreated = true;
        },

        _createTokenModalUI: function() {
            if (!tokenModalUiCreated) {
                const div = document.createElement('div');
                div.id = 'bm-token-modal';
                div.className = 'bm-modal-overlay';
                div.style.zIndex = '10002';
                div.innerHTML = `
                    <div class="bm-settings-content" style="max-width: 400px; border: 1px solid #777;">
                        <div class="bm-settings-header">🔒 Zugangstoken</div>
                        <div class="bm-settings-body" style="overflow:visible;">
                            <p style="font-size:0.9em; color:#ccc; margin-bottom:10px;">Token für privaten Repo-Zugriff:</p>
                            <input type="password" id="bm-pat-input" placeholder="github_pat_..." style="width:100%; padding:5px;">
                            <div style="text-align:right; margin-top:5px;"><input type="checkbox" id="bm-pat-show"> Anzeigen</div>
                            <div id="bm-pat-status" style="margin-top:10px;"></div>
                        </div>
                        <div class="bm-settings-footer">
                            <button id="bm-pat-del" style="background:#d33;">Löschen</button>
                            <button id="bm-pat-save" style="background:#28a745;">Speichern</button>
                            <button id="bm-pat-close" style="background:#666;">Schließen</button>
                        </div>
                    </div>`;
                document.body.appendChild(div);

                document.getElementById('bm-pat-close').onclick = () => div.style.display = 'none';
                document.getElementById('bm-pat-show').onchange = (e) => document.getElementById('bm-pat-input').type = e.target.checked ? 'text' : 'password';

                document.getElementById('bm-pat-del').onclick = async () => {
                    if(confirm("Token löschen?")) {
                        GM_deleteValue(GM_TOKEN_KEY);
                        localStorage.removeItem(LS_ACCESS_KEY);
                        const scripts = await this.getScriptsFromDB();
                        for(const s of scripts) {
                            if(s.repoInfo && s.repoInfo.owner === GITHUB_REPO_OWNER) {
                                s.isActive = false; s.authSuspended = true;
                                await this.saveScriptToDB(s);
                            }
                        }
                        location.reload();
                    }
                };

                document.getElementById('bm-pat-save').onclick = () => {
                    const v = document.getElementById('bm-pat-input').value.trim();
                    if(!v) return alert("Token fehlt.");
                    GM_setValue(GM_TOKEN_KEY, v);
                    location.reload();
                };
                tokenModalUiCreated = true;
            }
            const modal = document.getElementById('bm-token-modal');
            document.getElementById('bm-pat-input').value = GM_getValue(GM_TOKEN_KEY, "");
            modal.style.display = 'flex';
        }
    };

    // --- CSS (V14 Style) ---
    GM_addStyle(`
        #lss-script-manager-container, .bm-modal-overlay { font-family: sans-serif; }
        #lss-script-manager-container { position: fixed; top: 10vh; left: 50%; transform: translateX(-50%); z-index: 10000; background-color: #262c37; color: #eee; border: 1px solid #444c5e; border-radius: 5px; padding: 20px; height: 80vh; box-shadow: 0 4px 15px rgba(0,0,0,0.5); width: 90%; max-width: 1300px; display: none; flex-direction: column; box-sizing: border-box; }
        #lss-script-manager-container.visible { display: flex; }
        .bm-modal-content { flex-grow: 1; overflow-y: auto; min-height: 0; padding-right: 5px; scrollbar-width: thin; scrollbar-color: #5c677d #262c37; }
        .bm-modal-content::-webkit-scrollbar { width: 8px; }
        .bm-modal-content::-webkit-scrollbar-track { background: #262c37; border-radius: 4px; }
        .bm-modal-content::-webkit-scrollbar-thumb { background-color: #5c677d; border-radius: 4px; border: 2px solid #262c37; }
        #lss-script-manager-container h3 { color: white; text-align: center; border-bottom: 2px solid #007bff; padding-bottom: 10px; margin: 0 0 15px 0; flex-shrink: 0; }
        .bm-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 15px; flex-wrap: wrap; flex-shrink: 0; }
        #bm-script-filter-wrapper { position: relative; flex-grow: 1; min-width: 300px; }
        .bm-view-controls { display: flex; gap: 10px; align-items: center; }
        #bm-view-switcher, #bm-collapse-all { background-color: #3a4150; color: #eee; border: 1px solid #5c677d; border-radius: 4px; padding: 8px 10px; cursor: pointer; }
        #bm-script-filter { width: 100%; padding: 8px 70px 8px 10px; background-color: #3a4150; color: #eee; border: 1px solid #5c677d; border-radius: 4px; box-sizing: border-box; }
        #bm-refresh-btn, #bm-token-btn { position: absolute; top: 7px; font-size: 1.5em; cursor: pointer; color: #aaa; transition: color .2s, transform .5s; }
        #bm-refresh-btn { right: 10px; }
        #bm-refresh-btn:hover { color: #fff; transform: rotate(180deg); }
        #bm-token-btn { right: 40px; }
        #bm-token-btn:hover { color: #fff; transform: scale(1.1); }
        #b-m-scriptmanager-link.bm-update-highlight { background-color: #28a745; border-radius: 3px; }
        #bm-stats-bar { background-color: rgba(58, 65, 80, 0.5); border: 1px solid #5c677d; border-radius: 4px; padding: 8px 15px; margin-bottom: 15px; font-size: 0.9em; color: #ccc; text-align: center; flex-shrink: 0; }
        #bm-stats-bar .stat-count { font-weight: bold; color: #eee; margin: 0 2px; }
        #bm-stats-bar .stat-count.active { color: #28a745; }
        #bm-stats-bar .stat-count.inactive { color: #dc3545; }
        #bm-update-list-container { margin-bottom: 15px; }
        #bm-update-list-container h4 { color: #ffc107; border-bottom: 1px solid #ffc107; padding-bottom: 5px; margin: 0 0 15px 0; }
        #bm-update-list { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 75px; gap: 15px; }
        #script-list { display: flex; flex-wrap: wrap; gap: 15px; }
        .bm-category-group { border: 1px solid #444c5e; border-radius: 5px; margin: 0; background: linear-gradient(145deg, #3a4150, #2c313d); box-shadow: 2px 2px 5px rgba(0,0,0,0.3); transition: all 0.3s ease; flex-basis: 300px; flex-grow: 1; }
        .bm-category-group:hover { border-color: #007bff; box-shadow: 3px 3px 8px rgba(0, 123, 255, 0.3); transform: translateY(-2px); }
        details[open].bm-category-group { flex-basis: 100%; background: transparent; box-shadow: none; border-color: #444c5e; }
        details[open].bm-category-group:hover { transform: none; border-color: #444c5e; box-shadow: none; }
        .bm-category-header { padding: 15px; cursor: pointer; border-radius: 4px; transition: background-color 0.2s ease; text-align: center; position: relative; list-style: none; }
        .bm-category-header::-webkit-details-marker { display: none; }
        .bm-category-header::after { content: '‣'; position: absolute; right: 20px; top: 50%; transform: translateY(-50%) rotate(0deg); transition: transform 0.3s ease; font-size: 1.5em; color: #aaa; }
        details[open] .bm-category-header::after { transform: translateY(-50%) rotate(90deg); }
        details[open] .bm-category-header { border-radius: 4px 4px 0 0; background-color: #3a4150; text-align: left; }
        .bm-cat-title { font-size: 1.3em; font-weight: bold; color: #eee; margin-bottom: 10px; }
        details[open] .bm-cat-title { font-size: 1.2em; margin-bottom: 0; display: inline-block; }
        .bm-category-grid { display: grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 75px; gap: 15px; padding: 0 15px; background-color: rgba(40, 48, 61, 0.3); max-height: 0; overflow: hidden; transition: max-height 0.4s ease-in-out, padding 0.4s ease-in-out; }
        details[open] .bm-category-grid { max-height: 2000px; padding-top: 15px; padding-bottom: 15px; }
        .script-button { padding: 8px; border-radius: 5px; cursor: pointer; transition: all 0.2s ease; position: relative; border: 2px solid transparent; text-align: center; font-size: 0.85em; display: flex; flex-direction: column; justify-content: center; align-items: center; }
        .script-button.hidden { display: none; }
        .script-button:hover { filter: brightness(1.15); transform: translateY(-2px); }
        .script-button strong { line-height: 1.2; }
        .script-button .version { font-size: 0.8em; opacity: 0.8; display: block; margin-top: 4px; }
        .script-button.install { background-color: #007bff; color: white; border-color: #007bff; }
        .script-button.update { background-color: #ffc107; border-color: #ffc107; color: #212529; }
        .script-button.active { background-color: #28a745; color: white; border-color: #28a745; }
        .script-button.inactive { background-color: #6c757d; color: white; border-color: #6c757d; }
        .script-button.uninstall { background-color: #dc3545; color: white; border-color: #dc3545; }
        .script-button.activate { background-color: #17a2b8; border-color: #17a2b8; color: white; }
        .script-button.removed { background-color: #495057; color: #ced4da; border-color: #343a40; }
        .script-button.removed:hover { filter: brightness(1); transform: none; }
        .script-button.removed strong { text-decoration: line-through; }
        .script-button.downgrade { background-color: #fd7e14; border-color: #fd7e14; color: white; }
        #save-scripts-button { display: none; width: 100%; padding: 10px; margin-top: 20px; font-weight: bold; color: white; background-color: #007bff; border: none; border-radius: 5px; cursor: pointer; flex-shrink: 0; }
        .bm-config-btn { cursor: pointer; font-size: 1.1em; position: absolute; bottom: 5px; right: 8px; opacity: 0.6; transition: opacity 0.2s; }
        .script-button:hover .bm-config-btn { opacity: 1; }
        .bm-close-btn { position: absolute; top: 10px; right: 15px; font-size: 28px; font-weight: bold; color: #aaa; cursor: pointer; line-height: 1; transition: color 0.2s ease; }
        .bm-close-btn:hover { color: #fff; }
        .bm-loader-container { display: flex; justify-content: center; align-items: center; padding: 40px; color: #aaa; font-size: 1.1em; grid-column: 1 / -1; }
        .bm-loader { display: inline-block; border: 4px solid #444; border-top: 4px solid #007bff; border-radius: 50%; width: 24px; height: 24px; animation: bm-spin 1s linear infinite; margin-right: 15px; flex-shrink: 0; }
        @keyframes bm-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .bm-modal-overlay { display: none; position: fixed; z-index: 10001; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); justify-content: center; align-items: center; }
        .bm-settings-content { background-color: #2c313d; color: #eee; padding: 20px; border-radius: 5px; border: 1px solid #444c5e; width: 90%; max-width: 500px; box-shadow: 0 5px 20px rgba(0,0,0,0.5); }
        .bm-settings-header { font-size: 1.5em; margin-bottom: 20px; border-bottom: 1px solid #444c5e; padding-bottom: 10px; }
        .bm-settings-body { max-height: 60vh; overflow-y: auto; padding-right: 10px; }
        .bm-settings-row { display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: center; margin-bottom: 12px; }
        .bm-settings-row label { text-align: right; cursor: help; }
        .bm-settings-row input, .bm-settings-row select { width: 100%; box-sizing: border-box; background-color: #dadada; color: #111; border: 1px solid #999; padding: 5px; border-radius: 3px; transition: border-color .2s ease; }
        .bm-settings-row input:focus, .bm-settings-row select:focus { outline: none; border-color: #007bff; }
        .bm-settings-row input[type="checkbox"] { width: 20px; height: 20px; justify-self: start; }
        .bm-settings-footer { margin-top: 20px; text-align: right; border-top: 1px solid #444c5e; padding-top: 15px; }
        .bm-settings-footer button { background-color: #007bff; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; margin-left: 10px; }
    `);

    // START
    window.BMScriptManager.initSystem();
})();
