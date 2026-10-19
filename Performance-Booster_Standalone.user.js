// ==UserScript==
// @name         Performance-Boost - The Shapeshifter (Homer Edition)
// @namespace    http://tampermonkey.net/
// @version      20.0.0
// @description  Wähle: Sanfter RAM-Befreier, Nukularer Einsatz-Killer oder AUS (LSS-Vanilla-Hölle).
// @author       Masklin
// @match        https://www.leitstellenspiel.de/*
// @noframes
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    if (window.location.href.includes('/leitstellenansicht')) {
        return;
    }

    // ==========================================
    // 0. MODUS-VERWALTUNG (Local Storage)
    // ==========================================
    const currentMode = localStorage.getItem('lss_performance_mode') || 'soft';
    
    let btnColor, btnText, btnTitle, nextMode;

    if (currentMode === 'nuclear') {
        btnColor = '#dc3545'; // Rot
        btnText = '☢️ NUKULAR';
        btnTitle = 'Klick: Wechsel zu AUS (Die rottige Vanilla LSS Hölle)';
        nextMode = 'off';
    } else if (currentMode === 'off') {
        btnColor = '#95a5a6'; // Grau
        btnText = '😴 AUS';
        btnTitle = 'Klick: Wechsel zu SOFT (Sanfter RAM-Befreier)';
        nextMode = 'soft';
    } else { // soft
        btnColor = '#2ecc71'; // Grün
        btnText = '🐢 SOFT';
        btnTitle = 'Klick: Wechsel zu NUKULAR (Alles einäschern)';
        nextMode = 'nuclear';
    }

    // ==========================================
    // 1. NAVBAR-SCHALTER INJIZIEREN
    // ==========================================
    const toggleLi = document.createElement('li');
    toggleLi.innerHTML = `<a href="#" id="lss-mode-toggle" title="${btnTitle}" style="color: ${btnColor}; font-weight: bold; cursor: pointer; transition: opacity 0.2s;">[ ${btnText} ]</a>`;

    const navbar = document.querySelector('#navbar-main-collapse .navbar-right');
    if (navbar) {
        navbar.insertBefore(toggleLi, navbar.firstChild);
    }

    document.getElementById('lss-mode-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.setItem('lss_performance_mode', nextMode);
        e.target.style.opacity = '0.5';
        e.target.textContent = 'Lade...';
        setTimeout(() => location.reload(), 200);
    });

    // ==========================================
    // 2. GEMEINSAMES CSS & WACHEN-LOGIK
    // ==========================================
    const style = document.createElement('style');
    // Die Wachen-Logik läuft immer, egal welcher Modus!
    style.innerHTML = `
        .building_list_vehicles { display: none !important; }
        #building_list.lss-no-category.lss-search-active .building_list_li.lss-search-match { display: block !important; }
        html body #building_list.lss-search-active .building_list_li:not(.lss-search-match) { display: none !important; }
    `;
    
    // Modus-spezifisches CSS injizieren
    if (currentMode === 'nuclear') {
        style.innerHTML += `
            #radio_messages_important, #radio_messages { display: none !important; }
            #alliance_missions_loading_error, #missions_loading_error, 
            #sicherheitswache_missions_loading_error, #krankentransport_missions_loading_error { display: none !important; }
            #mission_select_sicherheitswache, #mission_select_krankentransport, 
            #mission_select_alliance, .mission_filters { display: none !important; }
        `;
    } else if (currentMode === 'soft') {
        style.innerHTML += `
            #radio_messages_important, #radio_messages { display: none !important; }
            #mission_list { contain: content; }
            .missionSideBarEntry { contain: content; content-visibility: auto; contain-intrinsic-size: 50px; }
            .leaflet-marker-pane .mission_vehicle_state, .leaflet-marker-pane img[src*="mission"] { display: none !important; }
        `;
    }
    
    document.head.appendChild(style);

    const dynamicFilterStyle = document.createElement('style');
    dynamicFilterStyle.id = 'lss-dynamic-building-filter';
    document.head.appendChild(dynamicFilterStyle);

    function updateBuildingFilterCSS(activeButtons) {
        let activeTypes = [];
        activeButtons.forEach(btn => {
            try { activeTypes = activeTypes.concat(JSON.parse(btn.getAttribute('building_type_ids'))); } catch(e) {}
        });
        const buildingList = document.getElementById('building_list');
        if (activeTypes.length === 0) {
            if (buildingList) buildingList.classList.add('lss-no-category');
            dynamicFilterStyle.innerHTML = '#building_list .building_list_li { display: none !important; }';
            return;
        }
        if (buildingList) buildingList.classList.remove('lss-no-category');
        let newCSS = `#building_list .building_list_li { display: none !important; }\n`;
        activeTypes.forEach(id => { newCSS += `#building_list .building_list_li[building_type_id="${id}"] { display: block !important; }\n`; });
        dynamicFilterStyle.innerHTML = newCSS;
    }

    setTimeout(() => {
        const originalBtnGroup = document.getElementById('btn-group-building-select');
        if (originalBtnGroup) {
            const clonedBtnGroup = originalBtnGroup.cloneNode(true);
            originalBtnGroup.parentNode.replaceChild(clonedBtnGroup, originalBtnGroup);
            clonedBtnGroup.querySelectorAll('.btn[building_type_ids]').forEach(b => { b.classList.remove('btn-success'); b.classList.add('btn-danger'); });
            updateBuildingFilterCSS([]);

            clonedBtnGroup.addEventListener('click', (e) => {
                const btn = e.target.closest('.btn');
                if (!btn || !btn.hasAttribute('building_type_ids')) return;
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                const wasActive = btn.classList.contains('btn-success');
                clonedBtnGroup.querySelectorAll('.btn[building_type_ids]').forEach(b => { b.classList.remove('btn-success'); b.classList.add('btn-danger'); });
                if (!wasActive) { btn.classList.remove('btn-danger'); btn.classList.add('btn-success'); }
                updateBuildingFilterCSS(clonedBtnGroup.querySelectorAll('.btn-success[building_type_ids]'));
            }, true);
        }

        let buildingCache = [];
        const buildingList = document.getElementById('building_list');
        function rebuildCache() { buildingCache = Array.from(document.querySelectorAll('.building_list_li')).map(li => { return { element: li, text: li.textContent.toLowerCase() }; }); }
        if (buildingList) {
            rebuildCache();
            let debounceTimer;
            new MutationObserver(() => { clearTimeout(debounceTimer); debounceTimer = setTimeout(rebuildCache, 500); }).observe(buildingList, { childList: true, subtree: true });
        }

        const searchInput = document.querySelector('.search-station-input');
        if (searchInput && buildingList) {
            const clonedSearch = searchInput.cloneNode(true);
            searchInput.parentNode.replaceChild(clonedSearch, searchInput);
            ['keyup', 'keydown', 'keypress'].forEach(eType => clonedSearch.addEventListener(eType, (e) => e.stopPropagation()));
            clonedSearch.addEventListener('input', (e) => {
                e.stopPropagation();
                const term = e.target.value.toLowerCase().trim();
                if (term.length === 0) {
                    buildingList.classList.remove('lss-search-active');
                    buildingCache.forEach(b => b.element.classList.remove('lss-search-match'));
                } else {
                    buildingList.classList.add('lss-search-active');
                    buildingCache.forEach(b => {
                        if (b.text.includes(term)) b.element.classList.add('lss-search-match');
                        else b.element.classList.remove('lss-search-match');
                    });
                }
            });
        }
    }, 1500);


    // ==========================================
    // 3. EINSATZ-LOGIK: NUKULAR, SOFT ODER AUS?
    // ==========================================

    if (currentMode === 'nuclear') {
        // --- ☢️ NUKULAR ---
        if (typeof $!== 'undefined' &&$.ajaxPrefilter) {
            $.ajaxPrefilter(function(options, originalOptions, jqXHR) {
                if (options.url && (options.url.includes('mission_markers_own') || options.url.includes('mission_markers_alliance') || options.url.includes('missions?type='))) { jqXHR.abort(); }
            });
        }

        const engineKiller = document.createElement('script');
        engineKiller.innerHTML = `
            window.radioMessage = function() {};
            window.patientMarkerAdd = function() {};
            if (typeof map_pois_service !== 'undefined') map_pois_service.leafletMissionPositionMarkerAdd = function() {};
            window.missionMarkerAdd = function(e) { return false; };
            window.missionMarkerAddSingle = function(e) { return false; };
            window.missionMarkerDelete = function(e) { return false; };
            window.mission_timer_start = function() {};
            
            window.asyncFetchAllianceMissions = function() {};
            window.asyncFetchSicherheitswacheMissions = function() {};
            window.asyncFetchKrankentransportMissions = function() {};

            $(document).ready(function() {
                $('#mission_list, #mission_list_alliance, #mission_list_sicherheitswache, #mission_list_krankentransport').remove();
                $('#missions-panel-body').html('<div style="padding: 40px 20px; color: #fff; background-color: #2c3e50; text-align: center; font-weight: bold; border-radius: 8px; margin: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"><div style="font-size: 40px; margin-bottom: 10px;">☢️</div><div style="font-size: 18px; letter-spacing: 1px;">EINSATZLISTE NUKULARISIERT</div><div style="font-size: 12px; color: #95a5a6; margin-top: 5px;">Homer war hier.</div></div>');
            });
        `;
        document.head.appendChild(engineKiller);

    } else if (currentMode === 'soft') {
        // --- 🐢 SOFT ---
        const engineKiller = document.createElement('script');
        engineKiller.innerHTML = `
            window.radioMessage = function() {};
            window.patientMarkerAdd = function() {};
            if (typeof map_pois_service !== 'undefined') map_pois_service.leafletMissionPositionMarkerAdd = function() {};
            window.missionTimerDelete = function() {};
        `;
        document.head.appendChild(engineKiller);

        const missionSafeHouse = new Map();

        function hibernateHiddenMissions() {
            document.querySelectorAll('.missionSideBarEntry').forEach(mission => {
                if (mission.style.display === 'none' || mission.classList.contains('hidden')) {
                    const parentId = mission.parentElement ? mission.parentElement.id : 'mission_list';
                    missionSafeHouse.set(mission.id, { element: mission, parentId: parentId });
                    mission.remove(); 
                }
            });
        }

        function wakeupMissions() {
            missionSafeHouse.forEach((data) => {
                const parent = document.getElementById(data.parentId);
                if (parent) parent.appendChild(data.element);
            });
            missionSafeHouse.clear();
        }

        setTimeout(() => {
            document.querySelectorAll('a[id^="mission_select_"], #mission_select_alliance, #mission_select_sicherheitswache').forEach(tab => {
                tab.addEventListener('click', () => {
                    wakeupMissions();
                    setTimeout(hibernateHiddenMissions, 400); 
                });
            });

            const missionList = document.getElementById('mission_list');
            if (missionList) {
                new MutationObserver((mutations) => {
                    mutations.forEach(mutation => {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1 && node.classList.contains('missionSideBarEntry')) {
                                if (node.style.display === 'none' || node.classList.contains('hidden')) {
                                    missionSafeHouse.set(node.id, { element: node, parentId: missionList.id });
                                    node.remove();
                                }
                            }
                        });
                    });
                }).observe(missionList, { childList: true });
            }
        }, 1500);

        setInterval(() => {
            Array.from(document.getElementsByClassName('mission_panel_green')).forEach(panel => {
                const missionContainer = panel.closest('.missionSideBarEntry');
                if (missionContainer) {
                    missionContainer.remove();
                    if (missionSafeHouse.has(missionContainer.id)) missionSafeHouse.delete(missionContainer.id);
                }
            });
        }, 5000);

        setTimeout(hibernateHiddenMissions, 2500);

    } else {
        // --- 😴 AUS ---
        console.log("Der Performance-Boost pennt. Willkommen zurück im LSS-Speicherleck!");
        // Wir machen hier gar nichts. Die LSS-Engine darf wüten wie sie will.
    }

})();
