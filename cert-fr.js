/* =============================================================================
   Cyberveille CERT-FR — portfolio BTS SIO SISR / KLEIN Vincent
   -----------------------------------------------------------------------------
   Source principale : data/cert-fr.js, charge par une balise <script>.
   Les bulletins sont donc toujours presents, meme si la page est ouverte
   par double-clic (protocole file://), sans aucune requete reseau.

   Rafraichissement : si la page est servie en HTTP, elle tente en arriere-plan
   de relire les flux RSS du CERT-FR via un relais CORS public. En cas d'echec,
   les donnees embarquees restent affichees : rien ne casse.
   ========================================================================== */

(function () {
    'use strict';

    /* ---------------------------------------------------------------- config */

    var FEEDS = [
        { url: 'https://www.cert.ssi.gouv.fr/alerte/feed/', type: 'alerte' },
        { url: 'https://www.cert.ssi.gouv.fr/avis/feed/', type: 'avis' },
        { url: 'https://www.cert.ssi.gouv.fr/actualite/feed/', type: 'actualite' },
        { url: 'https://www.cert.ssi.gouv.fr/cti/feed/', type: 'cti' }
    ];

    var PROXIES = [
        function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
        function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); },
        function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
    ];

    var LABELS = {
        alerte: 'Alerte', avis: 'Avis', actualite: 'Actualité',
        cti: 'Menaces CTI', ioc: 'IOC', dur: 'Durcissement', autre: 'Bulletin'
    };

    var MAX_ITEMS = 150;
    var FRESH_HOURS = 72;

    /* ------------------------------------------------------------------- DOM */

    var $console = document.getElementById('cert-console');
    var $list = document.getElementById('cert-list');
    var $source = document.getElementById('cert-source');
    var $search = document.getElementById('cert-search');
    var $filters = document.getElementById('cert-filters');
    var $refresh = document.getElementById('cert-refresh');

    var state = { items: [], filter: 'all', query: '', refreshing: false };

    /* --------------------------------------------------------------- helpers */

    function log(line, cls) {
        if (!$console) return;
        var span = document.createElement('span');
        if (cls) span.className = cls;
        span.textContent = line + '\n';
        $console.appendChild(span);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function stripTags(html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = String(html == null ? '' : html);
        return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function typeFromLink(link) {
        var l = String(link || '').toLowerCase();
        if (l.indexOf('/alerte/') > -1) return 'alerte';
        if (l.indexOf('/avis/') > -1) return 'avis';
        if (l.indexOf('/actualite/') > -1) return 'actualite';
        if (l.indexOf('/cti/') > -1) return 'cti';
        if (l.indexOf('/ioc/') > -1) return 'ioc';
        if (l.indexOf('/dur/') > -1) return 'dur';
        return 'autre';
    }

    function idFromLink(link) {
        var m = String(link || '').match(/CERTFR-\d{4}-[A-Z]{3}-\d+/i);
        return m ? m[0].toUpperCase() : '';
    }

    function cleanTitle(title) {
        return String(title || '').replace(/\s*\((?:\d{1,2}\s+\S+\s+\d{4})\)\s*$/, '').trim();
    }

    function parseDate(value) {
        var d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    function formatDate(d) {
        if (!d) return '';
        try {
            return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch (e) {
            return d.toISOString().slice(0, 10);
        }
    }

    function hoursSince(d) {
        return d ? (Date.now() - d.getTime()) / 3600000 : Infinity;
    }

    function relativeTime(d) {
        var h = hoursSince(d);
        if (h < 1) return "à l'instant";
        if (h < 24) return 'il y a ' + Math.round(h) + ' h';
        return 'il y a ' + Math.round(h / 24) + ' j';
    }

    function fetchWithTimeout(url, ms) {
        if (typeof AbortController === 'undefined') return fetch(url, { cache: 'no-store' });
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, ms || 9000);
        return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
            .then(function (r) { clearTimeout(timer); return r; })
            .catch(function (e) { clearTimeout(timer); throw e; });
    }

    /* ------------------------------------------------------------ RSS parser */

    function parseRss(xmlText, fallbackType) {
        var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('XML invalide');

        var nodes = doc.getElementsByTagName('item');
        if (!nodes.length) nodes = doc.getElementsByTagName('entry');
        if (!nodes.length) throw new Error('flux vide');

        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var get = function (tag) {
                var el = n.getElementsByTagName(tag)[0];
                return el ? (el.textContent || '').trim() : '';
            };

            var link = get('link');
            if (!link) {
                var a = n.getElementsByTagName('link')[0];
                if (a && a.getAttribute) link = a.getAttribute('href') || '';
            }

            var title = get('title');
            if (!title) continue;

            var detected = typeFromLink(link);
            out.push({
                title: cleanTitle(title),
                link: link,
                date: get('pubDate') || get('updated') || get('published') || '',
                description: stripTags(get('description') || get('summary')),
                type: detected !== 'autre' ? detected : (fallbackType || 'autre'),
                id: idFromLink(link)
            });
        }
        return out;
    }

    /* ------------------------------------------------ rafraichissement direct */

    function loadFromProxies() {
        var proxyIndex = 0;

        function tryProxy() {
            if (proxyIndex >= PROXIES.length) throw new Error('relais indisponibles');
            var build = PROXIES[proxyIndex++];

            var jobs = FEEDS.map(function (feed) {
                return fetchWithTimeout(build(feed.url), 11000)
                    .then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.text();
                    })
                    .then(function (txt) { return parseRss(txt, feed.type); })
                    .catch(function () { return []; });
            });

            return Promise.all(jobs).then(function (results) {
                var merged = [];
                results.forEach(function (arr) { merged = merged.concat(arr); });
                if (!merged.length) return tryProxy();
                return merged;
            });
        }

        return Promise.resolve().then(tryProxy);
    }

    /* ----------------------------------------------------------- préparation */

    function normalise(items) {
        var seen = {};
        var out = [];

        items.forEach(function (it) {
            var key = it.link || it.title;
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push({
                title: it.title,
                link: it.link,
                description: it.description || '',
                type: it.type || typeFromLink(it.link),
                id: it.id || idFromLink(it.link),
                _date: parseDate(it.date)
            });
        });

        out.sort(function (a, b) {
            return (b._date ? b._date.getTime() : 0) - (a._date ? a._date.getTime() : 0);
        });

        return out.slice(0, MAX_ITEMS);
    }

    /* ------------------------------------------------------------- affichage */

    function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function updateStats() {
        var alertes = 0, avis = 0, semaine = 0;
        state.items.forEach(function (it) {
            if (it.type === 'alerte') alertes++;
            if (it.type === 'avis') avis++;
            if (hoursSince(it._date) <= 168) semaine++;
        });
        setText('stat-alertes', alertes);
        setText('stat-avis', avis);
        setText('stat-semaine', semaine);
        setText('stat-total', state.items.length);
    }

    function visibleItems() {
        var q = state.query.toLowerCase();
        return state.items.filter(function (it) {
            if (state.filter !== 'all' && it.type !== state.filter) return false;
            if (!q) return true;
            return (it.title + ' ' + it.description + ' ' + it.id).toLowerCase().indexOf(q) > -1;
        });
    }

    function render() {
        if (!$list) return;
        var items = visibleItems();

        if (!items.length) {
            $list.innerHTML = '<li><div class="cert-empty">Aucun bulletin ne correspond à ce filtre. ' +
                'Essayez un autre mot-clé ou revenez sur « Tout ».</div></li>';
            return;
        }

        $list.innerHTML = items.map(function (it) {
            var type = it.type || 'autre';
            var fresh = hoursSince(it._date) <= FRESH_HOURS ? ' is-fresh' : '';
            var desc = it.description
                ? '<div class="cert-item-desc">' + escapeHtml(it.description.slice(0, 220)) +
                  (it.description.length > 220 ? '…' : '') + '</div>'
                : '';

            return '<li>' +
                '<a class="cert-item type-' + escapeHtml(type) + fresh + '" href="' + escapeHtml(it.link) +
                '" target="_blank" rel="noopener noreferrer">' +
                '<div class="cert-item-meta">' +
                '<span class="cert-badge">' + escapeHtml(LABELS[type] || LABELS.autre) + '</span>' +
                (it.id ? '<span class="cert-id">' + escapeHtml(it.id) + '</span>' : '') +
                '<span class="cert-date">' + escapeHtml(formatDate(it._date)) + '</span>' +
                '</div>' +
                '<div class="cert-item-title">' + escapeHtml(it.title) + '</div>' +
                desc +
                '</a></li>';
        }).join('');
    }

    function showSource(origin, when) {
        if (!$source) return;
        if (origin === 'direct') {
            $source.innerHTML = '<span class="ok">&#9679;</span> Bulletins relus en direct depuis les flux du CERT-FR ' +
                '(ANSSI), ' + escapeHtml(relativeTime(when)) + '.';
        } else {
            $source.innerHTML = '<span class="ok">&#9679;</span> Bulletins du CERT-FR (ANSSI), ' +
                'instantané du ' + escapeHtml(formatDate(when)) + '.';
        }
    }

    function apply(items, origin, when) {
        state.items = normalise(items);
        updateStats();
        render();
        showSource(origin, when);
    }

    /* ------------------------------------------------------------ chargement */

    function boot() {
        if ($console) $console.textContent = '';   // efface le texte de départ du HTML
        var embedded = window.CERT_FR_DATA;

        if (embedded && embedded.items && embedded.items.length) {
            var when = parseDate(embedded.generatedAt);
            apply(embedded.items, 'embarque', when);
            log('[*] Module de veille CERT-FR (ANSSI).');
            log('[+] ' + state.items.length + ' bulletins chargés — instantané du ' + formatDate(when) + '.', 'ok');
        } else {
            log('[*] Module de veille CERT-FR (ANSSI).');
            log('[!] Aucune donnée embarquée, tentative de lecture directe...', 'warn');
        }

        refresh(true);
    }

    function refresh(silent) {
        if (state.refreshing) return;
        state.refreshing = true;

        if (!silent) log('[~] Relecture des flux du CERT-FR...', 'warn');

        loadFromProxies()
            .then(function (items) {
                apply(items, 'direct', new Date());
                log('[+] Flux relu en direct : ' + state.items.length + ' bulletins à jour.', 'ok');
                state.refreshing = false;
            })
            .catch(function () {
                if (state.items.length) {
                    log('[i] Lecture en direct indisponible — instantané local conservé.', 'warn');
                } else {
                    log('[x] Aucune donnée disponible.', 'ko');
                    if ($list) {
                        $list.innerHTML = '<li><div class="cert-empty">Bulletins indisponibles pour le moment.</div></li>';
                    }
                }
                state.refreshing = false;
            });
    }

    /* ---------------------------------------------------------- interactions */

    if ($filters) {
        $filters.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('.cert-chip') : null;
            if (!btn) return;
            state.filter = btn.getAttribute('data-filter');
            var chips = $filters.querySelectorAll('.cert-chip');
            for (var i = 0; i < chips.length; i++) {
                chips[i].setAttribute('aria-pressed', chips[i] === btn ? 'true' : 'false');
            }
            render();
        });
    }

    if ($search) {
        var timer = null;
        $search.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                state.query = $search.value.trim();
                render();
            }, 180);
        });
    }

    if ($refresh) {
        $refresh.addEventListener('click', function () {
            $refresh.disabled = true;
            $refresh.textContent = 'Actualisation...';
            refresh(false);
            setTimeout(function () {
                $refresh.disabled = false;
                $refresh.textContent = 'Actualiser le flux';
            }, 3000);
        });
    }

    boot();
})();
