// ==UserScript==
// @name         Reale Gebäudeliste (Multi-Window-Version)
// @namespace    http://tampermonkey.net/
// @version      1.3.5
// @description  Zeigt eine Liste von realen Gebäuden in einem separaten Fenster an und interagiert mit dem Haupt-Tab.
// @author       Whice + Masklin (Modifiziert von Gemini)
// @match        https://*.leitstellenspiel.de/
// @match        https://bosmap.de/liste.html
// @connect      bosmap.de
// @connect      *.leitstellenspiel.de
// @connect      www.leitstellenspiel.de
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @license      MIT
// ==/UserScript==

(async function() {
    'use strict';

    // --- 1. Globale Modus-Erkennung & Definitionen ---
    const isGameWindow = window.location.host.includes('leitstellenspiel.de');
    const isListWindow = window.location.host.includes('bosmap.de');

    const projectName = '🏢 Reale Gebäudeliste';
    const commandChannel = 'reale_liste_command';

    // Definition der Gebäudetypen
    const building_type = {
        0: 'Feuerwache', 1: 'Feuerwehrschule', 2: 'Rettungswache', 3: 'Rettungsschule', 4: 'Krankenhaus',
        5: 'Rettungshubschrauber-Station', 6: 'Polizeiwache', 7: 'Leitstelle', 8: 'Polizeischule', 9: 'THW',
        10: 'THW Bundesschule', 11: 'Bereitschaftspolizei', 12: 'Schnelleinsatzgruppe (SEG)', 13: 'Polizeihubschrauberstation',
        14: 'Bereitstellungsraum', 15: 'Wasserrettung', 17: 'Polizei-Sondereinheiten', 18: 'Feuerwache (Kleinwache)',
        19: 'Polizeiwache (Kleinwache)', 20: 'Rettungswache (Kleinwache)', 21: 'Rettungshundestaffel', 24: 'Reiterstaffel',
        25: 'Bergrettungswache', 26: 'Seenotrettungswache', 27: 'Schule für Seefahrt und Seenotrettung', 28: 'Hubschrauberstation (Seenotrettung)'
    };


    // --- 2. Code-Block NUR für das SPIELFENSTER (Tab A) ---
    if (isGameWindow) {

        function setupGameWindow() {
            const menuProfile = document.getElementById('menu_profile');
            if (!menuProfile || !menuProfile.nextElementSibling) {
                console.error(`${projectName}: Menü-Eintrag 'menu_profile' nicht gefunden. Warte...`);
                setTimeout(setupGameWindow, 1000);
                return;
            }
            const menuProfileUl = menuProfile.nextElementSibling;

            if (menuProfileUl.querySelector('.reale-liste-button')) return;

            const dividerForMenu = document.createElement('li');
            dividerForMenu.classList.add('divider', 'reale-liste-button');
            dividerForMenu.role = 'presentation';
            menuProfileUl.appendChild(dividerForMenu);

            const menuProfileAddMenuButton = document.createElement("li");
            menuProfileAddMenuButton.style = 'cursor: pointer;';
            menuProfileAddMenuButton.classList.add('reale-liste-button');

            const menuProfileAddMenuButtonA = document.createElement("a");
            menuProfileAddMenuButtonA.classList.add('project-name');
            menuProfileAddMenuButtonA.textContent = projectName;

            // Öffnet ein neues, zentriertes Fenster
            menuProfileAddMenuButtonA.onclick = function() {
                const w = Math.min(1200, window.screen.width * 0.7);
                const h = Math.min(900, window.screen.height * 0.8);
                const left = (window.screen.width - w) / 2;
                const top = (window.screen.height - h) / 2;
                const features = `width=${w},height=${h},left=${left},top=${top},resizable=yes`;
                window.open('https://bosmap.de/liste.html', 'buildingListWindow', features);
            };

            menuProfileAddMenuButton.appendChild(menuProfileAddMenuButtonA);
            menuProfileUl.appendChild(menuProfileAddMenuButton);
        }

        function handleListCommand(cmd) {
            if (!cmd || typeof map === 'undefined') return;
            console.log(`${projectName}: Befehl empfangen:`, cmd);

            if (cmd.action === 'setView') {
                if (typeof map !== 'undefined' && map.setView) {
                    map.invalidateSize();
                    map.setView([cmd.lat, cmd.lon], 17);
                }
            } else if (cmd.action === 'place') {
                document.querySelector('#build_new_building')?.click();
                 if (typeof map !== 'undefined' && map.setView) {
                    map.invalidateSize();
                    map.setView([cmd.lat, cmd.lon], 17);
                }

                setTimeout(() => {
                    const nameInput = document.querySelector('#building_name');
                    const typSelect = document.querySelector('#building_building_type');

                    if (nameInput) {
                        nameInput.value = cmd.name;
                    }
                    if (typSelect) {
                        typSelect.value = cmd.type;
                        const changeEvent = new Event('change', {
                            'bubbles': true,
                            'cancelable': true
                        });
                        typSelect.dispatchEvent(changeEvent);
                        console.log(`${projectName}: 'change'-Event für Gebäudetyp ausgelöst.`);
                    }
                }, 500);
            }
        }

        // Startlogik für Tab A
        GM_addValueChangeListener(commandChannel, (name, old_value, new_value, remote) => {
            if (remote && new_value) {
                handleListCommand(JSON.parse(new_value));
            }
        });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupGameWindow);
        } else {
            setupGameWindow();
        }

    }
    // --- ENDE Code-Block Spiel-Fenster ---


    // --- 3. Code-Block NUR für das LISTENFENSTER (Tab B) ---
    else if (isListWindow) {

        console.log(`${projectName}: Listen-Fenster (Tab B) initialisiert.`);

        const wachenlisteBaseUrl = 'https://bosmap.de/export.php';
        let wachen = [];
        let playerWachen = [];
        let dataLoaded = false;

        // Globale Filter-Variablen
        let bundeslandFilter = 'all';
        let regionFilter = 'all'; // Kreis
        let stadtFilter = 'all'; // Ort
        let wachenFilter = -1;

        function createBuildingMenu() {
            console.log(`${projectName}: createBuildingMenu() wird ausgeführt...`);
            const buildingMenuList = document.createElement('div');
            const styleElement = document.createElement('style');

            // --- KORREKTUR HIER: Dark Mode CSS ---
            let css = `
            body {
                margin: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                background-color: #2b2b2b; /* Dunkler Hintergrund für die Seite */
                color: #e0e0e0; /* Helle Schriftfarbe */
            }
            .building-menu {
                display: flex; flex-direction: column; width: 100%; max-width: none;
                height: 100vh; background: #2b2b2b; /* Menü-Hintergrund */
                position: static; z-index: 1;
                border-radius: 0; overflow: hidden;
            }
            .menu-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 15px; background: #3c3c3c; /* Dunklerer Header */
                border-bottom: 1px solid #444;
            }
            .close-btn {
                background: none; border: none; font-size: 24px; cursor: pointer; color: #aaa;
                margin-top: 0; padding: 0 10px; line-height: 1;
            }
            .close-btn:hover { color: #fff; }
            .filter-section {
                display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 15px;
                background: #3c3c3c; /* Dunklerer Filter-Bereich */
                border-bottom: 1px solid #444;
            }
            .filter-btn {
                padding: 5px 10px; background: #555; /* Dunkle Buttons */
                color: #e0e0e0;
                border: 1px solid #666;
                border-radius: 4px; cursor: pointer; transition: all 0.2s;
            }
            .filter-btn.active { background: #0d6efd; color: white; border-color: #0d6efd; }
            .wachen-list { flex: 1; overflow-y: auto; padding: 0; background: #2b2b2b; }
            .building-menu-page-content > .wache-entry:nth-child(even) { background-color: #333; } /* Dunklerer "Zebra"-Streifen */
            .wache-entry {
                display: grid; grid-template-columns: 1fr auto auto; align-items: center;
                padding: 10px 15px; border-bottom: 1px solid #444; /* Dunklere Trennlinie */
                gap: 15px;
            }
            .wache-name { flex: 1; font-weight: 500; color: #e0e0e0; }
            .additional-info { font-size: 0.9em; color: #aaa; margin-top: 2px; }
            .label { padding: 3px 8px; border-radius: 4px; font-size: 12px; color: white; text-align: center; }
            .label.success { background: #28a745; }
            .label.danger { background: #dc3545; }

            /* Buttons in der Liste */
            .map-btn { color: #58a6ff; border-color: #58a6ff; }
            .map-btn:hover { background: #58a6ff; color: #2b2b2b; }
            .map-btn-place { color: #f0ad4e; border-color: #f0ad4e; }
            .map-btn-place:hover { background: #f0ad4e; color: #2b2b2b; }

            .project-name { font-size: 1.25rem; margin: 0; color: #e0e0e0; }
            .project-name::first-letter { font-size: 1.5em; margin-right: 5px; }

            /* Dropdowns und Suchfeld */
            #bundesland-filter-select, #region-filter-select, #stadt-filter-select, #search-input-field {
                padding: 6px;
                border-radius: 4px;
                border: 1px solid #666;
                background-color: #444; /* Dunkler Input-Hintergrund */
                color: #e0e0e0; /* Helle Schrift */
            }
            #search-input-field { width: 100%; box-sizing: border-box; }
            /* Platzhalter-Text heller machen */
            #search-input-field::placeholder { color: #999; }

            .loading-text { padding: 20px; text-align: center; font-size: 1.2em; color: #aaa; }
            `;
            // --- ENDE Dark Mode CSS ---

            styleElement.textContent = css;
            document.head.appendChild(styleElement);
            buildingMenuList.id = 'buildingMenuList';
            buildingMenuList.style.display = 'flex';
            buildingMenuList.className = 'building-menu';

            // --- KORREKTUR HIER: Dropdowns in einer Sektion ---
            buildingMenuList.innerHTML = `
                <div class="menu-header">
                    <h2 class="project-name">${projectName}</h2>
                    <button class="close-btn" title="Schließen">×</button>
                </div>

                <div class="filter-section" id="search-filters">
                     <input type="text" id="search-input-field" placeholder="Suche nach Name...">
                </div>

                <div class="filter-section" id="geo-filters">
                     <select id="bundesland-filter-select" style="display: none;">
                        <option value="all">Alle Bundesländer</option>
                     </select>
                     <select id="region-filter-select" style="display: none;">
                        <option value="all">Alle Kreise / Regionen</option>
                     </select>
                     <select id="stadt-filter-select" style="display: none;">
                        <option value="all">Alle Städte / Orte</option>
                     </select>
                </div>

                <div class="filter-section" id="building-type-filters">
                    <button class="filter-btn active" data-filter-group="wachen" data-filter-value='-1'>Alle Typen</button>
                </div>

                <div class="building-menu-page-content wachen-list" id="building-menu-page-content">
                    <div class="loading-text">Lade Wachenliste...</div>
                </div>`;
            // --- ENDE HTML-KORREKTUR ---

            document.body.appendChild(buildingMenuList);
            console.log(`${projectName}: Modal-Struktur wurde an body angehängt.`);
        }

        function updateBuildingMenuListList() {
            const pageContent = document.getElementById('building-menu-page-content');
            if (!pageContent) return;
            pageContent.innerHTML = '';

            const searchInput = document.getElementById('search-input-field');
            const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : '';

            let filteredList = wachen;

            if (searchTerm) {
                filteredList = filteredList.filter(w =>
                    w.name.toLowerCase().includes(searchTerm)
                );
            }
            if (bundeslandFilter !== 'all') {
                filteredList = filteredList.filter(w => w.bundesland === bundeslandFilter);
            }
            if (regionFilter !== 'all') {
                filteredList = filteredList.filter(w => w.region === regionFilter);
            }
            if (stadtFilter !== 'all') {
                filteredList = filteredList.filter(w => w.stadt === stadtFilter);
            }
            if (wachenFilter !== -1) {
                filteredList = filteredList.filter(w => w.building_type === wachenFilter);
            }

            if (filteredList.length === 0) {
                 pageContent.innerHTML = `<div class="loading-text">${dataLoaded ? 'Keine passenden Wachen gefunden.' : 'Lade Wachenliste...'}</div>`;
                 return;
            }

            filteredList.forEach(w => {
                const playerWache = getPlayerWacheFromRealWache(w);
                const el = document.createElement("div");
                el.className = "wache-entry";
                el.innerHTML = `
                    <div class="wache-name">${w.name}
                        <div class="additional-info">${building_type[w.building_type] || 'Unbekannt'}</div>
                    </div>
                    <span class="label ${playerWache ? "success" : "danger"}">${playerWache ? "Vorhanden" : "Fehlt"}</span>
                    <button class="${playerWache ? "map-btn" : "map-btn-place"}">${playerWache ? "Auf Karte" : "Platzieren"}</button>
                `;
                const button = el.querySelector('button');
                if (playerWache) {
                     button.addEventListener("click", () => {
                        GM_setValue(commandChannel, JSON.stringify({
                            action: 'setView',
                            lat: playerWache.latitude,
                            lon: playerWache.longitude
                        }));
                    });
                } else {
                     button.addEventListener("click", () => {
                        GM_setValue(commandChannel, JSON.stringify({
                            action: 'place',
                            lat: w.latitude,
                            lon: w.longitude,
                            name: w.name,
                            type: w.building_type
                        }));
                    });
                }
                pageContent.appendChild(el);
            });
        }

        function getPlayerWacheFromRealWache(realWache) {
            const latTolerance = 0.0027;
            const lonTolerance = 0.0043;
            return playerWachen.find(playerWache =>
                playerWache.latitude <= realWache.latitude + latTolerance &&
                playerWache.latitude >= realWache.latitude - latTolerance &&
                playerWache.longitude <= realWache.longitude + lonTolerance &&
                playerWache.longitude >= realWache.longitude - lonTolerance &&
                playerWache.building_type === realWache.building_type
            );
        }

        // --- KORREKTUR HIER: Zeigt/versteckt das SELECT, nicht den Container ---

        function populateBundeslandFilter() {
            const select = document.getElementById('bundesland-filter-select');
            if (!select) return;

            const uniqueBundeslaender = [...new Set(wachen.map(w => w.bundesland))].filter(Boolean).sort();

            if (uniqueBundeslaender.length > 0) {
                uniqueBundeslaender.forEach(bland => {
                    const option = document.createElement('option');
                    option.value = bland;
                    option.textContent = bland;
                    select.appendChild(option);
                });
                select.style.display = 'inline-block'; // Zeigt das Select-Element an
            }
        }

        function populateRegionFilter(selectedBundesland) {
            const select = document.getElementById('region-filter-select');
            if (!select) return;

            while (select.options.length > 1) { select.remove(1); }
            select.value = 'all';

            let relevantWachen = wachen;
            if (selectedBundesland !== 'all') {
                relevantWachen = wachen.filter(w => w.bundesland === selectedBundesland);
            }

            const uniqueRegions = [...new Set(relevantWachen.map(w => w.region))].filter(Boolean).sort();

            if (uniqueRegions.length > 0) {
                 uniqueRegions.forEach(region => {
                    const option = document.createElement('option');
                    option.value = region;
                    option.textContent = region;
                    select.appendChild(option);
                });
                select.style.display = 'inline-block';
            } else {
                select.style.display = 'none';
            }
        }

        function populateStadtFilter(selectedBundesland, selectedRegion) {
            const select = document.getElementById('stadt-filter-select');
            if (!select) return;

            while (select.options.length > 1) { select.remove(1); }
            select.value = 'all';

            let relevantWachen = wachen;
            if (selectedBundesland !== 'all') {
                relevantWachen = relevantWachen.filter(w => w.bundesland === selectedBundesland);
            }
            if (selectedRegion !== 'all') {
                relevantWachen = relevantWachen.filter(w => w.region === selectedRegion);
            }

            const uniqueStaedte = [...new Set(relevantWachen.map(w => w.stadt))].filter(Boolean).sort();

            if (uniqueStaedte.length > 0) {
                 uniqueStaedte.forEach(stadt => {
                    const option = document.createElement('option');
                    option.value = stadt;
                    option.textContent = stadt;
                    select.appendChild(option);
                });
                select.style.display = 'inline-block';
            } else {
                select.style.display = 'none';
            }
        }

        // --- ENDE KORREKTUR ---

        function populateBuildingTypeFilter() {
            const container = document.getElementById('building-type-filters');
            if (!container) return;

            const uniqueTypes = [...new Set(wachen.map(w => w.building_type))].sort((a, b) => a - b);

            uniqueTypes.forEach(typeId => {
                const typeName = building_type[typeId];
                if (typeName) {
                    const button = document.createElement('button');
                    button.className = 'filter-btn';
                    button.dataset.filterGroup = 'wachen';
                    button.dataset.filterValue = typeId;
                    button.textContent = typeName;
                    container.appendChild(button);
                }
            });
        }

        async function main() {
            console.log(`${projectName}: main() wird ausgeführt...`);
            const pageContent = document.getElementById('building-menu-page-content');
            if (pageContent) {
                pageContent.innerHTML = `<div class="loading-text">Lade Spielergebäude...</div>`;
            }
            try {
                // Lade die Gebäude des Spielers
                playerWachen = await new Promise((resolve, reject) => {
                    console.log(`${projectName}: Lade /api/buildings...`);
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: "https://www.leitstellenspiel.de/api/buildings",
                        anonymous: false,
                        onload: (response) => {
                            try {
                                if (response.status >= 200 && response.status < 300) {
                                    const jsonData = JSON.parse(response.responseText);
                                    console.log(`${projectName}: Spielergebäude geladen.`);
                                    resolve(jsonData);
                                } else {
                                    reject(new Error(`Fehler Spielergebäude: Status ${response.status}`));
                                }
                            } catch (e) {
                                console.error(`${projectName}: JSON Parse Error bei Spielergebäuden.`, e, response.responseText);
                                reject(new Error(`Fehler Spielergebäude: Ungültiges JSON. (Login-Problem?)`));
                            }
                        },
                        onerror: (response) => reject(new Error(`Fehler Spielergebäude: ${response.statusText}`)),
                        ontimeout: () => reject(new Error(`Fehler Spielergebäude: Timeout`))
                    });
                });

                if (pageContent) {
                    pageContent.innerHTML = `<div class="loading-text">Lade externe Wachenliste...</div>`;
                }

                // Lade die externe Wachenliste
                await new Promise((resolve, reject) => {
                    console.log(`${projectName}: Lade externe Wachenliste...`);
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: `${wachenlisteBaseUrl}?_=${new Date().getTime()}`,
                        onload: (response) => {
                            const rawText = response.responseText.trim();

                            const checkString = "/" + "/ ==UserScript==";
                            if (rawText.indexOf(checkString) === 0) {
                                return reject(new Error(`Fehler: URL liefert User-Skript.`));
                            }

                            const lines = rawText.split('\n').filter(line => line.trim() !== '');

                            const regexSingleQuote = new RegExp("'([^']+)'", "g");
                            const regexUnquotedKey = new RegExp("([a-zA-Z_][a-zA-Z0-9_]*):", "g"); // Korrigiert

                            wachen = lines.map(line => {
                                try {
                                    let jsonString = line.replace(regexSingleQuote, '"$1"');
                                    jsonString = jsonString.replace(regexUnquotedKey, '"$1":');
                                    const parsedObject = JSON.parse(jsonString);

                                    if (typeof parsedObject.name === 'string' &&
                                        typeof parsedObject.latitude === 'number' &&
                                        typeof parsedObject.longitude === 'number' &&
                                        typeof parsedObject.building_type === 'number') {

                                        if (!parsedObject.region) parsedObject.region = null;
                                        if (!parsedObject.bundesland) parsedObject.bundesland = null;
                                        if (!parsedObject.stadt) parsedObject.stadt = null;

                                        return parsedObject;
                                    }
                                    console.warn("Skipping malformed object structure:", line, parsedObject);
                                    return null;
                                } catch (e) {
                                    console.warn("Skipping malformed line (JSON parse error):", line, e);
                                    return null;
                                }
                            }).filter(w => w);

                            console.log(`${projectName}: Externe Wachenliste geladen. ${wachen.length} Einträge gefunden.`);
                            resolve();
                        },
                        onerror: (response) => reject(new Error(`${projectName}: Fehler CSV-Datei: Status ${response.status}`)),
                        ontimeout: () => reject(new Error(`${projectName}: Fehler CSV-Datei: Timeout`))
                    });
                });

                dataLoaded = true;

                populateBundeslandFilter();
                populateRegionFilter('all');
                populateStadtFilter('all', 'all');
                populateBuildingTypeFilter();

                updateBuildingMenuListList();

            } catch (err) {
                console.error(`${projectName}: Fehler beim Laden der Daten:`, err);
                if (pageContent) {
                    pageContent.innerHTML = `<div class="loading-text" style="color: red;">Fehler: ${err.message}. Konsole (F12) prüfen.</div>`;
                }
            }
        }

        async function setupListWindow() {
            console.log(`${projectName}: setupListWindow() wird ausgeführt...`);
            document.title = projectName;
            document.body.style.overflow = 'hidden';
            // document.body.style.background = '#fff'; // Wird jetzt durch CSS im Header gesteuert

            createBuildingMenu();

            document.querySelector('.close-btn')?.addEventListener('click', () => window.close());

            document.addEventListener('click', (event) => {
                if (event.target.matches('.filter-btn')) {
                    const group = event.target.getAttribute('data-filter-group');
                    const groupValue = event.target.getAttribute('data-filter-value');

                    document.querySelectorAll(`[data-filter-group="${group}"]`).forEach(b => b.classList.remove('active'));
                    event.target.classList.add('active');

                    if (group === 'wachen') {
                        wachenFilter = parseInt(groupValue, 10);
                    }
                    updateBuildingMenuListList();
                }
            });

            document.addEventListener('change', (event) => {
                const targetId = event.target.id;

                if (targetId === 'bundesland-filter-select') {
                    bundeslandFilter = event.target.value;
                    regionFilter = 'all';
                    stadtFilter = 'all';
                    populateRegionFilter(bundeslandFilter);
                    populateStadtFilter(bundeslandFilter, regionFilter);
                    updateBuildingMenuListList();
                }

                else if (targetId === 'region-filter-select') {
                    regionFilter = event.target.value;
                    stadtFilter = 'all';
                    populateStadtFilter(bundeslandFilter, regionFilter);
                    updateBuildingMenuListList();
                }

                else if (targetId === 'stadt-filter-select') {
                    stadtFilter = event.target.value;
                    updateBuildingMenuListList();
                }
            });

            document.addEventListener('input', (event) => {
                if (event.target.matches('#search-input-field')) {
                     updateBuildingMenuListList();
                }
            });

            await main();
        }

        // Startlogik für Tab B
        if (document.readyState === 'loading') {
            console.log(`${projectName}: Warte auf DOMContentLoaded...`);
            document.addEventListener('DOMContentLoaded', setupListWindow);
        } else {
            console.log(`${projectName}: DOM bereits geladen, starte setupListWindow() sofort.`);
            setupListWindow();
        }
    }
    // --- ENDE Code-Block Listen-Fenster ---

})();
