// ==UserScript==
// @name         Batch-Alarm
// @namespace    http://tampermonkey.net/
// @version      44.7.0
// @description  Batch-Alarm für Einsätze UND BSR. Fire-and-Forget (kein Warten mehr auf Server-Antworten).
// @author       Masklin
// @match        https://www.leitstellenspiel.de/missions/*
// @match        https://www.leitstellenspiel.de/buildings/*
// @grant        none
// ==/UserScript==

(async function() {
    'use strict';

    const isBSR = window.location.pathname.startsWith('/buildings/');
    const isBSRAlarmView = isBSR && window.location.pathname.includes('/alarm/');

    const DB_NAME = 'BatchAlarm_DB';
    const STORE_NAME = 'settingsStore';

    const defaultSettings = {
        chunkSize: 15,
        hotkeyNormal: 'x',
        hotkeyNext: 's',
        progressPosition: 'bottom',
        validationDelay: 2500,
        serialDelay: 100
    };

    // --- IndexedDB Hilfsfunktionen ---
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function getSettingsDB() {
        try {
            const db = await initDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get('config');
                req.onsuccess = () => resolve(req.result ? { ...defaultSettings, ...req.result } : defaultSettings);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.error("[Batch-Alarm] IndexedDB Fehler beim Laden, nutze Defaults:", e);
            return defaultSettings;
        }
    }

    async function saveSettingsDB(settings) {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(settings, 'config');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // --- Einstellungen asynchron laden ---
    const currentSettings = await getSettingsDB();

    const CHUNK_SIZE = currentSettings.chunkSize;
    const ALARM_HOTKEY_NORMAL = currentSettings.hotkeyNormal;
    const ALARM_HOTKEY_NEXT = currentSettings.hotkeyNext;
    const PROGRESS_BAR_POSITION = currentSettings.progressPosition;
    const VALIDATION_DELAY_MS = currentSettings.validationDelay;
    const SERIAL_DELAY_MS = currentSettings.serialDelay;

    let isAlarming = false;

    // --- GUI: EINSTELLUNGEN ---
    function injectConfigButton() {
        let alarmBtn = document.getElementById('mission_alarm_btn');

        if (!alarmBtn && isBSR) {
            alarmBtn = document.querySelector('form[action*="alarm"] input[type="submit"]') ||
                       Array.from(document.querySelectorAll('input[type="submit"]')).find(el => el.value === 'Alarmieren');
        }

        if (!alarmBtn || document.getElementById('batch-alarm-config-btn')) return;

        const configBtn = document.createElement('a');
        configBtn.id = 'batch-alarm-config-btn';
        configBtn.className = 'btn btn-default btn-sm';
        configBtn.style.marginLeft = '5px';
        configBtn.href = '#';

        if (isBSR) {
            configBtn.style.marginTop = '7px';
        }

        configBtn.innerHTML = '⚙️ Batch-Alarm';
        configBtn.onclick = (e) => {
            e.preventDefault();
            openConfigModal();
        };

        alarmBtn.parentNode.insertBefore(configBtn, alarmBtn.nextSibling);
    }

    function openConfigModal() {
        document.getElementById('ba-modal-overlay')?.remove();
        const s = currentSettings;

        const overlay = document.createElement('div');
        overlay.id = 'ba-modal-overlay';

        overlay.innerHTML = `
            <style>
                #ba-modal-overlay {
                    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(5px);
                    z-index: 100000; display: flex; align-items: center; justify-content: center;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                }
                #ba-modal-content {
                    background: #1e293b; color: #f8fafc; padding: 32px; border-radius: 12px;
                    width: 550px; max-width: 95%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.75);
                    border: 1px solid #334155;
                }
                #ba-modal-header {
                    margin: 0 0 24px 0; padding-bottom: 16px; border-bottom: 1px solid #334155;
                    font-size: 1.4rem; font-weight: 600; color: #60a5fa; letter-spacing: 0.5px;
                }
                .ba-row {
                    display: flex; gap: 20px;
                }
                .ba-form-group {
                    margin-bottom: 20px; flex: 1;
                }
                .ba-label {
                    display: block; font-size: 1rem; font-weight: 500; margin-bottom: 6px; color: #e2e8f0;
                }
                .ba-small {
                    display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 10px; font-weight: normal;
                }
                .ba-input {
                    width: 100%; padding: 12px 14px !important;
                    background: #0f172a !important; border: 1px solid #475569 !important;
                    border-radius: 8px !important; color: #ffffff !important;
                    font-size: 1rem !important; transition: all 0.2s ease;
                    box-sizing: border-box;
                }
                .ba-input:focus {
                    outline: none !important; border-color: #3b82f6 !important;
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3) !important;
                }
                .ba-footer {
                    display: flex; justify-content: flex-end; gap: 14px; margin-top: 28px; padding-top: 20px;
                    border-top: 1px solid #334155;
                }
                .ba-btn {
                    padding: 10px 20px !important; border-radius: 8px !important; border: none !important;
                    font-size: 1rem !important; font-weight: 500 !important;
                    cursor: pointer; transition: background 0.2s;
                }
                .ba-btn-cancel { background: #475569 !important; color: #f8fafc !important; }
                .ba-btn-cancel:hover { background: #64748b !important; }
                .ba-btn-save { background: #2563eb !important; color: #ffffff !important; }
                .ba-btn-save:hover { background: #1d4ed8 !important; }
            </style>

            <div id="ba-modal-content">
                <div id="ba-modal-header">⚙️ Batch-Alarm Konfiguration</div>

                <div class="ba-form-group">
                    <label class="ba-label">Batch-Größe & Trigger</label>
                    <span class="ba-small">Skript greift erst bei MEHR als dieser Anzahl an Fz.</span>
                    <input type="number" id="ba_chunkSize" class="ba-input" value="${s.chunkSize}">
                </div>

                <div class="ba-row">
                    <div class="ba-form-group">
                        <label class="ba-label">Hotkey 'Alarmieren'</label>
                        <span class="ba-small">Einzelner Buchstabe.</span>
                        <input type="text" id="ba_hotkeyNormal" class="ba-input" value="${s.hotkeyNormal}" maxlength="1">
                    </div>
                    <div class="ba-form-group">
                        <label class="ba-label">Hotkey 'Weiter'</label>
                        <span class="ba-small">(Ignoriert im BSR)</span>
                        <input type="text" id="ba_hotkeyNext" class="ba-input" value="${s.hotkeyNext}" maxlength="1">
                    </div>
                </div>

                <div class="ba-form-group">
                    <label class="ba-label">Position der Fortschrittsanzeige</label>
                    <select id="ba_progressPosition" class="ba-input">
                        <option value="bottom" ${s.progressPosition === 'bottom' ? 'selected' : ''}>Unten (Standard)</option>
                        <option value="top" ${s.progressPosition === 'top' ? 'selected' : ''}>Oben</option>
                        <option value="left" ${s.progressPosition === 'left' ? 'selected' : ''}>Links</option>
                        <option value="right" ${s.progressPosition === 'right' ? 'selected' : ''}>Rechts</option>
                    </select>
                </div>

                <div class="ba-row">
                    <div class="ba-form-group">
                        <label class="ba-label">Lade-Delay (ms)</label>
                        <span class="ba-small">Wartezeit (Validierung)</span>
                        <input type="number" id="ba_validationDelay" class="ba-input" value="${s.validationDelay}">
                    </div>
                    <div class="ba-form-group">
                        <label class="ba-label">Block-Delay (ms)</label>
                        <span class="ba-small">Wartezeit (Senden)</span>
                        <input type="number" id="ba_serialDelay" class="ba-input" value="${s.serialDelay}">
                    </div>
                </div>

                <div class="ba-footer">
                    <button id="ba_cancel" class="ba-btn ba-btn-cancel">Abbrechen</button>
                    <button id="ba_save" class="ba-btn ba-btn-save">Speichern & Neuladen</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('ba_cancel').onclick = () => overlay.remove();

        document.getElementById('ba_save').onclick = async () => {
            const newSettings = {
                chunkSize: parseInt(document.getElementById('ba_chunkSize').value, 10) || 15,
                hotkeyNormal: document.getElementById('ba_hotkeyNormal').value || 'x',
                hotkeyNext: document.getElementById('ba_hotkeyNext').value || 's',
                progressPosition: document.getElementById('ba_progressPosition').value,
                validationDelay: parseInt(document.getElementById('ba_validationDelay').value, 10) || 2500,
                serialDelay: parseInt(document.getElementById('ba_serialDelay').value, 10) || 100
            };

            await saveSettingsDB(newSettings);
            overlay.remove();
            window.location.reload();
        };
    }

    // --- HELPER FUNKTIONEN ---
    function createProgressBar(position) {
        document.getElementById('profi-alarm-progress-bar')?.remove();
        const barContainer = document.createElement('div');
        barContainer.id = 'profi-alarm-progress-bar';
        Object.assign(barContainer.style, { position: 'fixed', backgroundColor: '#1e293b', border: '1px solid #334155', zIndex: '99999', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f8fafc', fontFamily: '-apple-system, sans-serif', fontSize: '14px', gap: '15px', fontWeight: '500' });
        const barFill = document.createElement('div');
        barFill.id = 'profi-alarm-progress-fill';
        Object.assign(barFill.style, { position: 'absolute', backgroundColor: '#3b82f6', transition: 'width 0.2s ease-in-out, height 0.2s ease-in-out' });
        const barText = document.createElement('span');
        barText.id = 'profi-alarm-progress-text';
        barText.style.position = 'relative';
        barText.textContent = 'Initialisiere...';
        switch (position) {
            case 'left': Object.assign(barContainer.style, { top: '0', left: '0', width: '20px', height: '100vh', flexDirection: 'column-reverse' }); Object.assign(barFill.style, { bottom: '0', left: '0', width: '100%', height: '0%' }); barText.style.display = 'none'; break;
            case 'right': Object.assign(barContainer.style, { top: '0', right: '0', width: '20px', height: '100vh', flexDirection: 'column-reverse' }); Object.assign(barFill.style, { bottom: '0', right: '0', width: '100%', height: '0%' }); barText.style.display = 'none'; break;
            case 'top': Object.assign(barContainer.style, { top: '0', left: '0', width: '100%', height: '30px' }); Object.assign(barFill.style, { top: '0', left: '0', width: '0%', height: '100%' }); break;
            case 'bottom': Object.assign(barContainer.style, { bottom: '0', left: '0', width: '100%', height: '30px' }); Object.assign(barFill.style, { top: '0', left: '0', width: '0%', height: '100%' }); break;
            default: Object.assign(barContainer.style, { bottom: '0', left: '0', width: '100%', height: '30px' }); Object.assign(barFill.style, { top: '0', left: '0', width: '0%', height: '100%' }); break;
        }
        barContainer.append(barFill, barText);
        document.body.appendChild(barContainer);
    }

    function updateProgressBar(text, percentage) {
        const bar = document.getElementById('profi-alarm-progress-bar');
        if (!bar) return;
        const fill = bar.querySelector('#profi-alarm-progress-fill');
        const textEl = bar.querySelector('#profi-alarm-progress-text');
        const position = ['left', 'right'].includes(bar.style.flexDirection) ? 'vertical' : 'horizontal';
        if(percentage !== undefined && percentage !== null){
            if (position === 'vertical') fill.style.height = `${percentage}%`;
            else fill.style.width = `${percentage}%`;
        }
        if(text !== null) textEl.textContent = text;
    }

    function gatekeeper(event, goToNext) {
        if (isAlarming) {
            console.warn("Ein Alarmierungsvorgang läuft bereits.");
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }

        const checkedCheckboxes = document.querySelectorAll('input.vehicle_checkbox:checked');
        const vehicleCount = new Set(Array.from(checkedCheckboxes).map(cb => cb.value)).size;

        if (vehicleCount > CHUNK_SIZE) {
            console.log(`Batch-Alarmierung aktiv: ${vehicleCount} Fahrzeuge (Limit > ${CHUNK_SIZE}).`);
            runProfiAlarm(event, goToNext, checkedCheckboxes);
        } else {
            console.log(`Batch-Alarmierung inaktiv: ${vehicleCount} Fahrzeuge (Limit nicht überschritten).`);
        }
    }

    function runProfiAlarm(event, goToNext, checkedCheckboxes) {
        isAlarming = true;
        event.preventDefault();
        event.stopImmediatePropagation();

        const vehicleIDs = Array.from(checkedCheckboxes).map(cb => cb.value);
        const uniqueVehicleIDs = [...new Set(vehicleIDs)];
        createProgressBar(PROGRESS_BAR_POSITION);

        const authToken = document.querySelector('input[name="authenticity_token"]')?.value;
        const pathParts = window.location.pathname.split('/');

        let targetId = pathParts[pathParts.length - 1];
        let postUrl = '';
        let nextMissionValue = '0';
        let nextMissionUrl = null;

        if (isBSR) {
            targetId = pathParts[2];
            postUrl = `/buildings/alarm/${targetId}`;
        } else {
            targetId = pathParts[2];
            postUrl = `/missions/${targetId}/alarm`;
            const checkboxState = document.getElementById('mission_next_mission_chk')?.checked;
            nextMissionValue = goToNext || checkboxState ? '1' : '0';
            const nextMissionButton = document.getElementById('mission_next_mission_btn');
            nextMissionUrl = nextMissionButton ? nextMissionButton.href : null;
        }

        if (!targetId || !authToken) {
            alert("Fehler: Konnte Einsatz/BSR-ID oder Auth-Token nicht auslesen!");
            isAlarming = false;
            return;
        }

        manageAlarmProcess(uniqueVehicleIDs, authToken, targetId, postUrl, nextMissionValue, nextMissionUrl, checkedCheckboxes);
    }

    async function sendBatches(ids, token, postUrl, nextMission) {
        const chunks = [];
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) { chunks.push(ids.slice(i, i + CHUNK_SIZE)); }

        updateProgressBar(`Phase 1/2: Sende ${chunks.length} Blöcke...`, 0);
        let chunksDispatched = 0;

        for (const [index, chunk] of chunks.entries()) {
            const postData = new URLSearchParams();
            postData.append('utf8', '✓');
            postData.append('authenticity_token', token);
            chunk.forEach(id => postData.append('vehicle_ids[]', id));

            if (!isBSR) {
                postData.append('next_mission', nextMission);
            }

            // Fire & Forget: Wir schicken den Request los, warten aber nicht auf die Antwort
            fetch(postUrl, { method: 'POST', body: postData }).catch(() => {});

            chunksDispatched++;
            updateProgressBar(`Phase 1/2: Sende Block ${chunksDispatched}/${chunks.length}...`, (chunksDispatched / chunks.length) * 50);

            if (chunksDispatched < chunks.length) {
                await new Promise(resolve => setTimeout(resolve, SERIAL_DELAY_MS));
            }
        }
    }

    async function validateDispatchedVehicles(originalSentIDs) {
        updateProgressBar(`Phase 2/2: Warte ${VALIDATION_DELAY_MS}ms auf Server-Verarbeitung...`, 50);
        await new Promise(resolve => setTimeout(resolve, VALIDATION_DELAY_MS));

        updateProgressBar("Prüfe alarmierte Fahrzeuge...", 90);
        const validationResponse = await fetch(window.location.href);
        const freshHtml = await validationResponse.text();
        const tempDoc = new DOMParser().parseFromString(freshHtml, 'text/html');
        let successfullyDispatchedIDs = new Set();

        if (isBSR) {
            const remainingCheckboxes = tempDoc.querySelectorAll('input.vehicle_checkbox');
            const remainingIDs = new Set(Array.from(remainingCheckboxes).map(cb => cb.value));

            originalSentIDs.forEach(id => {
                if (!remainingIDs.has(id)) successfullyDispatchedIDs.add(id);
            });
        } else {
            const drivingTable = tempDoc.getElementById("mission_vehicle_driving");
            if (drivingTable) {
                drivingTable.querySelectorAll("a[vehicle_id]").forEach(link => {
                    successfullyDispatchedIDs.add(link.getAttribute('vehicle_id'));
                });
            }
        }

        const failedIDs = originalSentIDs.filter(id => !successfullyDispatchedIDs.has(id));
        return { failedIDs, success: failedIDs.length === 0 };
    }

    function showCustomConfirm(title, failedVehicles) {
        return new Promise(resolve => {
            document.getElementById('ba-modal-overlay')?.remove();

            const overlay = document.createElement('div');
            overlay.id = 'ba-modal-overlay';
            Object.assign(overlay.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', background: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(5px)', zIndex: '100000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, sans-serif' });

            const modal = document.createElement('div');
            Object.assign(modal.style, { background: '#1e293b', color: '#f8fafc', padding: '32px', borderRadius: '12px', width: '600px', maxWidth: '95%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', border: '1px solid #334155', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.75)' });

            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            Object.assign(titleEl.style, { marginTop: '0', color: '#ef4444', borderBottom: '1px solid #334155', paddingBottom: '16px', fontSize: '1.4rem' });

            const vehicleList = document.createElement('div');
            Object.assign(vehicleList.style, { overflowY: 'auto', background: '#0f172a', border: '1px solid #334155', borderRadius: '8px', padding: '16px', margin: '20px 0', flexGrow: '1' });

            failedVehicles.forEach(v => {
                const p = document.createElement('p');
                Object.assign(p.style, { margin: '8px 0', fontSize: '1rem' });
                const link = document.createElement('a');
                link.href = `https://www.leitstellenspiel.de/vehicles/${v.id}`;
                link.textContent = `${v.name} (ID: ${v.id})`;
                link.target = '_blank';
                Object.assign(link.style, { color: '#60a5fa', textDecoration: 'none' });
                p.appendChild(link);
                vehicleList.appendChild(p);
            });

            const buttonArea = document.createElement('div');
            Object.assign(buttonArea.style, { display: 'flex', justifyContent: 'flex-end', gap: '14px', marginTop: '12px' });

            const createButton = (text, value, bgHover, bgColor) => {
                const btn = document.createElement('button');
                btn.textContent = text;
                Object.assign(btn.style, { padding: '10px 20px', border: 'none', borderRadius: '8px', color: '#fff', backgroundColor: bgColor, cursor: 'pointer', fontSize: '1rem', fontWeight: '500', transition: 'background 0.2s' });
                btn.onmouseover = () => btn.style.backgroundColor = bgHover;
                btn.onmouseout = () => btn.style.backgroundColor = bgColor;
                btn.onclick = () => { overlay.remove(); resolve(value); };
                return btn;
            };

            buttonArea.append(
                createButton('Erneut versuchen', 'retry', '#1d4ed8', '#2563eb'),
                createButton('Ignorieren & Weiter', 'ignore', '#15803d', '#16a34a'),
                createButton('Abbrechen', 'cancel', '#334155', '#475569')
            );

            modal.append(titleEl, vehicleList, buttonArea);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
        });
    }

    async function manageAlarmProcess(idsToAlarm, token, targetId, postUrl, nextMission, nextMissionUrl, originalCheckboxes) {
        await sendBatches(idsToAlarm, token, postUrl, nextMission);
        let validationResult = await validateDispatchedVehicles(idsToAlarm);

        if (!validationResult.success) {
            updateProgressBar(`Alarmiere ${validationResult.failedIDs.length} fehlende Fahrzeuge nach...`, 90);
            await sendBatches(validationResult.failedIDs, token, postUrl, nextMission);
            validationResult = await validateDispatchedVehicles(idsToAlarm);
        }

        let finalFailedIDs = validationResult.failedIDs;
        while (finalFailedIDs.length > 0) {
            const failedVehicleDetails = finalFailedIDs.map(id => {
                const checkbox = Array.from(originalCheckboxes).find(cb => cb.value === id);
                const row = checkbox ? checkbox.closest('tr') : null;
                const vehicleName = row ? row.getAttribute('vehicle_caption') : 'Unbekanntes Fahrzeug';
                return { id, name: vehicleName };
            });

            const userChoice = await showCustomConfirm(`Es konnten ${finalFailedIDs.length} Fahrzeuge nicht validiert werden:`, failedVehicleDetails);

            switch (userChoice) {
                case 'retry':
                    await sendBatches(finalFailedIDs.map(v => v.id), token, postUrl, nextMission);
                    validationResult = await validateDispatchedVehicles(idsToAlarm);
                    finalFailedIDs = validationResult.failedIDs;
                    break;
                case 'ignore':
                    finalFailedIDs = [];
                    break;
                case 'cancel':
                    document.getElementById('profi-alarm-progress-bar')?.remove();
                    isAlarming = false;
                    return;
            }
        }

        updateProgressBar("Fertig! Lade Seite neu...", 100);
        originalCheckboxes.forEach(checkbox => checkbox.checked = false);
        await new Promise(resolve => setTimeout(resolve, 1000));
        isAlarming = false;

        if (!isBSR && nextMission === '1' && nextMissionUrl) {
            window.location.href = nextMissionUrl;
        } else {
            window.location.reload();
        }
    }

    // --- EVENT LISTENERS ---
    if (!isBSRAlarmView) {
        document.addEventListener('click', (e) => {
            const alarmBtn = e.target.closest('#mission_alarm_btn') ||
                             (isBSR && e.target.matches('form[action*="alarm"] input[type="submit"]'));

            const nextBtn = e.target.closest('.alert_next');
            if (alarmBtn) gatekeeper(e, false);
            else if (nextBtn && !isBSR) gatekeeper(e, true);
        }, true);

        document.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            if (key === ALARM_HOTKEY_NORMAL) gatekeeper(e, false);
            else if (key === ALARM_HOTKEY_NEXT && !isBSR) gatekeeper(e, true);
        }, true);

        // Initialisierung
        injectConfigButton();
        setTimeout(injectConfigButton, 1000);
    }

})();
