// ==UserScript==
// @name         Torn Multi-Player Watcher v8.2
// @namespace    https://www.torn.com/
// @version      0.8.2
// @description  Multi-player Torn watcher with draggable panel, local-only key storage, manual custom-key guidance, browser troubleshooting help, player-name lookup, clearer ID validation, current status display, persistent watched players while hidden, remove-all watched players, and blue/red/green status colors.
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// ==/UserScript==

// README / QUICK INSTALL
// 1) Install this script in Tampermonkey and open Torn.
// 2) If the panel does not appear, open the Tampermonkey menu and use "Show panel".
// 3) In the panel, click "Open Torn API docs" and then use Torn's Custom Key Builder.
// 4) In Torn, create a purple Custom key with these exact minimum selections:
//    - user: basic, profile
//    - faction: basic
// 5) Copy the created key, paste it into the panel, and click "Save API key".
// 6) Add one player ID, or import a faction using a player ID.
// 7) Allow browser notifications so travel / likely med-revive alerts can fire.
//
// NOTES
// - This script stores the API key only in Tampermonkey storage and masks it in the UI.
// - It does not send the key to any third-party server.
// - user/basic is used for status watching, user/profile for seed-player faction lookup,
//   and faction/basic for faction member import.
// - Travel destination is inferred from the current/previous status text when Torn exposes a country in that text.
// - Keep polling conservative to avoid Torn API rate limits.
// - Firefox may require extra Tampermonkey CSP settings on Torn.
// - Opera GX compatibility can depend on Tampermonkey / Chromium version support.

