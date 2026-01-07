// ==UserScript==
// @name         B&M Scriptmanager (V21 - Solid Blue & Squeezed Tabs)
// @namespace    https://github.com/taskforce-Nord/public
// @version      21.0.0
// @description  Vollflächige Farben (Blau/Rot/Grau). Tabs quetschen sich (Browser-Style). Fix für Reaktivierung.
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
    const GITHUB_REPO_NAME = 'public';
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

    // UI State
    let activeTab = 'Alle';
    let cachedScriptData = { online: [], local: [] };

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
                const token = GM_getValue(GM_TOKEN_KEY, "");
                const access = await this._checkRepoAccess(token);

                if (access === 'DENIED') {
                    console.error("[B&M] Access Denied.");
                    this._showSetupScreen("Zugriff auf Haupt-Repository verweigert.<br>Bitte Token prüfen.");
                    return;
                }

                await this.openDatabase();
                await this._executeInstalledScripts(token);
                this._initUIHooks();
                this.checkForUpdatesInBackground();

            } catch (e) { console.error("[B&M Init Error]", e); }
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
                    if(status) { status.innerHTML = msg; status.style.color = '#ff4444'; }
                    const btn = document.createElement('div');
                    btn.innerHTML = '⚠️ B&M Setup';
                    btn.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#d9534f;color:white;padding:10px;border-radius:5px;cursor:pointer;font-family:sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.5);';
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
                    script.isActive = false; script.authSuspended = true;
                    this.saveScriptToDB(script);
                    continue;
                }
                if (script.authSuspended) continue;
                try {
                    const isMatch = script.match.some(pattern => new RegExp(pattern.replace(/\*/g, '.*')).test(window.location.href));
                    if (isMatch) { eval(script.code); count++; }
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
                const onlineScripts = await this.fetchScriptsWithManifest(repoInfo);
                if(onlineScripts.length === 0) return;
                if(!db) await this.openDatabase();
                const localScripts = await this.getScriptsFromDB();
                const activeLocals = localScripts.filter(s => s.isActive);
                const updateFound = activeLocals.some(local => {
                    const remote = onlineScripts.find(s => s.name === local.name);
                    return remote && this.compareVersions(remote.version, local.version) > 0;
                });
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

        // --- API ---
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

        // --- CORE UI LOGIC ---
        loadAndDisplayScripts: async function(forceRefresh = false) {
            const scriptList = document.getElementById('script-list');
            if(cachedScriptData.online.length === 0 || forceRefresh) {
                scriptList.innerHTML = '<div class="bm-loader-container"><div class="bm-loader"></div> Lade Daten...</div>';
            }

            if (forceRefresh) {
                sessionStorage.removeItem('bm_cache_data');
                sessionStorage.removeItem('bm_cache_timestamp');
                activeTab = 'Alle';
            }

            try {
                const token = GM_getValue(GM_TOKEN_KEY, "");
                const repoInfo = { owner: GITHUB_REPO_OWNER, name: GITHUB_REPO_NAME, token: token };
                const onlineScripts = await this.fetchScriptsWithManifest(repoInfo);
                const localScripts = await this.getScriptsFromDB();

                cachedScriptData = { online: onlineScripts, local: localScripts };
                sessionStorage.setItem('bm_cache_data', JSON.stringify(onlineScripts));
                sessionStorage.setItem('bm_cache_timestamp', Date.now());
                this._renderTabsAndContent();

            } catch (e) {
                scriptList.innerHTML = `<p style="color:var(--danger-color); text-align:center;">Fehler: ${e.message}</p>`;
            }
        },

        _renderTabsAndContent: function() {
            const { online, local } = cachedScriptData;
            const container = document.getElementById('script-list');
            container.innerHTML = '';

            const categoryMap = new Map();
            const detailsMap = new Map();
            let hasUpdates = false;

            // Token Check für Self-Healing
            const tokenValid = !!GM_getValue(GM_TOKEN_KEY, "");

            online.forEach(meta => {
                scriptMetadataCache[meta.name] = meta;
                const loc = local.find(s => s.name === meta.name);

                let state = 'install';
                let info = (meta.description || "") + (meta.changelog || "");

                if (loc) {
                    if(loc.isActive === false) state = 'inactive';
                    else {
                        const cmp = this.compareVersions(meta.version, loc.version);
                        if (cmp > 0) { state = 'update'; hasUpdates = true; }
                        else if (cmp < 0) state = 'downgrade';
                        else state = 'active';
                    }
                    if (loc.hasSettings) meta.hasSettings = true;
                }

                // HEALING: Wenn Token da ist, ignorieren wir "authSuspended" Flag für die UI
                if ((meta.authSuspended || (loc && loc.authSuspended)) && !tokenValid) {
                    state = 'inactive'; meta.authSuspended = true;
                    info = `<strong style="color:var(--danger-color)">GESPERRT (Token Fehler)</strong><br>${info}`;
                } else {
                    // Token da -> entsperren
                    meta.authSuspended = false;
                }

                if (!scriptStates[meta.name]) {
                    scriptStates[meta.name] = state;
                    initialScriptStates[meta.name] = state;
                }

                const item = { meta, info, state: scriptStates[meta.name] };
                detailsMap.set(meta.name, item);

                const cats = meta.categories || [DEFAULT_CATEGORY];
                cats.forEach(c => {
                    if(!categoryMap.has(c)) categoryMap.set(c, []);
                    categoryMap.get(c).push(item);
                });
            });

            // TABS (SQUEEZED FLEX)
            const tabsBar = document.createElement('div');
            tabsBar.className = 'bm-tabs';

            const allTab = document.createElement('div');
            allTab.className = `bm-tab ${activeTab === 'Alle' ? 'active' : ''}`;
            allTab.textContent = `Alle (${detailsMap.size})`;
            allTab.onclick = () => this._switchTab('Alle');
            tabsBar.appendChild(allTab);

            if (hasUpdates) {
                const updateCount = [...detailsMap.values()].filter(d => d.state === 'update' || d.state === 'downgrade').length;
                const upTab = document.createElement('div');
                upTab.className = `bm-tab bm-tab-update ${activeTab === 'Updates' ? 'active' : ''}`;
                upTab.textContent = `Updates (${updateCount})`;
                upTab.onclick = () => this._switchTab('Updates');
                tabsBar.appendChild(upTab);
            }

            const sortedCats = [...categoryMap.keys()].sort();
            sortedCats.forEach(cat => {
                const count = categoryMap.get(cat).length;
                const tab = document.createElement('div');
                tab.className = `bm-tab ${activeTab === cat ? 'active' : ''}`;
                tab.textContent = `${cat} (${count})`;
                tab.onclick = () => this._switchTab(cat);
                tabsBar.appendChild(tab);
            });
            container.appendChild(tabsBar);

            // GRID
            const grid = document.createElement('div');
            grid.className = 'bm-category-grid';

            let itemsToShow = [];
            const filterText = document.getElementById('bm-script-filter').value.toLowerCase();

            if (activeTab === 'Alle') itemsToShow = [...detailsMap.values()];
            else if (activeTab === 'Updates') itemsToShow = [...detailsMap.values()].filter(d => d.state === 'update' || d.state === 'downgrade');
            else itemsToShow = categoryMap.get(activeTab) || [];

            if (filterText) itemsToShow = itemsToShow.filter(i => i.meta.name.toLowerCase().includes(filterText) || i.info.toLowerCase().includes(filterText));
            itemsToShow.sort((a,b) => a.meta.name.localeCompare(b.meta.name));

            if (itemsToShow.length === 0) grid.innerHTML = '<p style="padding:20px; color:var(--text-muted); grid-column:1/-1;">Keine Skripte in dieser Ansicht.</p>';
            else itemsToShow.forEach(item => grid.appendChild(this.createUIElement(item)));

            container.appendChild(grid);

            const btn = document.getElementById('save-scripts-button');
            if(btn.textContent.indexOf("Gespeichert") === -1) { btn.textContent = "Änderungen anwenden"; btn.disabled = false; }
            btn.style.display = 'block';

            const statsBar = document.getElementById('bm-stats-bar');
            const totalInstalled = [...detailsMap.values()].filter(d => d.state !== 'install' && d.state !== 'install_pending').length;
            const totalActive = [...detailsMap.values()].filter(d => ['active','update','downgrade'].includes(d.state)).length;
            if(statsBar) statsBar.innerHTML = `Installiert: <span style="color:#eee; font-weight:bold;">${totalInstalled}</span> | Aktiv: <span style="color:var(--primary-blue); font-weight:bold;">${totalActive}</span>`;
        },

        _switchTab: function(tabName) {
            activeTab = tabName;
            this._renderTabsAndContent();
        },

        createUIElement: function(item) {
            const div = document.createElement('div');
            div.className = `script-button ${item.state}`;
            if(item.meta.authSuspended) div.style.opacity = '0.5';

            div.dataset.scriptName = item.meta.name.toLowerCase();

            let label = `<strong>${item.meta.name}</strong><div class="version">v${item.meta.version}</div>`;
            if (item.state === 'update') label = `<strong>${item.meta.name}</strong><div class="version update-text">🔄 v${item.meta.version}</div>`;

            // Visualisierung für Pending States
            if (item.state === 'install_pending') {
                label = `<strong>${item.meta.name}</strong><div class="version" style="color:black;">Wird installiert</div>`;
            } else if (item.state === 'uninstall_pending') {
                label = `<strong><strike>${item.meta.name}</strike></strong><div class="version" style="color:white;">Wird gelöscht</div>`;
            }

            div.innerHTML = label;
            div.title = item.info.replace(/<[^>]*>?/gm, '');

            if (!item.meta.authSuspended) {
                // DELETE BUTTON (X) - Z-Index Fix
                if (['active', 'update', 'inactive', 'downgrade', 'uninstall_pending'].includes(item.state)) {
                    const del = document.createElement('span');
                    del.className = 'bm-del-btn';
                    del.innerHTML = '✖';
                    del.title = item.state === 'uninstall_pending' ? 'Löschen abbrechen' : 'Deinstallieren';
                    del.onclick = (e) => {
                        e.stopPropagation();
                        e.preventDefault();

                        if (item.state === 'uninstall_pending') {
                            // Undo
                            item.state = initialScriptStates[item.meta.name];
                            scriptStates[item.meta.name] = initialScriptStates[item.meta.name];
                        } else {
                            if(confirm(`Skript "${item.meta.name}" wirklich entfernen?`)) {
                                item.state = 'uninstall_pending';
                                scriptStates[item.meta.name] = 'uninstall';
                            }
                        }
                        this._renderTabsAndContent();
                    };
                    div.appendChild(del);
                }

                if (['active', 'update'].includes(item.state) && item.meta.hasSettings) {
                    const cfg = document.createElement('span');
                    cfg.className = 'bm-config-btn';
                    cfg.innerHTML = '⚙️';
                    cfg.onclick = (e) => { e.stopPropagation(); this._fetchAndShowSettingsUI(item.meta.name); };
                    div.appendChild(cfg);
                }
            }

            // MAIN CLICK (Toggle Logic)
            div.onclick = () => {
                if(item.meta.authSuspended) { alert("Skript gesperrt. Bitte Token prüfen."); return; }
                if(item.state === 'uninstall_pending') return;

                const current = item.state;
                let next = current;

                if (current === 'install') next = 'install_pending';
                else if (current === 'install_pending') next = 'install';
                else if (['active', 'update', 'downgrade'].includes(current)) next = 'inactive';
                else if (current === 'inactive') next = 'active';

                scriptStates[item.meta.name] = next;
                item.state = next;
                this._renderTabsAndContent();
            };
            return div;
        },

        applyChanges: async function() {
            const btn = document.getElementById('save-scripts-button');
            btn.disabled = true;
            btn.textContent = "Prüfe Änderungen...";

            let changes = [];
            for (const name in scriptStates) {
                const s = scriptStates[name];
                if (s === 'install_pending' || s === 'uninstall' || s === 'update' || (s !== initialScriptStates[name] && s !== 'install')) {
                    changes.push(name);
                }
            }

            if(changes.length === 0) {
                btn.textContent = "Keine Änderungen";
                setTimeout(() => { btn.disabled = false; btn.textContent = "Änderungen anwenden"; }, 1500);
                return;
            }

            let errors = [];
            for (let i = 0; i < changes.length; i++) {
                const name = changes[i];
                const state = scriptStates[name];
                btn.textContent = `Speichere ${i+1}/${changes.length}: ${name}...`;
                try {
                    const meta = scriptMetadataCache[name];
                    if (state === 'install_pending' || state === 'activate' || state === 'update' || state === 'downgrade' || state === 'active') {
                        const res = await this.fetchRawScript(meta.dirName, meta.fullName, meta.repoInfo);
                        if (res.success) {
                            const hasCfg = this.codeHasSettings(res.content);
                            const match = this.extractMatchFromCode(res.content);
                            const scriptObj = { name: meta.name, version: meta.version, code: res.content, match: match, hasSettings: hasCfg, isActive: true, repoInfo: meta.repoInfo };
                            await this.saveScriptToDB(scriptObj);
                        } else errors.push(`${name}: Fehler beim Download`);
                    } else if (state === 'inactive') {
                        const local = await this.getSingleScriptFromDB(name);
                        if(local) { local.isActive = false; await this.saveScriptToDB(local); }
                    } else if (state === 'uninstall') {
                        await this.deleteScriptFromDB(name);
                    }
                } catch(e) { errors.push(`${name}: ${e.message}`); }
            }

            if(errors.length > 0) alert("Fehler:\n" + errors.join("\n"));
            cachedScriptData.local = await this.getScriptsFromDB();
            this._renderTabsAndContent();
            btn.textContent = "Gespeichert! (Schließen zum Aktivieren)";
            setTimeout(() => { if(btn) btn.disabled = false; }, 1000);
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
                } catch (e) { content.innerHTML = '<p style="color:var(--danger-color)">Config Fehler.</p><button onclick="this.parentElement.parentElement.style.display=\'none\'">Zu</button>'; }
            } else { content.innerHTML = '<p>Keine Einstellungen.</p><button onclick="this.parentElement.parentElement.style.display=\'none\'">Zu</button>'; }
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
            html += `</div><div class="bm-settings-footer"><button id="bm-set-save">Speichern</button> <button id="bm-set-cancel" style="background:var(--btn-secondary)">Abbrechen</button></div>`;
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
                        <div id="bm-stats-bar">Lade Statistiken...</div>
                    </div>
                    <div id="script-list"></div>
                </div>
                <button id="save-scripts-button" style="display:none;">Änderungen anwenden</button>
            `;
            document.body.appendChild(div);
            div.querySelector('.bm-close-btn').onclick = () => location.reload();
            document.getElementById('bm-refresh-btn').onclick = () => this.loadAndDisplayScripts(true);
            document.getElementById('bm-token-btn').onclick = () => this._createTokenModalUI();
            document.getElementById('save-scripts-button').addEventListener('click', () => this.applyChanges());
            document.getElementById('bm-script-filter').addEventListener('input', () => this._renderTabsAndContent());
            managerUiCreated = true;
        },

        _createTokenModalUI: function() {
            if (!tokenModalUiCreated) {
                const div = document.createElement('div');
                div.id = 'bm-token-modal';
                div.className = 'bm-modal-overlay';
                div.style.zIndex = '10002';
                div.innerHTML = `
                    <div class="bm-settings-content" style="max-width: 400px;">
                        <div class="bm-settings-header">🔒 Zugangstoken</div>
                        <div class="bm-settings-body" style="overflow:visible;">
                            <p style="font-size:0.9em; color:var(--text-muted); margin-bottom:10px;">Token für privaten Repo-Zugriff:</p>
                            <input type="password" id="bm-pat-input" placeholder="github_pat_..." style="width:100%; padding:8px;">
                            <div style="text-align:right; margin-top:5px;"><input type="checkbox" id="bm-pat-show"> Anzeigen</div>
                            <div id="bm-pat-status" style="margin-top:10px;"></div>
                        </div>
                        <div class="bm-settings-footer">
                            <button id="bm-pat-del" style="background:var(--danger-color);">Löschen</button>
                            <button id="bm-pat-save" style="background:var(--success-color);">Speichern</button>
                            <button id="bm-pat-close" style="background:var(--btn-secondary);">Schließen</button>
                        </div>
                    </div>`;
                document.body.appendChild(div);
                document.getElementById('bm-pat-close').onclick = () => div.style.display = 'none';
                document.getElementById('bm-pat-show').onchange = (e) => document.getElementById('bm-pat-input').type = e.target.checked ? 'text' : 'password';
                document.getElementById('bm-pat-del').onclick = async () => {
                    if(confirm("Token löschen?")) {
                        GM_deleteValue(GM_TOKEN_KEY); localStorage.removeItem(LS_ACCESS_KEY);
                        const scripts = await this.getScriptsFromDB();
                        for(const s of scripts) { if(s.repoInfo && s.repoInfo.owner === GITHUB_REPO_OWNER) { s.isActive = false; s.authSuspended = true; await this.saveScriptToDB(s); } }
                        location.reload();
                    }
                };
                document.getElementById('bm-pat-save').onclick = () => {
                    const v = document.getElementById('bm-pat-input').value.trim();
                    if(!v) return alert("Token fehlt.");
                    GM_setValue(GM_TOKEN_KEY, v); location.reload();
                };
                tokenModalUiCreated = true;
            }
            document.getElementById('bm-pat-input').value = GM_getValue(GM_TOKEN_KEY, "");
            document.getElementById('bm-token-modal').style.display = 'flex';
        }
    };

    // --- CSS (SOLID COLORS & SQUEEZED TABS) ---
    GM_addStyle(`
        :root {
            --bg-dark: #1e2126;
            --bg-panel: #2c313a;
            --bg-card: #323a45;
            --text-main: #eeeeee;
            --text-muted: #aaaaaa;
            --primary-blue: #0d6efd;
            --primary-blue-hover: #0b5ed7;
            --pending-cyan: #17a2b8;
            --success-color: #28a745;
            --warning-color: #f0ad4e;
            --danger-color: #dc3545;
            --btn-secondary: #5a6268;
            --border-color: #444c5e;
            --shadow-soft: 0 4px 6px rgba(0,0,0,0.3);
            --font-family: "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        #lss-script-manager-container, .bm-modal-overlay { font-family: var(--font-family); color: var(--text-main); font-size: 14px; }

        #lss-script-manager-container {
            position: fixed; top: 8vh; left: 50%; transform: translateX(-50%); z-index: 10000;
            background-color: var(--bg-dark); border: 1px solid var(--border-color);
            border-radius: 8px; padding: 20px; height: 80vh; width: 90%; max-width: 1200px;
            display: none; flex-direction: column; box-sizing: border-box;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        #lss-script-manager-container.visible { display: flex; }

        .bm-modal-content {
            flex-grow: 1; overflow-y: auto; min-height: 0; padding-right: 8px;
            display: flex; flex-direction: column;
        }

        /* Custom Scrollbar */
        .bm-modal-content::-webkit-scrollbar { width: 8px; }
        .bm-modal-content::-webkit-scrollbar-track { background: var(--bg-dark); border-radius: 4px; }
        .bm-modal-content::-webkit-scrollbar-thumb { background-color: var(--border-color); border-radius: 4px; }

        #lss-script-manager-container h3 {
            text-align: center; border-bottom: 2px solid var(--primary-blue);
            padding-bottom: 12px; margin: 0 0 20px 0; font-weight: 300; font-size: 1.8em; letter-spacing: 1px;
        }

        .bm-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 15px; }
        #bm-script-filter-wrapper { position: relative; flex-grow: 1; max-width: 400px; }
        #bm-script-filter {
            width: 100%; padding: 10px 40px 10px 15px; background-color: var(--bg-panel);
            color: var(--text-main); border: 1px solid var(--border-color); border-radius: 20px;
            box-sizing: border-box; transition: border-color 0.2s;
        }
        #bm-script-filter:focus { outline: none; border-color: var(--primary-blue); }

        #bm-refresh-btn, #bm-token-btn {
            position: absolute; top: 8px; font-size: 1.2em; cursor: pointer; color: var(--text-muted);
            transition: color 0.2s, transform 0.3s;
        }
        #bm-refresh-btn { right: 15px; }
        #bm-token-btn { right: 45px; }
        #bm-refresh-btn:hover, #bm-token-btn:hover { color: var(--text-main); transform: scale(1.1); }

        #bm-stats-bar { font-size: 0.9em; color: var(--text-muted); }

        /* TABS (BROWSER FLEX STYLE) */
        .bm-tabs {
            display: flex; flex-wrap: nowrap; width: 100%; gap: 2px;
            border-bottom: 1px solid var(--border-color); margin-bottom: 20px;
            overflow: hidden;
        }

        .bm-tab {
            flex: 1 1 0;
            min-width: 0;
            padding: 10px 5px;
            background: #333; color: #aaa; cursor: pointer;
            border-radius: 5px 5px 0 0; transition: flex-grow 0.2s ease, background-color 0.2s;
            font-weight: 500; text-align: center;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border: 1px solid #444; border-bottom: none;
        }
        .bm-tab:hover { flex-grow: 2; background: var(--bg-card); color: var(--text-main); z-index: 2; }

        /* FILLED BLUE BUBBLE FOR ACTIVE TAB */
        .bm-tab.active {
            flex-grow: 3;
            background-color: var(--primary-blue) !important;
            color: white !important;
            font-weight: bold;
            z-index: 1;
            border-color: var(--primary-blue) !important;
            opacity: 1;
        }

        .bm-tab-update.active { background: var(--warning-color) !important; color: #333 !important; border-color: var(--warning-color) !important; }

        /* GRID & CARDS */
        .bm-category-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 12px; padding-bottom: 10px;
        }

        .script-button {
            padding: 15px; border-radius: 6px; cursor: pointer; position: relative;
            background: var(--bg-panel); text-align: center; min-height: 80px;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            transition: transform 0.2s, box-shadow 0.2s; border: 1px solid transparent;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .script-button:hover { transform: translateY(-3px); box-shadow: var(--shadow-soft); z-index: 10; }

        /* STATE COLORS (SOLID) */
        .script-button.install { border-color: var(--btn-secondary); color: var(--text-muted); }
        .script-button.install_pending { background: var(--pending-cyan); color: #000; border: none; }

        /* FILLED ACTIVE BUTTON */
        .script-button.active {
            background: var(--primary-blue);
            color: white;
            border: none;
        }
        .script-button.active strong { color: white; }

        .script-button.inactive { background: #343a40; color: #aaa; border: 1px solid var(--border-color); opacity: 0.9; }
        .script-button.update { background: linear-gradient(135deg, var(--warning-color), #e0a800); color: #222; animation: none; }

        .script-button.uninstall_pending {
            background: var(--danger-color); color: white; border: none; opacity: 0.9;
        }

        .script-button strong { display: block; font-size: 1.05em; margin-bottom: 5px; line-height: 1.3; }
        .version { font-size: 0.85em; opacity: 0.8; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 10px; }

        .bm-config-btn {
            position: absolute; bottom: 5px; right: 5px; font-size: 1.1em; opacity: 0.6;
            transition: opacity 0.2s; padding: 2px;
        }
        .bm-del-btn {
            position: absolute; top: 2px; right: 5px; font-size: 1.1em; opacity: 0.6; color: #fff;
            transition: opacity 0.2s; padding: 2px; font-weight: bold; z-index: 50; /* Z-Index erhöht */
        }
        .bm-del-btn:hover { color: var(--text-main); transform: scale(1.3); opacity: 1; }
        .script-button:hover .bm-config-btn, .script-button:hover .bm-del-btn { opacity: 1; }

        /* FOOTER */
        #save-scripts-button {
            width: 100%; padding: 14px; margin-top: 15px; font-weight: bold; color: white;
            background-color: var(--primary-blue); border: none; border-radius: 6px;
            cursor: pointer; font-size: 1.1em; transition: background 0.2s;
        }
        #save-scripts-button:hover { background-color: var(--primary-blue-hover); }
        #save-scripts-button:disabled { background-color: var(--btn-secondary); cursor: not-allowed; }

        .bm-close-btn { position: absolute; top: 15px; right: 20px; font-size: 24px; cursor: pointer; color: var(--text-muted); transition: color 0.2s; }
        .bm-close-btn:hover { color: var(--text-main); }

        /* MODAL */
        .bm-modal-overlay {
            display: none; position: fixed; z-index: 10001; left: 0; top: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
            justify-content: center; align-items: center;
        }
        .bm-settings-content {
            background-color: var(--bg-dark); color: var(--text-main); padding: 25px;
            border-radius: 10px; border: 1px solid var(--border-color); width: 90%; max-width: 500px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6);
        }
        .bm-settings-header {
            font-size: 1.4em; margin-bottom: 20px; border-bottom: 1px solid var(--border-color);
            padding-bottom: 10px; font-weight: 300;
        }
        .bm-settings-row { display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: center; margin-bottom: 15px; }
        .bm-settings-row input, .bm-settings-row select {
            width: 100%; box-sizing: border-box; background-color: var(--bg-panel); color: var(--text-main);
            border: 1px solid var(--border-color); padding: 8px; border-radius: 4px;
        }
        .bm-settings-footer { margin-top: 25px; text-align: right; border-top: 1px solid var(--border-color); padding-top: 15px; }
        .bm-settings-footer button {
            padding: 10px 20px; border-radius: 5px; border: none; cursor: pointer; margin-left: 10px; font-weight: 500; color: white;
        }

        .bm-loader {
            display: inline-block; border: 3px solid rgba(255,255,255,0.1);
            border-top: 3px solid var(--primary-blue); border-radius: 50%;
            width: 20px; height: 20px; animation: bm-spin 0.8s linear infinite; margin-right: 10px; vertical-align: middle;
        }
        @keyframes bm-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        #b-m-scriptmanager-link.bm-update-highlight { background-color: var(--primary-blue) !important; color: white !important; border-radius: 4px; padding: 2px 6px; }
    `);

    // START
    window.BMScriptManager.initSystem();
})();
