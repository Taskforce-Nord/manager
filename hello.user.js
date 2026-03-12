// ==UserScript==
// @name         Hello World Test
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Zeigt ein Alert auf jeder Seite, um die Funktion zu testen.
// @author       Dein Name
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    alert('Hello World! Tampermonkey läuft.');
})();