(function () {
  'use strict';

  const STORE = {
    apiKey: 'tmw82_api_key',
    pollMs: 'tmw82_poll_ms',
    watchers: 'tmw82_watchers',
    lastStates: 'tmw82_last_states',
    panelPos: 'tmw82_panel_pos',
    hidden: 'tmw82_hidden',
    minimized: 'tmw82_minimized'
  };

  const DEFAULT_POLL_MS = 15000;
  const MIN_POLL_MS = 10000;
  const MAX_REQUESTS_PER_MINUTE = 100;
  const API_DOCS_URL = 'https://www.torn.com/api.html#';
  const TM_HOMEPAGE = 'https://www.tampermonkey.net/';
  const TM_FIREFOX = 'https://www.tampermonkey.net/index.php?browser=firefox&locale=en';
  const TM_EDGE = 'https://www.tampermonkey.net/index.php?browser=edge&locale=en';
  const TM_OPERA = 'https://www.tampermonkey.net/index.php?browser=opera&locale=en';
  const TORN_FIREFOX_CSP_GUIDE = 'https://www.torn.com/forums.php?p=threads&f=67&t=16255988&b=0&a=0';

  let intervalHandle = null;
  let backoffUntil = 0;
  let dragState = null;
  let refs = {};

  const gmGet = (k, f) => GM_getValue(k, f);
  const gmSet = (k, v) => GM_setValue(k, v);
  const gmDel = (k) => GM_deleteValue(k);

  const getApiKey = () => gmGet(STORE.apiKey, '');
  const setApiKey = (key) => gmSet(STORE.apiKey, (key || '').trim());
  const hasApiKey = () => !!getApiKey();
  const getPollMs = () => Math.max(MIN_POLL_MS, Number(gmGet(STORE.pollMs, DEFAULT_POLL_MS)) || DEFAULT_POLL_MS);
  const setPollMs = (v) => gmSet(STORE.pollMs, Math.max(MIN_POLL_MS, Number(v) || DEFAULT_POLL_MS));
  const getWatchers = () => gmGet(STORE.watchers, []);
  const setWatchers = (v) => gmSet(STORE.watchers, v);
  const getLastStates = () => gmGet(STORE.lastStates, {});
  const setLastStates = (v) => gmSet(STORE.lastStates, v);
  const getPanelPos = () => gmGet(STORE.panelPos, { top: 90, left: 20 });
  const setPanelPos = (v) => gmSet(STORE.panelPos, v);
  const isHidden = () => !!gmGet(STORE.hidden, false);
  const setHidden = (v) => gmSet(STORE.hidden, !!v);
  const isMinimized = () => !!gmGet(STORE.minimized, false);
  const setMinimized = (v) => gmSet(STORE.minimized, !!v);

  function detectBrowser() {
    const ua = navigator.userAgent || '';
    const vendor = navigator.vendor || '';
    const isOperaGX = /OPR\//.test(ua) && /Opera|OPR/.test(ua);
    const isEdge = /Edg\//.test(ua);
    const isFirefox = /Firefox\//.test(ua);
    const isChrome = !isEdge && !isOperaGX && /Chrome\//.test(ua) && /Google Inc\.?/.test(vendor || 'Google Inc.');
    if (isOperaGX) return 'Opera GX';
    if (isEdge) return 'Edge';
    if (isFirefox) return 'Firefox';
    if (isChrome) return 'Chrome';
    return 'Other';
  }

  function browserHelpText(browserName = detectBrowser()) {
    const lines = [`Detected browser: ${browserName}`, '', 'Browser setup / if the panel is not showing:', ''];
    if (browserName === 'Chrome') {
      lines.push('Chrome:', '- Install Tampermonkey and confirm this script is enabled.', '- Reload Torn after installing or updating the script.', '- If the panel still does not show, open the Tampermonkey menu and use "Show panel".', '- If scripts suddenly stop working after a browser or extension update, reopen Tampermonkey settings and verify the extension is active.', `- Tampermonkey home: ${TM_HOMEPAGE}`);
    } else if (browserName === 'Edge') {
      lines.push('Edge:', '- Install Tampermonkey for Edge and confirm the script is enabled.', '- Reload Torn after installation or script updates.', '- If the panel is missing, open the Tampermonkey menu and use "Show panel".', `- Tampermonkey for Edge: ${TM_EDGE}`);
    } else if (browserName === 'Firefox') {
      lines.push('Firefox:', '- Install Tampermonkey and enable this script.', '- Reload Torn after installation or script updates.', '- If the panel still does not show, Firefox may be blocking script injection on Torn because of CSP.', '- In Tampermonkey settings, switch to Advanced config mode if needed, then review the Torn Firefox CSP guide.', '- The Torn guide discusses modifying CSP headers, whitelisting Torn, and enabling Tampermonkey in HTML CSP where needed.', `- Firefox Tampermonkey page: ${TM_FIREFOX}`, `- Torn Firefox CSP guide: ${TORN_FIREFOX_CSP_GUIDE}`);
    } else if (browserName === 'Opera GX') {
      lines.push('Opera GX:', '- Install Tampermonkey and confirm the script is enabled.', '- Reload Torn after installation or script updates.', '- If the panel is missing, open the Tampermonkey menu and use "Show panel".', '- Opera GX can have Tampermonkey compatibility issues depending on the Opera GX / Chromium version.', '- If the extension does not behave correctly, verify your Opera GX version supports the installed Tampermonkey build; older Opera GX versions may need a legacy-compatible approach.', `- Tampermonkey for Opera: ${TM_OPERA}`);
    } else {
      lines.push('Other browser:', '- This script is intended for Tampermonkey on Torn pages.', '- Confirm the userscript manager is installed, the script is enabled, and Torn is reloaded.', '- If the panel is still missing, use the script-manager menu to show the panel or try Chrome / Edge / Firefox with Tampermonkey.');
    }
    lines.push('', 'Common checks for any browser:', '- Make sure the script is enabled in Tampermonkey.', '- Confirm you are on a https://www.torn.com/ page.', '- Reload the page after installing or editing the script.', '- Open the Tampermonkey menu and use "Show panel" if it was hidden earlier.', '- If notifications do not appear, allow browser notifications for Torn.', '- If the panel still does not render, check the browser console for userscript or CSP errors.');
    return lines.join('\n');
  }

  function maskedKey() {
    const key = getApiKey();
    if (!key) return 'Not set';
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
  }

  function parsePlayerId(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const bracketMatch = raw.match(/\[(\d+)\]/);
    if (bracketMatch) return bracketMatch[1];
    const plainDigits = raw.match(/^\d+$/);
    if (plainDigits) return plainDigits[0];
    const trailingDigits = raw.match(/(\d+)$/);
    if (trailingDigits) return trailingDigits[1];
    return '';
  }

  function invalidIdMessage(raw) {
    return [
      `Could not read a valid player ID from: ${raw || '(empty input)'}`,
      'Use one of these formats:',
      '- 1234567',
      '- [1234567]',
      '- Player Name [1234567]',
      'Names by themselves are not enough; the script needs the numeric player ID.'
    ].join(' ');
  }

  function acceptedIdExamplesText() {
    return [
      'Player ID input examples:',
      '- Best: 1234567',
      '- Also accepted: [1234567]',
      '- Also accepted: Player Name [1234567]',
      '- The script extracts and uses the numeric player ID.',
      '- Names alone are not enough; the ID number is what Torn API uses.'
    ].join('\n');
  }

  function setupChecklistText() {
    return [
      'How to create the custom Torn key for this watcher:',
      '1) Click "Open Torn API docs".',
      '2) In Torn API docs, click "Custom Key Builder".',
      '3) Give the key a name such as "Torn Multi-Player Watcher".',
      '4) Choose exactly these minimum selections:',
      '   - user: basic, profile',
      '   - faction: basic',
      '5) Create the purple Custom key in Torn.',
      '6) Copy that key and paste it back into this panel.',
      '7) Click "Save API key".',
      '',
      'Minimum needed by this script:',
      '- user/basic: player status monitoring.',
      '- user/profile: seed-player faction lookup.',
      '- faction/basic: faction member import.',
      '',
      acceptedIdExamplesText(),
      '',
      'Travel destination note:',
      '- Destination is only shown when Torn status text exposes a country, such as "In XXX" or similar travel/location status text.',
      '- If Torn only reports a generic Traveling state at that moment, the watcher will notify travel without a destination.',
      '',
      browserHelpText()
    ].join('\n');
  }

  function mergeWatchers(existing, incoming) {
    const map = new Map(existing.map(x => [String(x.id), { id: String(x.id), name: x.name || `Player ${x.id}` }]));
    for (const item of incoming) map.set(String(item.id), { id: String(item.id), name: item.name || `Player ${item.id}` });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  function removeWatcher(id) {
    const watchers = getWatchers().filter(w => String(w.id) !== String(id));
    const last = getLastStates();
    delete last[String(id)];
    setWatchers(watchers);
    setLastStates(last);
    renderWatchers();
    renderStatus(`Removed ${id}. Watching ${watchers.length} player(s).`);
    restartWatcher();
  }

  function clearAllWatchers() {
    setWatchers([]);
    setLastStates({});
    renderWatchers();
    renderStatus('Cleared all watched players.');
    restartWatcher();
  }

  async function tornFetch(path) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key saved.');
    const now = Date.now();
    if (now < backoffUntil) throw new Error(`Backoff active for ${Math.ceil((backoffUntil - now) / 1000)}s`);
    const url = `https://api.torn.com${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (data.error) {
      if (Number(data.error.code) === 5) backoffUntil = Date.now() + 60000;
      throw new Error(`Torn API ${data.error.code}: ${data.error.error}`);
    }
    return data;
  }

  function normalizePlayerResponse(data, fallbackId) {
    const status = data?.status || {};
    const state = status.state || '';
    const description = status.description || status.details || '';
    return {
      id: String(data?.player_id || fallbackId || ''),
      name: data?.name || `Player ${fallbackId}`,
      state,
      description,
      color: status.color || '',
      until: Number(status.until || 0),
      traveling: /travel/i.test(state) || /travel/i.test(description),
      statusText: [state, description].filter(Boolean).join(' | ')
    };
  }

  function inferDestination(curr, prev) {
    const texts = [curr?.description, curr?.state, prev?.description, prev?.state].filter(Boolean);
    for (const text of texts) {
      const m1 = text.match(/\bIn\s+([A-Za-z .'-]+)$/i);
      if (m1) return m1[1].trim();
      const m2 = text.match(/\bto\s+([A-Za-z .'-]+)$/i);
      if (m2) return m2[1].trim();
      const m3 = text.match(/\bfrom\s+([A-Za-z .'-]+)$/i);
      if (m3) return m3[1].trim();
    }
    return '';
  }

  function notify(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, silent: false });
    console.log(`[TMW8.2] ${title}: ${body}`);
    renderStatus(`${title}: ${body}`);
  }

  async function ensureNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
  }

  async function fetchPlayerBasic(playerId) {
    const data = await tornFetch(`/user/${playerId}?selections=basic`);
    return normalizePlayerResponse(data, playerId);
  }

  async function fetchFactionIdForUser(playerId) {
    const data = await tornFetch(`/user/${playerId}?selections=profile`);
    const factionId = data?.faction?.faction_id || data?.faction?.factionID || data?.faction?.id || 0;
    if (!factionId) throw new Error(`No faction found for player ${playerId}.`);
    return Number(factionId);
  }

  async function fetchFactionMembers(factionId) {
    const data = await tornFetch(`/faction/${factionId}?selections=basic`);
    const members = data?.members || {};
    return Object.entries(members).map(([id, info]) => ({ id: String(id), name: info?.name || `Player ${id}` }));
  }

  function estimateRecommendedPollMs() {
    const watcherCount = getWatchers().length || 1;
    const safePerMinute = Math.max(1, Math.floor(MAX_REQUESTS_PER_MINUTE * 0.7));
    return Math.max(MIN_POLL_MS, Math.ceil((watcherCount * 60000) / safePerMinute));
  }

  function evaluateTransition(prev, curr) {
    if (!prev) return;
    const now = Math.floor(Date.now() / 1000);
    if (prev.state === 'Hospitalized' && Number(prev.until || 0) > now && curr.state === 'Okay') {
      notify('Likely med/Revived', `${curr.name} [${curr.id}] changed to OK before hospital timer ended.`);
    }
    if (!prev.traveling && curr.traveling) {
      const destination = inferDestination(curr, prev);
      const suffix = destination ? ` Destination: ${destination}.` : '';
      notify('Travelling', `${curr.name} [${curr.id}] started traveling.${suffix}`);
    }
  }

  async function runWatcherCycle() {
    const watchers = getWatchers();
    if (!watchers.length) return renderStatus('No watched players.');
    if (!hasApiKey()) return renderStatus('No API key set.');
    const lastStates = getLastStates();
    let processed = 0;
    for (const watcher of watchers) {
      try {
        const curr = await fetchPlayerBasic(watcher.id);
        const prev = lastStates[watcher.id] || null;
        evaluateTransition(prev, curr);
        lastStates[watcher.id] = curr;
        watcher.name = curr.name || watcher.name || `Player ${watcher.id}`;
        processed += 1;
      } catch (err) {
        renderStatus(`Issue for ${watcher.name || watcher.id}: ${err.message}`);
        if (/Backoff active|Torn API 5:/.test(err.message)) break;
      }
    }
    setWatchers(watchers);
    setLastStates(lastStates);
    renderStatus(`Checked ${processed}/${watchers.length}. Poll ${getPollMs()} ms. Suggested >= ${estimateRecommendedPollMs()} ms.`);
    renderWatchers();
  }

  async function restartWatcher() {
    if (intervalHandle) clearInterval(intervalHandle);
    await ensureNotificationPermission();
    await runWatcherCycle();
    intervalHandle = setInterval(runWatcherCycle, getPollMs());
    renderMeta();
  }

  function renderStatus(text) { if (refs.status) refs.status.textContent = text; }

  function statusInfoForWatcher(watcher) {
    const state = getLastStates()[String(watcher.id)] || null;
    if (!state) return { text: 'Status: not fetched yet', className: 'tmw82-sub' };
    const main = state.state || 'Unknown';
    const extra = state.description && state.description !== state.state ? ` — ${state.description}` : '';
    const text = `Status: ${main}${extra}`;
    let className = 'tmw82-sub';
    const isTravelBlue = /travel/i.test(main) || /travel/i.test(state.description || '') || /abroad/i.test(main) || /abroad/i.test(state.description || '');
    const isHospitalRed = /hospital/i.test(main) || /hospital/i.test(state.description || '');
    const isOkayGreen = /^okay$/i.test(main) && !isTravelBlue;
    if (isTravelBlue) className += ' tmw82-sub-travel';
    else if (isHospitalRed) className += ' tmw82-sub-hospital';
    else if (isOkayGreen) className += ' tmw82-sub-okay';
    return { text, className };
  }

  function renderMeta() {
    if (!refs.meta) return;
    refs.meta.innerHTML = [
      `API: ${maskedKey()}`,
      `Watching: ${getWatchers().length}`,
      `Poll: ${getPollMs()} ms`,
      `Suggested: ${estimateRecommendedPollMs()} ms`,
      `Browser: ${detectBrowser()}`
    ].join(' · ');
  }

  function renderWatchers() {
    const renderInto = (container) => {
      if (!container) return;
      container.innerHTML = '';
      for (const watcher of getWatchers()) {
        const row = document.createElement('div');
        row.className = 'tmw82-row';
        const textWrap = document.createElement('div');
        textWrap.className = 'tmw82-textwrap';
        const label = document.createElement('div');
        label.className = 'tmw82-label';
        label.textContent = `${watcher.name || `Player ${watcher.id}`} [${watcher.id}]`;
        const sub = document.createElement('div');
        const statusInfo = statusInfoForWatcher(watcher);
        sub.className = statusInfo.className;
        sub.textContent = statusInfo.text;
        textWrap.append(label, sub);
        row.appendChild(textWrap);
        if (container === refs.list) {
          const btn = document.createElement('button');
          btn.className = 'tmw82-btn tmw82-btn-danger';
          btn.textContent = 'Remove';
          btn.addEventListener('click', () => removeWatcher(watcher.id));
          row.appendChild(btn);
        }
        container.appendChild(row);
      }
    };
    renderInto(refs.list);
    renderInto(refs.hiddenList);
    renderMeta();
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function startDrag(e) {
    if (!refs.panel || e.target.closest('button,input,textarea,a')) return;
    const rect = refs.panel.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    document.addEventListener('pointermove', onDrag);
    document.addEventListener('pointerup', stopDrag);
  }
  function onDrag(e) {
    if (!dragState || !refs.panel) return;
    const maxLeft = window.innerWidth - refs.panel.offsetWidth;
    const maxTop = window.innerHeight - refs.panel.offsetHeight;
    const left = clamp(e.clientX - dragState.dx, 0, Math.max(0, maxLeft));
    const top = clamp(e.clientY - dragState.dy, 0, Math.max(0, maxTop));
    refs.panel.style.left = `${left}px`;
    refs.panel.style.top = `${top}px`;
    refs.panel.style.right = 'auto';
    setPanelPos({ top, left });
  }
  function stopDrag() {
    dragState = null;
    document.removeEventListener('pointermove', onDrag);
    document.removeEventListener('pointerup', stopDrag);
  }

  function updatePanelVisibility() {
    if (!refs.panel || !refs.body || !refs.minBtn || !refs.hideBtn || !refs.hiddenListWrap) return;
    const minimized = isMinimized();
    refs.body.style.display = minimized ? 'none' : 'flex';
    refs.hiddenListWrap.style.display = minimized ? 'block' : 'none';
    refs.minBtn.textContent = minimized ? 'Show' : 'Hide';
    refs.hideBtn.textContent = 'Close';
  }

  function injectStyles() {
    const css = `
      #tmw82-panel{position:fixed;z-index:999999;top:90px;left:20px;width:470px;max-width:calc(100vw - 24px);background:rgba(15,18,22,.97);color:#eef2f7;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35);backdrop-filter:blur(10px);font:13px/1.4 Inter,system-ui,sans-serif}
      #tmw82-panel *{box-sizing:border-box}
      .tmw82-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:grab}
      .tmw82-title{font-weight:700}
      .tmw82-body{padding:12px;display:flex;flex-direction:column;gap:10px}
      .tmw82-hidden-list-wrap{display:none;padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,.06)}
      .tmw82-hidden-caption{font-size:12px;color:#b7c2cf;margin-bottom:8px}
      .tmw82-meta,.tmw82-status,.tmw82-hint{font-size:12px;color:#b7c2cf}
      .tmw82-status,.tmw82-doc,.tmw82-hint,.tmw82-hidden-list{min-height:34px;padding:8px 10px;background:rgba(255,255,255,.05);border-radius:10px}
      .tmw82-doc{white-space:pre-wrap;max-height:300px;overflow:auto}
      .tmw82-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .tmw82-input,.tmw82-pass{width:100%;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#11161c;color:#eef2f7;outline:none}
      .tmw82-input:focus,.tmw82-pass:focus{border-color:#69a9ff}
      .tmw82-btn{padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1a2530;color:#eef2f7;cursor:pointer}
      .tmw82-btn:hover{background:#223243}
      .tmw82-btn-danger{background:#3c1f27}
      .tmw82-btn-danger:hover{background:#592736}
      .tmw82-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06)}
      .tmw82-row:first-child{border-top:none}
      .tmw82-textwrap{flex:1;min-width:0}
      .tmw82-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tmw82-sub{font-size:12px;color:#9fb0c2;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tmw82-sub-travel{color:#66b3ff}
      .tmw82-sub-hospital{color:#ff6b6b}
      .tmw82-sub-okay{color:#5fd37a}
      .tmw82-list{max-height:240px;overflow:auto;padding-right:2px}
      .tmw82-hidden-list{max-height:240px;overflow:auto;padding-right:2px}
      .tmw82-mini{display:flex;gap:8px;align-items:center}
      .tmw82-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .tmw82-link{color:#8cc2ff;text-decoration:none}
      .tmw82-link:hover{text-decoration:underline}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildPanel() {
    if (document.getElementById('tmw82-panel')) return;
    injectStyles();
    const panel = document.createElement('div');
    panel.id = 'tmw82-panel';
    const pos = getPanelPos();
    panel.style.top = `${pos.top}px`;
    panel.style.left = `${pos.left}px`;
    if (isHidden()) panel.style.display = 'none';
    panel.innerHTML = `
      <div class="tmw82-head"><div class="tmw82-title">Torn Watcher v8.2</div><div class="tmw82-mini"><button class="tmw82-btn" id="tmw82-min-toggle">Hide</button><button class="tmw82-btn" id="tmw82-hide">Close</button></div></div>
      <div class="tmw82-hidden-list-wrap" id="tmw82-hidden-list-wrap"><div class="tmw82-hidden-caption">Watched players</div><div class="tmw82-hidden-list" id="tmw82-hidden-list"></div></div>
      <div class="tmw82-body" id="tmw82-body">
        <div class="tmw82-meta" id="tmw82-meta"></div>
        <div class="tmw82-status" id="tmw82-status">Ready.</div>
        <div class="tmw82-hint" id="tmw82-id-hint"></div>
        <div class="tmw82-doc" id="tmw82-doc"></div>
        <div class="tmw82-grid"><a class="tmw82-btn tmw82-link" id="tmw82-open-api-docs" href="#" target="_blank" rel="noopener noreferrer">Open Torn API docs</a><button class="tmw82-btn" id="tmw82-copy-docs">Copy setup checklist</button></div>
        <div><input class="tmw82-pass" id="tmw82-api" type="password" placeholder="Paste Torn custom API key"></div>
        <div class="tmw82-grid"><button class="tmw82-btn" id="tmw82-save-key">Save API key</button><button class="tmw82-btn" id="tmw82-clear-key">Delete API key</button></div>
        <div class="tmw82-grid"><input class="tmw82-input" id="tmw82-player-id" placeholder="Player ID"><button class="tmw82-btn" id="tmw82-add-player">Add player</button></div>
        <div class="tmw82-grid"><input class="tmw82-input" id="tmw82-faction-seed" placeholder="Player ID for faction import"><button class="tmw82-btn" id="tmw82-add-faction">Add faction members</button></div>
        <div class="tmw82-grid"><input class="tmw82-input" id="tmw82-poll-ms" placeholder="Polling ms"><button class="tmw82-btn" id="tmw82-save-poll">Save poll rate</button></div>
        <div><button class="tmw82-btn tmw82-btn-danger" id="tmw82-clear-watchers">Remove all watched players</button></div>
        <div class="tmw82-list" id="tmw82-list"></div>
      </div>`;
    document.body.appendChild(panel);
    refs = {
      panel,
      body: panel.querySelector('#tmw82-body'),
      hiddenListWrap: panel.querySelector('#tmw82-hidden-list-wrap'),
      hiddenList: panel.querySelector('#tmw82-hidden-list'),
      meta: panel.querySelector('#tmw82-meta'),
      status: panel.querySelector('#tmw82-status'),
      list: panel.querySelector('#tmw82-list'),
      doc: panel.querySelector('#tmw82-doc'),
      idHint: panel.querySelector('#tmw82-id-hint'),
      apiInput: panel.querySelector('#tmw82-api'),
      playerInput: panel.querySelector('#tmw82-player-id'),
      factionInput: panel.querySelector('#tmw82-faction-seed'),
      pollInput: panel.querySelector('#tmw82-poll-ms'),
      minBtn: panel.querySelector('#tmw82-min-toggle'),
      hideBtn: panel.querySelector('#tmw82-hide')
    };
    refs.doc.textContent = setupChecklistText();
    refs.idHint.textContent = acceptedIdExamplesText();
    panel.querySelector('#tmw82-open-api-docs').setAttribute('href', API_DOCS_URL);
    panel.querySelector('#tmw82-copy-docs').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(setupChecklistText() + `\n\nTorn API docs:\n${API_DOCS_URL}`);
        renderStatus('Setup checklist copied to clipboard.');
      } catch (_) {
        renderStatus('Clipboard copy failed.');
      }
    });
    panel.querySelector('.tmw82-head').addEventListener('pointerdown', startDrag);
    refs.minBtn.addEventListener('click', () => { setMinimized(!isMinimized()); updatePanelVisibility(); });
    refs.hideBtn.addEventListener('click', () => { panel.style.display = 'none'; setHidden(true); });
    panel.querySelector('#tmw82-clear-watchers').addEventListener('click', () => {
      const total = getWatchers().length;
      if (!total) return renderStatus('No watched players to remove.');
      if (confirm(`Remove all ${total} watched players?`)) clearAllWatchers();
    });
    panel.querySelector('#tmw82-save-key').addEventListener('click', async () => {
      const key = refs.apiInput.value.trim();
      if (!key) return renderStatus('Enter an API key first.');
      setApiKey(key);
      refs.apiInput.value = '';
      renderMeta();
      renderStatus('API key saved in Tampermonkey storage only.');
      await restartWatcher();
    });
    panel.querySelector('#tmw82-clear-key').addEventListener('click', () => {
      gmDel(STORE.apiKey);
      renderMeta();
      renderStatus('Saved API key deleted.');
    });
    panel.querySelector('#tmw82-add-player').addEventListener('click', async () => {
      const raw = refs.playerInput.value.trim();
      const id = parsePlayerId(raw);
      if (!id) return renderStatus(invalidIdMessage(raw));
      try {
        let name = `Player ${id}`;
        let fetched = null;
        if (hasApiKey()) {
          fetched = await fetchPlayerBasic(id);
          name = fetched.name || name;
        }
        setWatchers(mergeWatchers(getWatchers(), [{ id, name }]));
        if (fetched) {
          const last = getLastStates();
          last[String(id)] = fetched;
          setLastStates(last);
        }
        refs.playerInput.value = '';
        renderWatchers();
        renderStatus(`Added ${name} [${id}].`);
        await restartWatcher();
      } catch (err) {
        renderStatus(`Could not add player ${id}: ${err.message}`);
      }
    });
    panel.querySelector('#tmw82-add-faction').addEventListener('click', async () => {
      const raw = refs.factionInput.value.trim();
      const id = parsePlayerId(raw);
      if (!id) return renderStatus(invalidIdMessage(raw));
      try {
        renderStatus(`Looking up faction for player ${id}...`);
        const factionId = await fetchFactionIdForUser(id);
        const members = await fetchFactionMembers(factionId);
        setWatchers(mergeWatchers(getWatchers(), members));
        refs.factionInput.value = '';
        renderWatchers();
        renderStatus(`Imported ${members.length} members from faction ${factionId}.`);
        await restartWatcher();
      } catch (err) {
        renderStatus(`Faction import failed: ${err.message}`);
      }
    });
    panel.querySelector('#tmw82-save-poll').addEventListener('click', async () => {
      const value = Number(refs.pollInput.value.trim());
      if (!Number.isFinite(value)) return renderStatus('Polling interval must be numeric.');
      setPollMs(value);
      refs.pollInput.value = '';
      renderMeta();
      renderStatus(`Polling interval saved: ${getPollMs()} ms.`);
      await restartWatcher();
    });
    refs.pollInput.value = String(getPollMs());
    renderWatchers();
    renderMeta();
    updatePanelVisibility();
  }

  function registerMenu() {
    GM_registerMenuCommand('Torn Watcher v8.2: Show panel', () => {
      buildPanel();
      refs.panel.style.display = 'block';
      setHidden(false);
      setMinimized(false);
      updatePanelVisibility();
    });
    GM_registerMenuCommand('Torn Watcher v8.2: Toggle panel body', () => {
      buildPanel();
      refs.panel.style.display = 'block';
      setHidden(false);
      setMinimized(!isMinimized());
      updatePanelVisibility();
    });
    GM_registerMenuCommand('Torn Watcher v8.2: Show setup checklist', () => alert(setupChecklistText()));
    GM_registerMenuCommand('Torn Watcher v8.2: Show browser help', () => alert(browserHelpText()));
    GM_registerMenuCommand('Torn Watcher v8.2: Open Torn API docs', () => window.open(API_DOCS_URL, '_blank', 'noopener,noreferrer'));
    GM_registerMenuCommand('Torn Watcher v8.2: Restart watcher', () => restartWatcher());
  }

  buildPanel();
  registerMenu();
  restartWatcher();
})();
