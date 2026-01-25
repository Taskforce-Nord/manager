// ==UserScript==
// @name         LSS & BOS-Fahrzeuge: Wachenbau-Brücke (v2.0 - Radar)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Verbindet BOS-Fahrzeuge mit LSS. Mit 600m-Radar, Distanzanzeige und Sofort-Cache-Update.
// @author       Gemini (Idee von Whice/Masklin/User)
// @match        https://*.leitstellenspiel.de/
// @match        https://www.leitstellenspiel.de/
// @match        https://bos-fahrzeuge.info/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @connect      nominatim.openstreetmap.org
// @connect      bos-fahrzeuge.info
// @connect      www.leitstellenspiel.de
// ==/UserScript==

(function() {
    'use strict';

    const CHANNEL = 'bos_lss_connect_command';
    const CACHE_KEY = 'bos_lss_user_buildings';
    const CACHE_DATE_KEY = 'bos_lss_cache_date';
    const PROJECT_NAME = '🚒 BOS-Brücke';

    // Radius drastisch erhöht auf ca. 600m (0.006 Grad) um Ungenauigkeiten abzufangen
    const RADIUS_TOLERANCE = 0.006; 

    // ---------------------------------------------------------
    // TEIL A: KONFIGURATION & HELPER
    // ---------------------------------------------------------

    const TYPE_MAPPING = {
        'FF': 0, 'BF': 0, 'FW': 0,      // Feuerwache
        'RW': 2,                        // Rettungswache
        'THW': 9,                       // THW
        'BEPO': 11, 'BPOL': 11,         // BePo
        'BS': 12, 'SEG': 12,            // SEG
        'POL': 6,                       // Polizei
        'KH': 4,                        // Krankenhaus
        'RTH': 5,                       // RTH
        'WR': 15, 'DLRG': 15, 'WASSER': 15 // Wasserrettung
    };

    function resolveBuildingType(text) {
        if (!text) return null;
        const match = text.match(/\(([^)]+)\)/);
        if (match && match[1]) {
            const abbr = match[1].toUpperCase();
            if (TYPE_MAPPING.hasOwnProperty(abbr)) return TYPE_MAPPING[abbr];
        }
        return null;
    }

    // Berechnet Distanz in Metern (grob) für Anzeige
    function getDistanceInMeters(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Erde Radius
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δφ = (lat2-lat1) * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;
        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return Math.round(R * c);
    }

    function checkDuplication(lat, lon, newTypeId, userBuildings) {
        if (!userBuildings || userBuildings.length === 0) return null;
        
        // Wir suchen ALLE Gebäude im Radius
        const matches = userBuildings.filter(b => 
            Math.abs(b.l - lat) < RADIUS_TOLERANCE && 
            Math.abs(b.g - lon) < RADIUS_TOLERANCE
        );

        if (matches.length === 0) return null;

        // Sortieren nach Distanz
        matches.forEach(m => m.distance = getDistanceInMeters(lat, lon, m.l, m.g));
        matches.sort((a, b) => a.distance - b.distance);

        // 1. Priorität: Gleicher Typ und nah
        const sameType = matches.find(m => (newTypeId !== null && m.t === newTypeId));
        if (sameType) return sameType;

        // 2. Priorität: Irgendein Gebäude sehr nah (< 150m)
        if (matches[0].distance < 150) return matches[0];

        return null;
    }

    // Fügt ein gebautes Gebäude sofort dem Cache hinzu (Optimistic UI)
    function addToLocalCache(name, lat, lon, type) {
        const cacheRaw = GM_getValue(CACHE_KEY, '[]');
        let userBuildings = JSON.parse(cacheRaw);
        
        userBuildings.push({
            l: lat,
            g: lon,
            n: name,
            t: type
        });
        
        GM_setValue(CACHE_KEY, JSON.stringify(userBuildings));
        console.log(`${PROJECT_NAME}: Lokalen Cache optimistisch aktualisiert: ${name}`);
    }

    function geocodeAndSend(address, name, typeId, btnElement) {
        console.log(`${PROJECT_NAME}: Geocoding für: ${address}`);

        GM_xmlhttpRequest({
            method: "GET",
            url: `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`,
            headers: { "User-Agent": "Tampermonkey Script (LSS Community)" },
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data && data.length > 0) {
                        const lat = parseFloat(data[0].lat);
                        const lon = parseFloat(data[0].lon);

                        // Duplikat Check
                        const cacheRaw = GM_getValue(CACHE_KEY, '[]');
                        const userBuildings = JSON.parse(cacheRaw);
                        const duplicate = checkDuplication(lat, lon, typeId, userBuildings);

                        if (duplicate && !btnElement.dataset.confirmed) {
                            // Text anpassen je nach Distanz
                            const distText = duplicate.distance ? `(~${duplicate.distance}m)` : '';
                            btnElement.innerHTML = `⚠️ Existiert? ${distText}`;
                            btnElement.style.backgroundColor = '#f0ad4e'; 
                            btnElement.title = `Gefunden: "${duplicate.n}" in ${duplicate.distance}m Entfernung.`;
                            btnElement.dataset.confirmed = "true";
                            btnElement.disabled = false;
                            return; 
                        }

                        if (btnElement) {
                            btnElement.innerHTML = '✅ Gesendet!';
                            btnElement.style.backgroundColor = '#5cb85c';
                            btnElement.dataset.confirmed = ""; 
                        }

                        // COMMAND SENDEN
                        GM_setValue(CHANNEL, JSON.stringify({
                            action: 'buildFromBOS',
                            name: name,
                            lat: lat,
                            lon: lon,
                            buildingType: typeId,
                            ts: new Date().getTime()
                        }));

                        // CACHE SOFORT UPDATE
                        addToLocalCache(name, lat, lon, typeId);

                        if (btnElement) {
                            setTimeout(() => {
                                btnElement.innerHTML = '🏗️ Im LSS bauen';
                                btnElement.style.backgroundColor = '#d9534f';
                                btnElement.disabled = false;
                            }, 2000);
                        }
                    } else {
                        if (btnElement) btnElement.innerHTML = '❌ Adresse nicht gefunden';
                    }
                } catch (err) {
                    if (btnElement) btnElement.innerHTML = '❌ Fehler';
                }
            },
            onerror: function() {
                if (btnElement) btnElement.innerHTML = '❌ Netz-Fehler';
            }
        });
    }

    // ---------------------------------------------------------
    // TEIL B: LEITSTELLENSPIEL
    // ---------------------------------------------------------
    if (window.location.host.includes('leitstellenspiel.de')) {
        
        async function updateCache(buttonElement) {
            if(buttonElement) {
                buttonElement.innerHTML = '⏳ Lade...';
                buttonElement.style.cursor = 'wait';
            }
            
            try {
                const response = await fetch('/api/buildings');
                if (response.ok) {
                    const data = await response.json();
                    
                    const lightData = data.map(b => ({
                        l: parseFloat(b.latitude),
                        g: parseFloat(b.longitude),
                        n: b.caption,
                        t: b.building_type
                    }));
                    
                    GM_setValue(CACHE_KEY, JSON.stringify(lightData));
                    
                    const now = new Date();
                    const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
                    GM_setValue(CACHE_DATE_KEY, dateStr);

                    if(buttonElement) {
                        buttonElement.innerHTML = `✅ ${lightData.length} Wachen`;
                        setTimeout(() => {
                            buttonElement.innerHTML = `🔄 Cache update (${dateStr})`;
                            buttonElement.style.cursor = 'pointer';
                        }, 2000);
                    }
                    alert(`${PROJECT_NAME}\n\n${lightData.length} Gebäude gespeichert!`);
                }
            } catch (e) {
                if(buttonElement) buttonElement.innerHTML = '❌ Fehler';
                alert('Fehler beim Laden der Gebäude.');
            }
        }

        function addMenuEntries() {
            const menuProfileUl = document.querySelector('#menu_profile + ul');
            if (!menuProfileUl) return;

            if (!menuProfileUl.querySelector('.bos-bridge-header')) {
                const header = document.createElement('li');
                header.className = 'divider bos-bridge-header';
                header.role = 'presentation';
                menuProfileUl.appendChild(header);
            }

            if (!menuProfileUl.querySelector('.bos-bridge-open')) {
                const liOpen = document.createElement('li');
                liOpen.className = 'bos-bridge-open';
                const aOpen = document.createElement('a');
                aOpen.style.cursor = 'pointer';
                aOpen.innerHTML = `🗺️ BOS-Map öffnen`;
                aOpen.onclick = () => {
                    const w = 1200, h = 900;
                    const left = (window.screen.width - w) / 2;
                    const top = (window.screen.height - h) / 2;
                    window.open('https://bos-fahrzeuge.info/wachen', 'BOS_Window', `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=yes`);
                };
                liOpen.appendChild(aOpen);
                menuProfileUl.appendChild(liOpen);
            }

            if (!menuProfileUl.querySelector('.bos-bridge-cache')) {
                const lastDate = GM_getValue(CACHE_DATE_KEY, 'Nie');
                const liCache = document.createElement('li');
                liCache.className = 'bos-bridge-cache';
                const aCache = document.createElement('a');
                aCache.style.cursor = 'pointer';
                aCache.innerHTML = `🔄 Cache update (${lastDate})`;
                aCache.onclick = () => updateCache(aCache);
                liCache.appendChild(aCache);
                menuProfileUl.appendChild(liCache);
            }
        }

        addMenuEntries();

        const existingData = GM_getValue(CACHE_KEY);
        if (!existingData) {
            setTimeout(() => updateCache(), 3000);
        }

        GM_addValueChangeListener(CHANNEL, (name, oldVal, newVal, remote) => {
            if (remote && newVal) {
                const cmd = JSON.parse(newVal);
                if (cmd.action !== 'buildFromBOS') return;

                if (typeof map !== 'undefined' && map.setView) {
                    map.invalidateSize();
                    map.setView([cmd.lat, cmd.lon], 18);
                }

                setTimeout(() => {
                    const buildBtn = document.querySelector('#build_new_building');
                    if (buildBtn) buildBtn.click();

                    const fillInterval = setInterval(() => {
                        const nameInput = document.querySelector('#building_name');
                        const typeSelect = document.querySelector('#building_building_type');
                        if (nameInput && typeSelect) {
                            let cleanName = cmd.name.replace(/^Wache:\s*/i, '');
                            nameInput.value = cleanName;
                            if (cmd.buildingType !== null) {
                                typeSelect.value = cmd.buildingType;
                                typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                            clearInterval(fillInterval);
                        }
                    }, 200);
                    setTimeout(() => clearInterval(fillInterval), 5000);
                }, 500);
            }
        });
    }

    // ---------------------------------------------------------
    // TEIL C: BOS-FAHRZEUGE
    // ---------------------------------------------------------
    else if (window.location.host.includes('bos-fahrzeuge.info')) {

        function initDetailPage() {
            const addressTag = document.querySelector('td address');
            const nameHeader = document.querySelector('h1');
            if (!addressTag || !nameHeader) return;

            let detectedType = null;
            const headers = Array.from(document.querySelectorAll('th'));
            const typeHeader = headers.find(th => th.textContent.includes('Wachenart'));
            if (typeHeader && typeHeader.nextElementSibling) detectedType = resolveBuildingType(typeHeader.nextElementSibling.textContent.trim());

            const btn = createBuildButton();
            btn.addEventListener('click', (e) => {
                e.preventDefault(); btn.innerHTML = '⏳ Arbeite...'; btn.disabled = true;
                const name = nameHeader.innerText.trim();
                let address = addressTag.innerHTML.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]*>?/gm, '').trim();
                geocodeAndSend(address, name, detectedType, btn);
            });
            addressTag.parentNode.appendChild(btn);
        }

        function initMapPoller() {
            setInterval(() => {
                const markerWindows = document.querySelectorAll('#marker-window');
                
                markerWindows.forEach(markerWindow => {
                    const detailLink = markerWindow.querySelector('a[href^="/wachen/"]');
                    if (!detailLink) return;
                    if (detailLink.offsetParent === null) return;

                    if (!markerWindow.querySelector('.bos-lss-btn')) {
                        injectButtonIntoModal(detailLink);
                    }
                    
                    // RESIZE FIX
                    const scrollContainer = markerWindow.parentElement.parentElement;
                    if (scrollContainer && scrollContainer.style.height === '110px') {
                        scrollContainer.style.height = 'auto'; 
                        scrollContainer.style.minHeight = '165px';
                        scrollContainer.style.overflow = 'visible'; 
                    }
                });
            }, 500); 
        }

        function injectButtonIntoModal(detailLink) {
            const btn = createBuildButton();
            btn.classList.add('bos-lss-btn');
            btn.style.marginTop = '8px'; 
            btn.style.width = '100%';
            
            btn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (btn.dataset.confirmed) {
                    btn.innerHTML = '⏳ Sende...'; btn.disabled = true;
                    fetchAndProcess(detailLink, btn); return;
                }
                btn.innerHTML = '⏳ Hole Daten...'; btn.disabled = true;
                fetchAndProcess(detailLink, btn);
            });
            
            detailLink.parentNode.insertBefore(btn, detailLink.nextSibling);
        }

        function fetchAndProcess(detailLink, btn) {
             GM_xmlhttpRequest({
                method: "GET", url: detailLink.href,
                onload: function(response) {
                    if (response.status === 200) {
                        const doc = new DOMParser().parseFromString(response.responseText, "text/html");
                        const nameHeader = doc.querySelector('h1');
                        const name = nameHeader ? nameHeader.innerText.trim() : "Wache";
                        const addressTag = doc.querySelector('td address');
                        if (!addressTag) { btn.innerHTML = '❌ Keine Adresse'; return; }
                        let address = addressTag.innerHTML.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]*>?/gm, '').trim();
                        let detectedType = null;
                        const headers = Array.from(doc.querySelectorAll('th'));
                        const typeHeader = headers.find(th => th.textContent.includes('Wachenart'));
                        if (typeHeader && typeHeader.nextElementSibling) detectedType = resolveBuildingType(typeHeader.nextElementSibling.textContent.trim());
                        btn.innerHTML = '⏳ Checke...';
                        geocodeAndSend(address, name, detectedType, btn);
                    } else { btn.innerHTML = '❌ Fehler'; }
                }
            });
        }

        function createBuildButton() {
            const btn = document.createElement('button');
            btn.innerHTML = '🏗️ Im LSS bauen'; btn.style.cursor = 'pointer';
            btn.style.padding = '4px 8px'; btn.style.backgroundColor = '#d9534f';
            btn.style.color = 'white'; btn.style.border = 'none';
            btn.style.borderRadius = '4px'; btn.style.fontSize = '11px';
            btn.style.fontWeight = 'bold'; btn.style.display = 'block';
            return btn;
        }

        if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { initDetailPage(); initMapPoller(); });
        } else { initDetailPage(); initMapPoller(); }
    }
})();
