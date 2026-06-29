// ==UserScript==
// @name         Reale Gebäudeliste (Next-Gen API-Version) + Gnadenlos + B&M Auth
// @namespace    http://tampermonkey.net/
// @version      2.4.5
// @description  Komplett datenbankgestützte, dynamische Gebäudeliste via Server-Schnittstelle. Inkl. Gnadenlos-Bauen & B&M Auth!
// @author       Masklin
// @match        https://*.leitstellenspiel.de/
// @match        https://tfn.tw/0
// @connect      tfn.tw
// @connect      *.leitstellenspiel.de
// @connect      www.leitstellenspiel.de
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @license      MIT
// ==/UserScript==

(async function() {
    'use strict';

    const isGameWindow = window.location.host.includes('leitstellenspiel.de');
    const isListWindow = window.location.host.includes('tfn.tw');

    const projectName = '🏢 Reale Gebäudeliste (v2.4.0)';
    const commandChannel = 'reale_liste_command';
    const progressChannel = 'reale_liste_progress';
    const apiUrl = 'https://tfn.tw/wachliste_api.php';

    // --- 2. CODE FÜR DAS SPIELFENSTER (TAB A) ---
    if (isGameWindow) {
        // --- DAU-SCHUTZ: B&M MANAGER CHECK (VIA LOCALSTORAGE) ---
        // LSS und Tampermonkey trennen GM_values zwischen Skripten. Daher lesen wir den localStorage.
        const rawBmCfg = localStorage.getItem("bm_access_cfg");
        let bmToken = "";
        if (rawBmCfg && rawBmCfg.includes('@')) {
            bmToken = rawBmCfg.split('@')[0]; // Schneidet alles nach dem @ ab
        }

        if (!bmToken || bmToken.trim() === "") {
            console.error("⛔ [Gebäudeliste] B&M Scriptmanager Token fehlt. Abbruch.");
            return; // Bricht das Skript ab, wenn kein Token da ist
        }

        // Speichere Token, User-ID und Name im skript-eigenen GM-Speicher für den Listen-Tab auf tfn.tw
        GM_setValue("reale_liste_api_token", bmToken);

        const lssUserId = typeof user_id !== 'undefined' ? user_id : "0";
        let lssPlayerName = "Unbekannt";
        if (typeof username !== 'undefined' && username !== "") lssPlayerName = username;
        GM_setValue("reale_liste_user_id", lssUserId);
        GM_setValue("reale_liste_user_name", lssPlayerName);

        function setupGameWindow() {
            const menuProfile = document.getElementById('menu_profile');
            if (!menuProfile || !menuProfile.nextElementSibling) {
                setTimeout(setupGameWindow, 1000);
                return;
            }
            const menuProfileUl = menuProfile.nextElementSibling;
            if (menuProfileUl.querySelector('.reale-liste-button')) return;

            const dividerForMenu = document.createElement('li');
            dividerForMenu.classList.add('divider', 'reale-liste-button');
            menuProfileUl.appendChild(dividerForMenu);

            const menuButton = document.createElement("li");
            menuButton.style = 'cursor: pointer;';
            menuButton.classList.add('reale-liste-button');

            const menuButtonA = document.createElement("a");
            menuButtonA.textContent = projectName;
            menuButtonA.onclick = function() {
                const w = Math.min(1200, window.screen.width * 0.7);
                const h = Math.min(900, window.screen.height * 0.8);
                window.open('https://tfn.tw/0', 'buildingListWindow', `width=${w},height=${h},resizable=yes`);
            };

            menuButton.appendChild(menuButtonA);
            menuProfileUl.appendChild(menuButton);

            document.body.addEventListener('click', function(e) {
                if (e.target && e.target.id === 'build_credits_0') {
                    const typeSelect = document.querySelector('#building_building_type');
                    if (!typeSelect) return;
                    const currentType = typeSelect.value;

                    const settings = {};
                    const lstSelect = document.querySelector('#building_leitstelle_building_id');
                    if (lstSelect) settings.lst = lstSelect.value;
                    const vehicleSelect = document.querySelector('select[name^="building[start_vehicle"]');

                    if (vehicleSelect) settings.vehicle = vehicleSelect.value;

                    GM_setValue('reale_liste_config_' + currentType, JSON.stringify(settings));
                }
            });
        }

        function createOrUpdateProgressOverlay(current, max, lastBuilding, successCount) {
            let overlay = document.getElementById('gnadenlos-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'gnadenlos-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 20px; left: 50%; transform: translateX(-50%);
                    background: rgba(30,30,30,0.95); border: 2px solid #dc3545; border-radius: 8px;
                    color: white; padding: 15px 25px;
                    z-index: 999999; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                    font-family: Arial, sans-serif; min-width: 320px; text-align: center;
                `;
                document.body.appendChild(overlay);
            }

            const pct = max > 0 ? Math.round((current / max) * 100) : 0;
            overlay.innerHTML = `
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 8px; color: #dc3545;">🔥 Gnadenlos-Bauen läuft...</div>
                <div style="font-size: 13px; margin-bottom: 8px;">Bearbeitet: <b>${current} / ${max}</b> (Erfolg: <span style="color:#28a745">${successCount}</span>)</div>
                <div style="width: 100%; background: #444; border-radius: 4px; height: 12px; margin-bottom: 8px; overflow: hidden;">
                  <div style="width: ${pct}%; background: #dc3545; height: 100%; transition: width 0.2s;"></div>
                </div>
                <div style="font-size: 11px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px;">Aktuell: ${lastBuilding}</div>
            `;
            GM_setValue(progressChannel, JSON.stringify({ current, max, successCount }));
        }

        GM_addValueChangeListener(commandChannel, (name, old_val, new_val, remote) => {
            if (!remote || !new_val) return;
            const cmd = JSON.parse(new_val);

            // 🔥 GNADENLOS BATCH WORKER
            if (cmd.action === 'gnadenlos_batch') {
                const isDebug = cmd.debug;
                const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

                if (!csrfToken && !isDebug) {
                    alert("Fehler: CSRF-Token nicht gefunden. Bitte Seite im Spiel neu laden.");
                    return;
                }

                const tasks = [...cmd.buildings];
                const total = tasks.length;
                let completed = 0;
                let processed = 0;

                const workerCount = 4;

                console.log(`\n=========================================`);
                if (isDebug) console.warn("🔥 GNADENLOS DEBUG MODUS AKTIV 🔥");
                console.log(`Starte ${isDebug ? 'SIMULIERTEN ' : ''}Bau von ${total} Wachen mit ${workerCount} Workern...`);
                console.log(`=========================================\n`);

                createOrUpdateProgressOverlay(0, total, "Initialisiere Worker...", 0);

                async function builderWorker(workerId) {
                    while (tasks.length > 0) {
                        const b = tasks.shift();
                        if (!b) break;

                        const suffix = ' (wip)';
                        let safeName = b.name;
                        if (safeName.length + suffix.length > 40) {
                            safeName = safeName.substring(0, 40 - suffix.length).trim();
                        }
                        const finalName = safeName + suffix;

                        const formData = new FormData();
                        formData.append('authenticity_token', csrfToken);
                        formData.append('building[name]', finalName);
                        formData.append('building[building_type]', b.type);
                        formData.append('building[latitude]', b.lat);
                        formData.append('building[longitude]', b.lon);

                        if (b.lst) formData.append('building[leitstelle_building_id]', b.lst);
                        if (b.vehicle) {
                            if (b.type === 0) {
                                formData.append('building[start_vehicle_feuerwache]', b.vehicle);
                            } else if (b.type === 18) {
                                formData.append('building[start_vehicle_feuerwache_kleinwache]', b.vehicle);
                            } else {
                                formData.append('building[start_vehicle]', b.vehicle);
                            }
                        }

                        if (isDebug) {
                            console.log(`[WORKER ${workerId} | SIMULATION] 🏗️ ${finalName}`);
                            completed++;
                            await new Promise(res => setTimeout(res, 100));
                        } else {
                            let maxRetries = 3;
                            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                                try {
                                    if (attempt > 0) {
                                        console.warn(`[WORKER ${workerId}] ⚠️ RETRY ${attempt}/${maxRetries} für ${finalName}`);
                                        await new Promise(res => setTimeout(res, 2000 * attempt));
                                    }

                                    const controller = new AbortController();
                                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                                    const response = await fetch('/buildings', {
                                        method: 'POST',
                                        body: formData,
                                        headers: { 'X-CSRF-Token': csrfToken },
                                        signal: controller.signal
                                    });

                                    clearTimeout(timeoutId);
                                    if (response.ok) {
                                        completed++;
                                        await new Promise(res => setTimeout(res, 250));
                                        break;
                                    } else {
                                        console.error(`[WORKER ${workerId}] ❌ FEHLER HTTP ${response.status} bei ${finalName}`);
                                        if (attempt === maxRetries) console.error(`🛑 AUFGEGEBEN: ${finalName}`);
                                    }
                                } catch (e) {
                                    console.error(`[WORKER ${workerId}] ❌ TIMEOUT/NETZWERK bei ${finalName}`);
                                    if (attempt < maxRetries) await new Promise(res => setTimeout(res, 1000));
                                }
                            }
                        }
                        processed++;
                        createOrUpdateProgressOverlay(processed, total, finalName, completed);
                    }
                }

                const workers = [];
                for (let i = 0; i < Math.min(workerCount, total); i++) {
                    workers.push(new Promise(async (resolve) => {
                        await new Promise(r => setTimeout(r, i * 200));
                        await builderWorker(i + 1);
                        resolve();
                    }));
                }

                Promise.all(workers).then(() => {
                    const finalMsg = `🏁 Fertig! Lade Spiel neu...`;
                    createOrUpdateProgressOverlay(total, total, finalMsg, completed);
                    console.log(`\n${finalMsg} (${completed} von ${total} bearbeitet).`);

                    setTimeout(() => GM_setValue(progressChannel, ''), 2000);
                    setTimeout(() => {
                        if (!isDebug) window.location.reload();
                    }, 1000);
                });
                return;
            }

            if (cmd.action === 'setView' && typeof map !== 'undefined') {
                map.invalidateSize();
                map.setView([cmd.lat, cmd.lon], 17);
            } else if (cmd.action === 'place') {
                document.querySelector('#build_new_building')?.click();
                if (typeof map !== 'undefined') {
                    map.invalidateSize();
                    map.setView([cmd.lat, cmd.lon], 17);
                }

                let attempts = 0;
                let phase = 1;
                const interval = setInterval(() => {
                    if (++attempts > 100) clearInterval(interval);

                    if (phase === 1) {
                        const nameInp = document.querySelector('#building_name');
                        const typSel = document.querySelector('#building_building_type');
                        if (nameInp && typSel) {
                            nameInp.value = cmd.name;
                            typSel.value = cmd.type;
                            typSel.dispatchEvent(new Event('change', { 'bubbles': true }));
                            phase = 2;
                        }
                    } else if (phase === 2) {
                        const saved = GM_getValue('reale_liste_config_' + cmd.type);
                        if (!saved) { clearInterval(interval); return; }
                        const config = JSON.parse(saved);
                        const lstSel = document.querySelector('#building_leitstelle_building_id');
                        const vehSel = document.querySelector('select[name^="building[start_vehicle"]');
                        if (config.vehicle && !vehSel) return;
                        if (lstSel && config.lst) lstSel.value = config.lst;
                        if (vehSel && config.vehicle) vehSel.value = config.vehicle;
                        clearInterval(interval);
                    }
                }, 100);
            }
        });

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupGameWindow);
        else setupGameWindow();
    }


    // --- 3. CODE FÜR DAS LISTENFENSTER (TAB B auf tfn.tw/0) ---
    else if (isListWindow) {
        console.log(`${projectName}: Neues Listen-Fenster initialisiert.`);
        let playerWachen = [];
        let serverWachenResult = [];
        let hideExisting = false;
        let lstMap = { bau: null, thw: null, bpol: null };
        let activeFilters = { bundesland: 'all', kreis: 'all', organisation: 'all', wachenart: 'all', term: '', plz: '' };

        function createUI() {
            const style = document.createElement('style');
            style.textContent = `
                body { margin: 0; font-family: sans-serif; background-color: #2b2b2b; color: #e0e0e0; overflow: hidden; }
                .wrapper { display: flex; flex-direction: column; height: 100vh; }
                .header { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: #3c3c3c; border-bottom: 1px solid #444; }
                .filter-bar { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 15px; background: #3c3c3c; border-bottom: 1px solid #444; align-items: center; }
                select, input[type="text"] { padding: 6px; border-radius: 4px; border: 1px solid #666; background: #444; color: #e0e0e0; min-width: 160px; }
                input[type="text"] { flex: 1; }
                .btn { padding: 6px 12px; background: #555; color: white; border: 1px solid #666; border-radius: 4px; cursor: pointer; transition: all 0.2s; }
                .btn.active { background: #0d6efd; border-color: #0d6efd; }
                .btn-search { background: #28a745; border-color: #28a745; font-weight: bold; }
                .wachen-container { flex: 1; overflow-y: auto; padding: 5px 0; }
                .wache-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; padding: 10px 15px; border-bottom: 1px solid #444; gap: 15px; }
                .wache-row:nth-child(even) { background-color: #333; }
                .info-sub { font-size: 0.85em; color: #aaa; margin-top: 2px; }
                .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; color: white; font-weight: bold; }
                .badge.have { background: #28a745; }
                .badge.miss { background: #dc3545; }
                .action-btn { padding: 4px 10px; border-radius: 4px; border: 1px solid; cursor: pointer; font-size: 12px; background: transparent; }
                .btn-go { color: #58a6ff; border-color: #58a6ff; }
                .btn-build { color: #f0ad4e; border-color: #f0ad4e; }
                .loading { padding: 30px; text-align: center; color: #aaa; font-size: 1.2em; }
            `;
            document.head.appendChild(style);

            const view = document.createElement('div');
            view.className = 'wrapper';
            view.innerHTML = `
                <div class="header">
                    <div style="display: flex; align-items: baseline; gap: 15px;">
                        <h3 style="margin:0">${projectName}</h3>
                        <span id="status-counter" style="color: #28a745; font-size: 0.9em; font-weight: bold;">Verbinde zur Datenbank...</span>
                        <span id="lst-status" style="color: #f0ad4e; font-size: 0.85em; margin-left: 10px; cursor: help;" title="Die LST IDs aus dem Spiel">Suche LST...</span>
                    </div>
                    <button class="btn" onclick="window.close()">×</button>
                </div>
                <div class="filter-bar">
                    <select id="sel-bundesland"><option value="all">Alle Bundesländer</option></select>
                    <select id="sel-kreis"><option value="all">Alle Kreise</option></select>
                    <select id="sel-orga"><option value="all">Alle Organisationen</option></select>
                    <select id="sel-wachenart"><option value="all">Alle Wachenarten</option></select>
                </div>
                <div class="filter-bar">
                    <input type="text" id="inp-search" placeholder="Suche nach Name (Wildcard)...">
                    <input type="text" id="inp-plz" placeholder="PLZ..." style="max-width: 100px;">
                    <button id="btn-toggle-existing" class="btn">Nur Fehlende</button>
                    <button id="btn-submit-search" class="btn btn-search">🔍 Wachen laden</button>

                    <div style="margin-left: auto; display: flex; align-items: center; gap: 10px;">
                        <label style="cursor: pointer; font-size: 0.9em; color: #ffc107;" title="Öffne F12 Konsole für Details!">
                            <input type="checkbox" id="chk-debug" checked> <b>Debug (Nur Loggen)</b>
                        </label>
                        <button id="btn-gnadenlos" class="btn" style="background: #dc3545; border-color: #dc3545; font-weight: bold;">🔥 Gnadenlos Bauen</button>
                    </div>
                </div>
                <div id="wachen-target" class="wachen-container">
                    <div class="loading">Bitte Filter wählen und auf "Wachen laden" klicken.</div>
                </div>
            `;
            document.body.appendChild(view);
        }

        // --- DIE ABGESICHERTE API ANFRAGE (mit echtem Fehler-Handling) ---
        function queryAPI(action, params, callback) {
            let url = `${apiUrl}?action=${action}`;
            for (let k in params) {
                if (params[k] !== 'all' && params[k] !== '') url += `&${k}=${encodeURIComponent(params[k])}`;
            }

            // Werte aus dem lokalen Speicher holen
            const activeToken = GM_getValue("reale_liste_api_token", "");
            const lssUserId = GM_getValue("reale_liste_user_id", "0");
            const lssPlayerName = GM_getValue("reale_liste_user_name", "Unbekannt");

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: {
                    "X-API-Token": activeToken,
                    "X-LSS-User-ID": lssUserId,
                    "X-Player-Name": lssPlayerName
                },
                onload: (res) => {
                    try {
                        // Wenn der Status NICHT 200 (OK) ist, liegt ein Fehler vor!
                        if (res.status !== 200) {
                            let errorText = "Unbekannter Fehler";
                            try { errorText = JSON.parse(res.responseText).error; } catch(e) { errorText = res.responseText; }

                            console.error(`[API Fehler ${res.status}]`, errorText);
                            alert(`Server meldet Fehler (${res.status}):\n${errorText}`);

                            const target = document.getElementById('wachen-target');
                            if (target) target.innerHTML = `<div class="loading" style="color:#dc3545;">⛔ ${errorText}</div>`;

                            const counter = document.getElementById('status-counter');
                            if (counter) { counter.textContent = `Fehler ${res.status}`; counter.style.color = "#dc3545"; }
                            return;
                        }

                        callback(JSON.parse(res.responseText));
                    } catch(e) {
                        console.error("API-Error im JavaScript:", e);
                    }
                },
                onerror: (err) => {
                    console.error("Netzwerkfehler:", err);
                    alert("Kritischer Netzwerkfehler: Konnte tfn.tw nicht erreichen!");
                }
            });
        }
        function loadFilters() {
            queryAPI('init_filters', {}, (data) => {
                if (!data) return; // Falls Auth fehlgeschlagen ist
                setupDropdown('sel-bundesland', data.bundeslaender, 'Alle Bundesländer');
                setupDropdown('sel-kreis', data.kreise, 'Alle Kreise');
                setupDropdown('sel-orga', data.organisationen, 'Alle Organisationen');
                setupDropdown('sel-wachenart', data.wachenarten, 'Alle Wachenarten');
                const counterEl = document.getElementById('status-counter');
                if (counterEl && data.total_wachen) {
                    counterEl.textContent = `${data.total_wachen} Wachen in Datenbank verfügbar`;
                    counterEl.style.color = '#aaa';
                }
            });
        }

        function setupDropdown(id, list, defaultText) {
            const el = document.getElementById(id);
            if (!el || !list) return;
            el.innerHTML = `<option value="all">${defaultText}</option>`;
            list.forEach(val => { if(val) el.innerHTML += `<option value="${val}">${val}</option>`; });
        }

        function loadWachenFromServer() {
            const target = document.getElementById('wachen-target');
            target.innerHTML = `<div class="loading">Frage Datenbank ab...</div>`;
            queryAPI('search', activeFilters, (data) => {
                if (!data) return;
                serverWachenResult = data;
                renderList();
            });
        }

        function renderList() {
            const target = document.getElementById('wachen-target');
            target.innerHTML = '';
            let list = serverWachenResult;
            if (hideExisting) list = list.filter(w => !checkIfOwned(w));

            const counterEl = document.getElementById('status-counter');
            if (counterEl) {
                counterEl.textContent = `Zeige ${list.length} Treffer an`;
                counterEl.style.color = list.length === 0 ? '#dc3545' : '#58a6ff';
            }

            if (list.length === 0) {
                target.innerHTML = `<div class="loading">Keine Einträge für diese Filterkombination gefunden.</div>`;
                return;
            }

            list.forEach(w => {
                const owned = checkIfOwned(w);
                const row = document.createElement('div');
                row.className = 'wache-row';
                row.innerHTML = `
                    <div>
                        <strong>${w.name}</strong>
                        <div class="info-sub">${w.organisation} | ${w.wachenart} | ${w.plz} ${w.ort}</div>
                    </div>
                    <span class="badge ${owned ? 'have' : 'miss'}">${owned ? 'Vorhanden' : 'Fehlt'}</span>
                    <button class="action-btn ${owned ? 'btn-go' : 'btn-build'}">${owned ? 'Auf Karte' : 'Platzieren'}</button>
                `;
                row.querySelector('button').addEventListener('click', () => {
                    const msg = owned ?
                        { action: 'setView', lat: owned.latitude, lon: owned.longitude } :
                        { action: 'place', lat: w.lat, lon: w.lon, name: w.name, type: getGameTypeId(w) };
                    GM_setValue(commandChannel, JSON.stringify(msg));
                });
                target.appendChild(row);
            });
        }

        function checkIfOwned(realWache) {
            const latTol = 0.0027, lonTol = 0.0043;
            const rLat = parseFloat(realWache.lat), rLon = parseFloat(realWache.lon);

            // 1. Hole die Ziel-Typ-ID der realen Wache über die bestehende Funktion
            const targetBuildingType = getGameTypeId(realWache);

            return playerWachen.find(pw =>
                // 2. Prüfe die Koordinaten...
                pw.latitude <= rLat + latTol && pw.latitude >= rLat - latTol &&
                pw.longitude <= rLon + lonTol && pw.longitude >= rLon - lonTol &&
                // 3. ...UND prüfe, ob der Gebäudetyp übereinstimmt!
                pw.building_type === targetBuildingType
            );
        }

        function getGameTypeId(wache) {
            if (wache.organisation === 'Feuerwehr') {
                if (wache.wachenart === 'Feuerwehrschule') return 1;
                if (['NA', 'RW'].includes(wache.wachenart)) return 2;
                return 0;
            }
            if (wache.organisation === 'Rettungsdienst') return 2;
            if (wache.organisation === 'THW') return 9;
            if (wache.organisation === 'Polizei') {
                if (['BEPOL', 'BPOL', 'Bereitschaftspolizei'].includes(wache.wachenart)) return 11;
                if (wache.wachenart === 'Polizeihubschrauberstation') return 13;
                if (wache.wachenart === 'Polizei-Sondereinheiten') return 17;
                return 6;
            }
            if (wache.organisation === 'SEG/KatS') {
                if (wache.wachenart === 'THW') return 9;
                if (wache.wachenart === 'SAR') return 28;
                if (wache.wachenart === 'RW') return 2;
                const nameCheck = (wache.name || '').toUpperCase();
                if (nameCheck.startsWith('DRK') || nameCheck.startsWith('MHD') || nameCheck.startsWith('ASB') || nameCheck.startsWith('JUH')) return 12;
                if (nameCheck.startsWith('DGZRS')) return 26;
                if (nameCheck.startsWith('DLRG')) return 15;
                return 12;
            }
            return 0;
        }

        function init() {
            createUI();
            loadFilters();

            GM_addValueChangeListener(progressChannel, (name, old_val, new_val, remote) => {
                if (!new_val) return;
                const p = JSON.parse(new_val);
                const btn = document.getElementById('btn-gnadenlos');
                if (btn) {
                    if (p.current < p.max) {
                        btn.disabled = true;
                        btn.innerHTML = `⏳ ${p.current} / ${p.max} (${p.successCount} ✅)`;
                        btn.style.background = '#ffc107';
                        btn.style.borderColor = '#ffc107';
                        btn.style.color = '#000';
                    } else {
                        btn.disabled = false;
                        btn.innerHTML = `🔥 Gnadenlos Bauen`;
                        btn.style.background = '#dc3545';
                        btn.style.borderColor = '#dc3545';
                        btn.style.color = '#fff';

                        setTimeout(() => {
                            if (serverWachenResult.length > 0) loadWachenFromServer();
                        }, 1500);
                    }
                }
            });

            document.getElementById('sel-bundesland').addEventListener('change', (e) => {
                activeFilters.bundesland = e.target.value;
                activeFilters.kreis = 'all';
                const kreisDropdown = document.getElementById('sel-kreis');
                kreisDropdown.innerHTML = `<option value="all">Lade Kreise...</option>`;
                kreisDropdown.disabled = true;
                queryAPI('get_kreise', { bundesland: activeFilters.bundesland }, (data) => {
                    if (data) {
                        setupDropdown('sel-kreis', data, 'Alle Kreise');
                        kreisDropdown.disabled = false;
                    }
                });
            });

            document.getElementById('sel-kreis').addEventListener('change', (e) => activeFilters.kreis = e.target.value);
            document.getElementById('sel-orga').addEventListener('change', (e) => {
                activeFilters.organisation = e.target.value;
                activeFilters.wachenart = 'all';
                const artDropdown = document.getElementById('sel-wachenart');
                artDropdown.innerHTML = `<option value="all">Lade Wachenarten...</option>`;
                artDropdown.disabled = true;
                queryAPI('get_wachenarten', { organisation: activeFilters.organisation }, (data) => {
                    if (data) {
                        setupDropdown('sel-wachenart', data, 'Alle Wachenarten');
                        artDropdown.disabled = false;
                    }
                });
            });

            document.getElementById('sel-wachenart').addEventListener('change', (e) => activeFilters.wachenart = e.target.value);
            document.getElementById('inp-search').addEventListener('input', (e) => activeFilters.term = e.target.value);
            document.getElementById('inp-plz').addEventListener('input', (e) => activeFilters.plz = e.target.value);
            document.getElementById('btn-submit-search').addEventListener('click', loadWachenFromServer);

            const triggerSearchOnEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); loadWachenFromServer(); } };
            document.getElementById('inp-search').addEventListener('keydown', triggerSearchOnEnter);
            document.getElementById('inp-plz').addEventListener('keydown', triggerSearchOnEnter);

            document.getElementById('btn-toggle-existing').addEventListener('click', (e) => {
                hideExisting = !hideExisting;
                e.target.classList.toggle('active');
                renderList();
            });

            // 🔥 Gnadenlos-Bauen Listener
            document.getElementById('btn-gnadenlos').addEventListener('click', () => {
                const missingWachen = serverWachenResult.filter(w => !checkIfOwned(w));
                const isDebug = document.getElementById('chk-debug').checked;

                if (missingWachen.length === 0) {
                    alert("Es gibt keine fehlenden Wachen in der aktuellen Liste!");
                    return;
                }

                if (!confirm(`Bist du sicher, dass du ${missingWachen.length} Wachen GNADENLOS an den Server schicken willst?\n${isDebug ? '(DEBUG MODUS - Prüfe die Konsole in beiden Tabs)' : 'Achtung: Dies kostet Credits/Coins!'}`)) {
                    return;
                }

                const payload = missingWachen.map(w => {
                    let gameType = getGameTypeId(w);
                    let targetLst = lstMap.bau;
                    let lstReason = "Fallback Leitstelle Bau";

                    if (gameType === 9) {
                        targetLst = lstMap.thw || lstMap.bau;
                        lstReason = lstMap.thw ? "Leitstelle Bau THW" : "Fallback Bau (THW LST fehlt)";
                    } else if (gameType === 11) {
                        targetLst = lstMap.bpol || lstMap.bau;
                        lstReason = lstMap.bpol ? "Leitstelle Bau BPOL" : "Fallback Bau (BPOL LST fehlt)";
                    }

                    let startVeh = null;
                    if (gameType === 0) startVeh = 30;

                    return {
                        name: w.name,
                        lat: w.lat,
                        lon: w.lon,
                        type: gameType,
                        lst: targetLst,
                        vehicle: startVeh,
                        lstReason: lstReason
                    };
                });

                GM_setValue(commandChannel, JSON.stringify({ action: 'gnadenlos_batch', buildings: payload, debug: isDebug }));
            });

            // LSS-Wachen laden & Leitstellen identifizieren
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://www.leitstellenspiel.de/api/buildings",
                onload: (res) => {
                    try {
                        playerWachen = JSON.parse(res.responseText);
                        console.log(`${projectName}: LSS-Wachen geladen.`);

                        playerWachen.forEach(w => {
                            if (w.building_type === 7) {
                                const n = (w.caption || '').toLowerCase();
                                if (n.includes("thw") && n.includes("bau")) {
                                    lstMap.thw = w.id;
                                } else if ((n.includes("bpol") || n.includes("bepol") || n.includes("bereitschafts")) && n.includes("bau")) {
                                    lstMap.bpol = w.id;
                                } else if (n.includes("bau")) {
                                    if (!n.includes("thw") && !n.includes("bpol") && !n.includes("bepol")) {
                                        lstMap.bau = w.id;
                                    }
                                }
                            }
                        });
                        const lstUI = document.getElementById('lst-status');
                        lstUI.textContent = `LST gefunden: Bau(${lstMap.bau || '✖'}) THW(${lstMap.thw || '✖'}) BPOL(${lstMap.bpol || '✖'})`;
                        lstUI.title = `IDs:\nBau: ${lstMap.bau}\nTHW: ${lstMap.thw}\nBPOL: ${lstMap.bpol}`;
                        lstUI.style.color = lstMap.bau ? '#28a745' : '#dc3545';
                        console.log("Erkannte Bau-Leitstellen:", lstMap);
                        if (serverWachenResult.length > 0) renderList();
                    } catch(err) {
                        console.error("Konnte LSS-Wachen nicht lesen", err);
                    }
                }
            });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }
})();
