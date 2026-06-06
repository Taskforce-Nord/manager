// ==UserScript==
// @name         Reale Gebäudeliste (Next-Gen API-Version)
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  Komplett datenbankgestützte, dynamische Gebäudeliste via Server-Schnittstelle.
// @author       Whice + Masklin (Modifiziert von Gemini)
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

    // --- 1. Globale Konfiguration & Erkennung ---
    const isGameWindow = window.location.host.includes('leitstellenspiel.de');
    const isListWindow = window.location.host.includes('tfn.tw');

    const projectName = '🏢 Reale Gebäudeliste (v2.2)';
    const commandChannel = 'reale_liste_command';

    // API URL
    const apiUrl = 'https://tfn.tw/wachliste_api.php';

    // --- 2. CODE FÜR DAS SPIELFENSTER (TAB A) ---
    if (isGameWindow) {
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
                // Öffnet jetzt tfn.tw/0
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

        GM_addValueChangeListener(commandChannel, (name, old_val, new_val, remote) => {
            if (!remote || !new_val) return;
            const cmd = JSON.parse(new_val);

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

        // Filterstatus inkl. PLZ
        let activeFilters = { bundesland: 'all', kreis: 'all', organisation: 'all', wachenart: 'all', term: '', plz: '' };

        function createUI() {
            const style = document.createElement('style');
            style.textContent = `
                body { margin: 0; font-family: sans-serif; background-color: #2b2b2b; color: #e0e0e0; overflow: hidden; }
                .wrapper { display: flex; flex-direction: column; height: 100vh; }
                .header { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: #3c3c3c; border-bottom: 1px solid #444; }
                .filter-bar { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 15px; background: #3c3c3c; border-bottom: 1px solid #444; align-items: center; }
                select, input { padding: 6px; border-radius: 4px; border: 1px solid #666; background: #444; color: #e0e0e0; min-width: 160px; }
                input { flex: 1; }
                .btn { padding: 6px 12px; background: #555; color: white; border: 1px solid #666; border-radius: 4px; cursor: pointer; }
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
                </div>
                <div id="wachen-target" class="wachen-container">
                    <div class="loading">Bitte Filter wählen und auf "Wachen laden" klicken.</div>
                </div>
            `;
            document.body.appendChild(view);
        }

        function queryAPI(action, params, callback) {
            let url = `${apiUrl}?action=${action}`;
            for (let k in params) {
                if (params[k] !== 'all' && params[k] !== '') {
                    url += `&${k}=${encodeURIComponent(params[k])}`;
                }
            }
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: (res) => {
                    try { callback(JSON.parse(res.responseText)); }
                    catch(e) { console.error("API-Error", e, res.responseText); }
                }
            });
        }

        function loadFilters() {
            queryAPI('init_filters', {}, (data) => {
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
                serverWachenResult = data;
                renderList();
            });
        }

        function renderList() {
            const target = document.getElementById('wachen-target');
            target.innerHTML = '';

            let list = serverWachenResult;
            if (hideExisting) {
                list = list.filter(w => !checkIfOwned(w));
            }

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

            return playerWachen.find(pw =>
                pw.latitude <= rLat + latTol && pw.latitude >= rLat - latTol &&
                pw.longitude <= rLon + lonTol && pw.longitude >= rLon - lonTol
            );
        }

        function getGameTypeId(wache) {
            // --- 1. Feuerwehr ---
            if (wache.organisation === 'Feuerwehr') {
                if (wache.wachenart === 'Feuerwehrschule') return 1;
                if (['NA', 'RW'].includes(wache.wachenart)) return 2; // Notarzt/Rettungswache an Feuerwachen
                return 0; // Fallback: Normale Feuerwache
            }

            // --- 2. Rettungsdienst & THW (Standard) ---
            if (wache.organisation === 'Rettungsdienst') return 2;
            if (wache.organisation === 'THW') return 9;

            // --- 3. Polizei ---
            if (wache.organisation === 'Polizei') {
                if (['BEPOL', 'BPOL', 'Bereitschaftspolizei'].includes(wache.wachenart)) return 11;
                if (wache.wachenart === 'Polizeihubschrauberstation') return 13;
                if (wache.wachenart === 'Polizei-Sondereinheiten') return 17;
                return 6; // Fallback: Normale Polizeiwache
            }

            // --- 4. SEG / Katastrophenschutz ---
            if (wache.organisation === 'SEG/KatS') {
                if (wache.wachenart === 'THW') return 9;
                if (wache.wachenart === 'SAR') return 28; // Seenothubschrauberstation
                if (wache.wachenart === 'RW') return 2;   // Rettungswache

                const nameCheck = (wache.name || '').toUpperCase();
                if (nameCheck.startsWith('DRK') || nameCheck.startsWith('MHD') || nameCheck.startsWith('ASB') || nameCheck.startsWith('JUH')) return 12; // Schnelleinsatzgruppe
                if (nameCheck.startsWith('DGZRS')) return 26; // Seenotrettung
                if (nameCheck.startsWith('DLRG')) return 15; // Wasserrettung

                return 12; // Fallback
            }

            // --- 5. Globaler Notfall-Fallback ---
            return 0;
        }

        async function init() {
            createUI();

            // NEU: Wir fragen DEINE Datenbank sofort ab, ohne zu warten!
            loadFilters();

            // LSS-Wachen laden (das ist der Teil, der die Sekunden frisst)
            try {
                playerWachen = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: "https://www.leitstellenspiel.de/api/buildings",
                        onload: (res) => {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch(err) { reject(err); }
                        },
                        onerror: (err) => reject(err)
                    });
                });
            } catch(e) { console.error("Konnte LSS-Wachen nicht lesen", e); }

            loadFilters();

            // Kaskaden-Dropdown: Bundesland -> Kreise
            document.getElementById('sel-bundesland').addEventListener('change', (e) => {
                activeFilters.bundesland = e.target.value;
                activeFilters.kreis = 'all';

                const kreisDropdown = document.getElementById('sel-kreis');
                kreisDropdown.innerHTML = `<option value="all">Lade Kreise...</option>`;
                kreisDropdown.disabled = true;

                queryAPI('get_kreise', { bundesland: activeFilters.bundesland }, (data) => {
                    setupDropdown('sel-kreis', data, 'Alle Kreise');
                    kreisDropdown.disabled = false;
                });
            });

            document.getElementById('sel-kreis').addEventListener('change', (e) => activeFilters.kreis = e.target.value);

            // Kaskaden-Dropdown: Organisation -> Wachenarten
            document.getElementById('sel-orga').addEventListener('change', (e) => {
                activeFilters.organisation = e.target.value;
                activeFilters.wachenart = 'all';

                const artDropdown = document.getElementById('sel-wachenart');
                artDropdown.innerHTML = `<option value="all">Lade Wachenarten...</option>`;
                artDropdown.disabled = true;

                queryAPI('get_wachenarten', { organisation: activeFilters.organisation }, (data) => {
                    setupDropdown('sel-wachenart', data, 'Alle Wachenarten');
                    artDropdown.disabled = false;
                });
            });

            document.getElementById('sel-wachenart').addEventListener('change', (e) => activeFilters.wachenart = e.target.value);

            // Suchfelder updaten
            document.getElementById('inp-search').addEventListener('input', (e) => activeFilters.term = e.target.value);
            document.getElementById('inp-plz').addEventListener('input', (e) => activeFilters.plz = e.target.value);

            // Manuelle Suche via Button
            document.getElementById('btn-submit-search').addEventListener('click', loadWachenFromServer);

            // Suche via Enter-Taste in den Textfeldern
            const triggerSearchOnEnter = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    loadWachenFromServer();
                }
            };
            document.getElementById('inp-search').addEventListener('keydown', triggerSearchOnEnter);
            document.getElementById('inp-plz').addEventListener('keydown', triggerSearchOnEnter);

            // Existierende ausblenden
            document.getElementById('btn-toggle-existing').addEventListener('click', (e) => {
                hideExisting = !hideExisting;
                e.target.classList.toggle('active');
                renderList();
            });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }
})();
