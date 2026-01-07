// ==UserScript==
// @name         B&M Scriptmanager (V25.1 - UX Fixes)
// @namespace    https://github.com/taskforce-Nord/public
// @version      25.1.0
// @description  Fix: Repo-Manager öffnet sofort. Kein Seiten-Reload mehr beim Speichern von Tokens. High-Contrast UI.
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

    // --- KONFIGURATION HAUPT-REPO ---
    const PRIMARY_REPO = {
        owner: 'Taskforce-Nord',
        name: 'public',
        path: 'Taskforce-Nord/public'
    };

    const DB_NAME = 'BM-DB-TN';
    const DB_VERSION = 1;
    const DEFAULT_CATEGORY = "Sonstiges";

    const GM_TOKEN_KEY = "bm_access_pat";
    const GM_CUSTOM_REPOS_KEY = "bm_custom_repos";
    const LS_ACCESS_KEY = "bm_access_cfg";

    // Globals
    let scriptStates = {};
    let initialScriptStates = {};
    let scriptMetadataCache = {};
    let db;
    let managerUiCreated = false;
    let settingsModalUiCreated = false;
    let repoModalUiCreated = false;

    let activeTab = 'Alle';
    let cachedScriptData = { online: [], local: [] };

    // --- INIT ---
    try {
        const savedPat = GM_getValue(GM_TOKEN_KEY, "");
        if (savedPat) localStorage.setItem(LS_ACCESS_KEY, `${savedPat}@${PRIMARY_REPO.path}`);
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
                const access = await this._checkRepoAccess(PRIMARY_REPO.owner, PRIMARY_REPO.name, token);

                if (access === 'DENIED') {
                    console.error("[B&M] Primary Access Denied.");
                    this._showSetupScreen("Zugriff auf Haupt-Repository verweigert.<br>Bitte Token prüfen.");
                    return;
                }

                await this.openDatabase();
                await this._executeInstalledScripts(token);
                this._initUIHooks();
                this.checkForUpdatesInBackground();

            } catch (e) { console.error("[B&M Init Error]", e); }
        },

        _checkRepoAccess: function(owner, name, token) {
            const url = `https://api.github.com/repos/${owner}/${name}/contents/manifest.json`;
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
                    this._createRepoManagerUI();
                    const status = document.getElementById('bm-repo-status');
                    if(status) { status.innerHTML = msg; status.style.color = '#ff6b6b'; }
                    const btn = document.createElement('div');
                    btn.innerHTML = '⚠️ B&M Setup';
                    btn.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#d9534f;color:white;padding:10px;border-radius:5px;cursor:pointer;font-family:sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.5);';
                    btn.onclick = () => this._createRepoManagerUI();
                    document.body.appendChild(btn);
                }
            }, 100);
        },

        _executeInstalledScripts: async function(token) {
            if (!db) return;
            const scripts = await this.getScriptsFromDB();
            let count = 0;

            const customRepos = JSON.parse(GM_getValue(GM_CUSTOM_REPOS_KEY, "[]"));

            for (const script of scripts.filter(s => s.isActive !== false)) {
                let scriptToken = null;
                if (script.repoInfo && script.repoInfo.owner === PRIMARY_REPO.owner && script.repoInfo.name === PRIMARY_REPO.name) {
                    scriptToken = token;
                } else if (script.repoInfo) {
                    const cr = customRepos.find(r => r.owner === script.repoInfo.owner && r.name === script.repoInfo.name);
                    if(cr) scriptToken = cr.token;
                }

                if (script.repoInfo && !scriptToken) {
                     if ((script.repoInfo.owner === PRIMARY_REPO.owner && script.repoInfo.name === PRIMARY_REPO.name) || (script.repoInfo.tokenNeeded)) {
                         console.warn(`[B&M] Blocked '${script.name}': Missing Token.`);
                         script.isActive = false; script.authSuspended = true;
                         this.saveScriptToDB(script);
                         continue;
                     }
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
                const repoInfo = { owner: PRIMARY_REPO.owner, name: PRIMARY_REPO.name, token: token };
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

        // --- UI CORE ---
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
                // 1. Primary
                const primaryToken = GM_getValue(GM_TOKEN_KEY, "");
                const primaryInfo = { owner: PRIMARY_REPO.owner, name: PRIMARY_REPO.name, token: primaryToken, label: 'Stable' };
                const p1 = this.fetchScriptsWithManifest(primaryInfo);

                // 2. Custom
                const customRepos = JSON.parse(GM_getValue(GM_CUSTOM_REPOS_KEY, "[]"));
                const pCustom = customRepos.map(cr => this.fetchScriptsWithManifest({ owner: cr.owner, name: cr.name, token: cr.token, label: cr.name }));

                // 3. Merge
                const results = await Promise.all([p1, ...pCustom]);
                const allOnline = results.flat();

                // 4. Deduplicate
                const mergedMap = new Map();
                allOnline.forEach(script => {
                    if (!mergedMap.has(script.name)) {
                        mergedMap.set(script.name, script);
                    } else {
                        const existing = mergedMap.get(script.name);
                        if (this.compareVersions(script.version, existing.version) > 0) {
                            mergedMap.set(script.name, script);
                        }
                    }
                });
                const finalOnline = [...mergedMap.values()];

                const localScripts = await this.getScriptsFromDB();

                cachedScriptData = { online: finalOnline, local: localScripts };
                sessionStorage.setItem('bm_cache_data', JSON.stringify(finalOnline));
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

            online.forEach(meta => {
                scriptMetadataCache[meta.name] = meta;
                const loc = local.find(s => s.name === meta.name);

                let state = 'install';
                let info = (meta.description || "") + (meta.changelog || "");
                if(meta.repoInfo.label && meta.repoInfo.label !== 'Stable') info = `<em>Kanal: ${meta.repoInfo.label}</em><br>` + info;

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

                if (meta.authSuspended || (loc && loc.authSuspended)) {
                    state = 'inactive'; meta.authSuspended = true;
                    info = `<strong style="color:var(--danger-color)">GESPERRT (Token Fehler)</strong><br>${info}`;
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

            // TABS
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

            if (item.state === 'install_pending') label = `<strong>${item.meta.name}</strong><div class="version" style="background:var(--pending-cyan); color:black;">Wird installiert</div>`;
            else if (item.state === 'uninstall_pending') label = `<strong><strike>${item.meta.name}</strike></strong><div class="version" style="background:var(--danger-color); color:white;">Wird gelöscht</div>`;

            div.innerHTML = label;
            div.title = item.info.replace(/<[^>]*>?/gm, '');

            if (!item.meta.authSuspended) {
                if (['active', 'update', 'inactive', 'downgrade', 'uninstall_pending'].includes(item.state)) {
                    const del = document.createElement('span');
                    del.className = 'bm-del-btn';
                    del.innerHTML = '✖';
                    del.onclick = (e) => {
                        e.stopPropagation();
                        if (item.state === 'uninstall_pending') {
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
            btn.disabled = true; btn.textContent = "Prüfe Änderungen...";

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

            await this.loadAndDisplayScripts(true);
            btn.textContent = "Gespeichert! (Schließen zum Aktivieren)";
            setTimeout(() => { if(btn) btn.disabled = false; }, 1000);
        },

        // --- REPO MANAGER UI (FIXED VISIBILITY) ---
        _createRepoManagerUI: function() {
            if (repoModalUiCreated) {
                document.getElementById('bm-repo-modal').style.display = 'flex';
                this._refreshRepoList();
                return;
            }

            const div = document.createElement('div');
            div.id = 'bm-repo-modal';
            div.className = 'bm-modal-overlay';
            div.style.zIndex = '10005';
            div.innerHTML = `
                <div class="bm-settings-content" style="max-width: 650px;">
                    <div class="bm-settings-header">📚 Repository Verwaltung</div>
                    <div class="bm-settings-body">

                        <div class="bm-repo-card primary">
                            <div class="bm-repo-title">Haupt-Repository (Stable)</div>
                            <div style="font-size:0.8em; color:var(--text-muted);">${PRIMARY_REPO.path}</div>
                            <div class="bm-settings-row" style="margin-top:10px;">
                                <input type="password" id="bm-primary-token" placeholder="GitHub Token..." style="width:100%;">
                            </div>
                        </div>

                        <hr style="border-color:var(--border-color); margin: 20px 0;">

                        <div style="margin-bottom:10px; font-weight:bold;">Zusätzliche Kanäle (Beta / Alpha)</div>
                        <div id="bm-repo-list"></div>

                        <div class="bm-repo-add-form">
                            <input type="text" id="bm-new-owner" placeholder="Owner" style="flex:1">
                            <input type="text" id="bm-new-name" placeholder="Repo Name" style="flex:1">
                            <input type="password" id="bm-new-token" placeholder="Token (optional)" style="flex:1">
                            <button id="bm-add-repo-btn" style="background:var(--success-color)">+</button>
                        </div>
                        <div id="bm-repo-status" style="margin-top:10px; color:#aaa;"></div>

                    </div>
                    <div class="bm-settings-footer">
                        <button id="bm-repo-save" style="background:var(--success-color);">Speichern & Aktualisieren</button>
                        <button id="bm-repo-close" style="background:var(--btn-secondary);">Schließen</button>
                    </div>
                </div>`;
            document.body.appendChild(div);

            repoModalUiCreated = true;
            this._refreshRepoList();

            document.getElementById('bm-repo-close').onclick = () => div.style.display = 'none';

            document.getElementById('bm-add-repo-btn').onclick = () => {
                const owner = document.getElementById('bm-new-owner').value.trim();
                const name = document.getElementById('bm-new-name').value.trim();
                const token = document.getElementById('bm-new-token').value.trim();
                if(!owner || !name) return alert("Owner und Name erforderlich.");
                const repos = JSON.parse(GM_getValue(GM_CUSTOM_REPOS_KEY, "[]"));
                repos.push({ owner, name, token });
                GM_setValue(GM_CUSTOM_REPOS_KEY, JSON.stringify(repos));
                this._refreshRepoList();
                document.getElementById('bm-new-owner').value = "";
                document.getElementById('bm-new-name').value = "";
                document.getElementById('bm-new-token').value = "";
            };

            document.getElementById('bm-repo-save').onclick = async () => {
                const btn = document.getElementById('bm-repo-save');
                const oldText = btn.textContent;
                btn.disabled = true; btn.textContent = "Speichere...";

                const pToken = document.getElementById('bm-primary-token').value.trim();
                GM_setValue(GM_TOKEN_KEY, pToken);
                localStorage.setItem(LS_ACCESS_KEY, `${pToken}@${PRIMARY_REPO.path}`);

                await this.loadAndDisplayScripts(true);

                btn.textContent = "Gespeichert!";
                setTimeout(() => {
                    div.style.display = 'none';
                    btn.disabled = false;
                    btn.textContent = oldText;
                }, 800);
            };

            // SHOW
            div.style.display = 'flex';
        },

        _refreshRepoList: function() {
            const list = document.getElementById('bm-repo-list');
            const repos = JSON.parse(GM_getValue(GM_CUSTOM_REPOS_KEY, "[]"));
            const pToken = GM_getValue(GM_TOKEN_KEY, "");

            document.getElementById('bm-primary-token').value = pToken;

            list.innerHTML = "";
            if(repos.length === 0) list.innerHTML = "<div style='color:var(--text-muted); font-style:italic; padding:10px;'>Keine zusätzlichen Kanäle konfiguriert.</div>";

            repos.forEach((r, idx) => {
                const item = document.createElement('div');
                item.className = 'bm-repo-item';
                item.innerHTML = `
                    <div style="flex:1">
                        <strong>${r.owner}/${r.name}</strong><br>
                        <span style="font-size:0.8em; color:var(--text-muted);">${r.token ? "Token hinterlegt" : "Öffentlich"}</span>
                    </div>
                    <button class="bm-repo-del" data-idx="${idx}">🗑️</button>
                `;
                list.appendChild(item);
            });

            document.querySelectorAll('.bm-repo-del').forEach(btn => {
                btn.onclick = (e) => {
                    const idx = e.target.dataset.idx;
                    repos.splice(idx, 1);
                    GM_setValue(GM_CUSTOM_REPOS_KEY, JSON.stringify(repos));
                    this._refreshRepoList();
                };
            });
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
                        <input type="text" id="bm-script-filter" placeholder="Suche...">
                        <div class="bm-toolbar-right">
                            <div id="bm-stats-bar">Lade Statistiken...</div>
                            <div class="bm-actions">
                                <span id="bm-token-btn" title="Repositories & Token">🔑</span>
                                <span id="bm-refresh-btn" title="Reload">🔄</span>
                            </div>
                        </div>
                    </div>
                    <div id="script-list"></div>
                </div>
                <button id="save-scripts-button" style="display:none;">Änderungen anwenden</button>
            `;
            document.body.appendChild(div);
            div.querySelector('.bm-close-btn').onclick = () => location.reload();
            document.getElementById('bm-refresh-btn').onclick = () => this.loadAndDisplayScripts(true);
            document.getElementById('bm-token-btn').onclick = () => this._createRepoManagerUI();
            document.getElementById('save-scripts-button').addEventListener('click', () => this.applyChanges());
            document.getElementById('bm-script-filter').addEventListener('input', () => this._renderTabsAndContent());
            managerUiCreated = true;
        },

        // Redirect
        _createTokenModalUI: function() { this._createRepoManagerUI(); }
    };

    // --- CSS ---
    GM_addStyle(`
        :root {
            --bg-dark: #1e2126;
            --bg-panel: #2c313a;
            --bg-card: #323a45;
            --input-bg-high-contrast: #f0f2f5; /* HELL FÜR INPUTS */
            --text-on-light: #222; /* DUNKEL FÜR TEXT IN INPUTS */
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

        /* CLEAN TOOLBAR LAYOUT */
        .bm-toolbar {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 20px; gap: 15px;
        }

        /* SEARCH & INPUTS - HIGH CONTRAST */
        #bm-script-filter, .bm-repo-add-form input, .bm-settings-row input, .bm-settings-row select, #bm-primary-token {
            background-color: var(--input-bg-high-contrast);
            color: var(--text-on-light);
            border: 1px solid #ccc;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 1em;
            transition: border-color 0.2s;
        }
        #bm-script-filter { width: 300px; }
        #bm-script-filter:focus, input:focus { outline: none; border-color: var(--primary-blue); }
        ::placeholder { color: #666; opacity: 1; }

        .bm-toolbar-right { display: flex; align-items: center; gap: 20px; }
        .bm-actions { display: flex; gap: 15px; }

        #bm-refresh-btn, #bm-token-btn {
            font-size: 1.4em; cursor: pointer; color: var(--text-muted);
            transition: color 0.2s, transform 0.3s;
        }
        #bm-refresh-btn:hover, #bm-token-btn:hover { color: var(--text-main); transform: scale(1.15); }

        #bm-stats-bar { font-size: 0.9em; color: var(--text-muted); white-space: nowrap; }

        /* TABS */
        .bm-tabs {
            display: flex; flex-wrap: nowrap; width: 100%; gap: 2px;
            border-bottom: 1px solid var(--border-color); margin-bottom: 20px;
            overflow: hidden;
        }

        .bm-tab {
            flex: 1 1 0; min-width: 0; padding: 10px 5px;
            background: #333; color: #aaa; cursor: pointer;
            border-radius: 5px 5px 0 0; transition: flex-grow 0.2s ease, background-color 0.2s;
            font-weight: 500; text-align: center;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border: 1px solid #444; border-bottom: none;
        }
        .bm-tab:hover { flex-grow: 2; background: var(--bg-card); color: var(--text-main); z-index: 2; }

        .bm-tab.active {
            flex-grow: 3; background-color: var(--primary-blue) !important;
            color: white !important; font-weight: bold; z-index: 1;
            border-color: var(--primary-blue) !important; opacity: 1;
        }
        .bm-tab-update.active { background: var(--warning-color) !important; color: #333 !important; border-color: var(--warning-color) !important; }

        /* GRID & CARDS */
        .bm-category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; padding-bottom: 10px; }

        .script-button {
            padding: 15px; border-radius: 6px; cursor: pointer; position: relative;
            background: var(--bg-panel); text-align: center; min-height: 80px;
            display: flex; flex-direction: column; justify-content: center; align-items: center;
            transition: transform 0.2s, box-shadow 0.2s; border: 1px solid transparent;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .script-button:hover { transform: translateY(-3px); box-shadow: var(--shadow-soft); z-index: 10; }

        .script-button.install { border-color: var(--btn-secondary); color: var(--text-muted); }
        .script-button.install_pending { background: var(--pending-cyan); color: #000; border: none; }

        .script-button.active { background: var(--primary-blue); color: white; border: none; }
        .script-button.active strong { color: white; }

        .script-button.inactive { background: #343a40; color: #aaa; border: 1px solid var(--border-color); opacity: 0.9; }
        .script-button.update { background: linear-gradient(135deg, var(--warning-color), #e0a800); color: #222; animation: none; }
        .script-button.uninstall_pending { background: var(--danger-color); color: white; border: none; opacity: 0.9; }

        .script-button strong { display: block; font-size: 1.05em; margin-bottom: 5px; line-height: 1.3; }
        .version { font-size: 0.85em; opacity: 0.8; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 10px; }

        .bm-config-btn { position: absolute; bottom: 5px; right: 5px; font-size: 1.1em; opacity: 0.6; transition: opacity 0.2s; padding: 2px; }
        .bm-del-btn { position: absolute; top: 2px; right: 5px; font-size: 1.1em; opacity: 0.6; color: #fff; transition: opacity 0.2s; padding: 2px; font-weight: bold; }
        .bm-del-btn:hover { color: var(--text-main); transform: scale(1.3); opacity: 1; }
        .script-button:hover .bm-config-btn, .script-button:hover .bm-del-btn { opacity: 1; }

        /* FOOTER */
        #save-scripts-button { width: 100%; padding: 14px; margin-top: 15px; font-weight: bold; color: white; background-color: var(--primary-blue); border: none; border-radius: 6px; cursor: pointer; font-size: 1.1em; transition: background 0.2s; }
        #save-scripts-button:hover { background-color: var(--primary-blue-hover); }
        #save-scripts-button:disabled { background-color: var(--btn-secondary); cursor: not-allowed; }

        .bm-close-btn { position: absolute; top: 15px; right: 20px; font-size: 24px; cursor: pointer; color: var(--text-muted); transition: color 0.2s; }
        .bm-close-btn:hover { color: var(--text-main); }

        /* MODAL */
        .bm-modal-overlay { display: none; position: fixed; z-index: 10001; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.6); backdrop-filter: blur(4px); justify-content: center; align-items: center; }
        .bm-settings-content { background-color: var(--bg-dark); color: var(--text-main); padding: 25px; border-radius: 10px; border: 1px solid var(--border-color); width: 90%; max-width: 600px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
        .bm-settings-header { font-size: 1.4em; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; font-weight: 300; }
        .bm-settings-row { display: grid; grid-template-columns: 2fr 1fr; gap: 15px; align-items: center; margin-bottom: 15px; }

        .bm-settings-footer { margin-top: 25px; text-align: right; border-top: 1px solid var(--border-color); padding-top: 15px; }
        .bm-settings-footer button { padding: 10px 20px; border-radius: 5px; border: none; cursor: pointer; margin-left: 10px; font-weight: 500; color: white; }

        /* REPO MANAGER STYLES */
        .bm-repo-card { background: var(--bg-panel); padding: 15px; border-radius: 6px; margin-bottom: 10px; border-left: 4px solid var(--primary-blue); }
        .bm-repo-title { font-weight: bold; font-size: 1.1em; color: var(--text-main); }
        .bm-repo-item { display: flex; align-items: center; justify-content: space-between; background: var(--bg-card); padding: 10px; border-radius: 4px; margin-bottom: 8px; border: 1px solid var(--border-color); }
        .bm-repo-add-form { display: flex; gap: 10px; margin-top: 20px; }

        .bm-repo-del { background: var(--danger-color); border:none; padding: 5px 10px; border-radius: 4px; cursor: pointer; color:white; }

        .bm-loader { display: inline-block; border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid var(--primary-blue); border-radius: 50%; width: 20px; height: 20px; animation: bm-spin 0.8s linear infinite; margin-right: 10px; vertical-align: middle; }
        @keyframes bm-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        #b-m-scriptmanager-link.bm-update-highlight { background-color: var(--primary-blue) !important; color: white !important; border-radius: 4px; padding: 2px 6px; }
    `);

    // START
    window.BMScriptManager.initSystem();
})();
