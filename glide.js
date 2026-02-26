// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 3.0.0
// DESCRIPTION: AuraMix — Apple Music-style transitions. Smart early skip using Spotify audio analysis (BPM, key, loudness). Spotify's native crossfade handles all audio mixing. Zero volume manipulation.

/// <reference path="../cli/globals.d.ts" />

(async function Glide() {
    // ─── Wait for Spicetify APIs ─────────────────────────────────────
    if (
        !Spicetify?.Player?.addEventListener ||
        !Spicetify?.Player?.getProgress ||
        !Spicetify?.Player?.getDuration ||
        !Spicetify?.Player?.next ||
        !Spicetify?.Player?.isPlaying ||
        !Spicetify?.Playbar ||
        !Spicetify?.PopupModal ||
        !Spicetify?.LocalStorage ||
        !Spicetify?.getAudioData ||
        !Spicetify?.Queue
    ) {
        setTimeout(Glide, 300);
        return;
    }

    // ─── Logger ──────────────────────────────────────────────────────
    const TAG = "[Glide]";
    const log = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err = (...a) => console.error(TAG, ...a);

    // ─── Constants ───────────────────────────────────────────────────
    const STORE = { ENABLED: "glide:enabled", TIMING: "glide:timing" };
    const DEFAULT_TIMING = 5;    // seconds
    const MIN_TIMING = 1;
    const MAX_TIMING = 15;
    const HEARTBEAT_MS = 400;
    const MIN_TRACK_MS = 30000;
    const BPM_TOLERANCE = 0.05; // ±5%

    // ─── Camelot Wheel ───────────────────────────────────────────────
    // Maps Spotify's pitch class integers to Camelot numbers for harmonic key matching.
    const CAMELOT = [
        { n: 8, l: "B" }, // 0  C
        { n: 3, l: "B" }, // 1  C#
        { n: 10, l: "B" }, // 2  D
        { n: 5, l: "B" }, // 3  D#
        { n: 12, l: "B" }, // 4  E
        { n: 7, l: "B" }, // 5  F
        { n: 2, l: "B" }, // 6  F#
        { n: 9, l: "B" }, // 7  G
        { n: 4, l: "B" }, // 8  G#
        { n: 11, l: "B" }, // 9  A
        { n: 6, l: "B" }, // 10 A#
        { n: 1, l: "B" }, // 11 B
    ];
    function toCamelot(key, mode) {
        if (key < 0 || key > 11) return null;
        return { n: CAMELOT[key].n, l: mode === 1 ? "B" : "A" };
    }
    function camelotMatch(a, b) {
        if (!a || !b) return false;
        if (a.n === b.n && a.l === b.l) return true;                         // same key
        if (a.l === b.l && Math.abs(a.n - b.n) <= 1) return true;            // ±1 adjacent
        if (a.l === b.l && Math.max(a.n, b.n) === 12 && Math.min(a.n, b.n) === 1) return true; // wrap
        if (a.n === b.n && a.l !== b.l) return true;                         // parallel key
        return false;
    }

    // ─── State ───────────────────────────────────────────────────────
    let isEnabled = true;
    let timingSec = DEFAULT_TIMING;
    let hasSkipped = false;             // Prevents double-triggering
    let currentSongUri = null;
    let currentTriggerMs = null;           // Calculated smart trigger in ms
    let currentCompatResult = null;
    const analysisCache = new Map();        // uri → AnalysisResult
    let nextTrackUri = null;
    let nextTrackAnalysis = null;

    // ─── Settings ────────────────────────────────────────────────────
    function loadSettings() {
        try {
            const e = Spicetify.LocalStorage.get(STORE.ENABLED);
            if (e !== null) isEnabled = e === "true";
            const t = Spicetify.LocalStorage.get(STORE.TIMING);
            if (t !== null) {
                const v = parseFloat(t);
                if (!isNaN(v) && v >= MIN_TIMING && v <= MAX_TIMING) timingSec = v;
            }
            log("Loaded:", { isEnabled, timingSec });
        } catch (ex) { err("loadSettings:", ex); }
    }
    function saveSettings() {
        try {
            Spicetify.LocalStorage.set(STORE.ENABLED, String(isEnabled));
            Spicetify.LocalStorage.set(STORE.TIMING, String(timingSec));
        } catch (ex) { err("saveSettings:", ex); }
    }

    // ─── Auto-Enable Spotify Native Crossfade ────────────────────────
    //
    // Spotify already has a built-in crossfade engine (see Settings → Playback).
    // When crossfade is enabled and we call Player.next() EARLY, both Song A
    // and Song B overlap at the audio engine level — exactly like Apple Music.
    //
    // We try to enable this silently in the background so the user never needs
    // to touch Spotify's settings manually.
    //
    async function autoEnableCrossfade() {
        const ms = Math.round(timingSec * 1000);
        // Method 1: Direct player prefs
        try {
            const prefs = Spicetify.Platform?.PlayerAPI?._prefs;
            if (prefs?.setCrossfade) { prefs.setCrossfade(true, ms); log("✅ Crossfade via PlayerAPI._prefs"); return; }
        } catch (_) { }
        // Method 2: Cosmos async
        try {
            await Spicetify.CosmosAsync.post("sp://player/v2/main", { crossfade: { enabled: true, duration_ms: ms } });
            log("✅ Crossfade via cosmos");
            return;
        } catch (_) { }
        // Method 3: Connect API
        try {
            await Spicetify.CosmosAsync.put("sp://connect/v1/player/crossfade", { enabled: true, duration_ms: ms });
            log("✅ Crossfade via connect");
            return;
        } catch (_) { }
        warn("Could not auto-enable crossfade. Enable manually: Spotify Settings → Playback → Crossfade songs.");
    }

    // ─── Audio Analysis ───────────────────────────────────────────────
    async function analyzeTrack(uri) {
        if (!uri) return null;
        if (analysisCache.has(uri)) return analysisCache.get(uri);
        let raw;
        try { raw = await Spicetify.getAudioData(uri); }
        catch (ex) { warn("getAudioData:", ex.message); return null; }
        if (!raw) return null;

        const track = raw.track || {};
        const sections = raw.sections || [];
        const bars = raw.bars || [];

        // Find outro: last section whose loudness is below the track average
        const avgLoudness = sections.reduce((s, x) => s + (x.loudness || 0), 0) / (sections.length || 1);
        const outroSection = sections.slice().reverse().find(s => s.loudness <= avgLoudness)
            || sections[sections.length - 1];

        const result = {
            tempo: track.tempo || 120,
            key: track.key ?? -1,
            mode: track.mode ?? 1,
            camelot: toCamelot(track.key ?? -1, track.mode ?? 1),
            outroStart: outroSection ? Math.round(outroSection.start * 1000) : null,
            bars,
        };
        analysisCache.set(uri, result);
        log(`🎵 ${uri.split(":")?.[2]?.slice(-6)} | BPM=${result.tempo.toFixed(1)} | Camelot=${JSON.stringify(result.camelot)} | Outro@${result.outroStart}ms`);
        return result;
    }

    function checkCompat(a, b) {
        if (!a || !b) return { bpmMatch: false, keyMatch: false };
        const bpmMatch = Math.abs(a.tempo - b.tempo) / a.tempo <= BPM_TOLERANCE;
        const keyMatch = camelotMatch(a.camelot, b.camelot);
        log(`🔍 BPM ${bpmMatch ? "✓" : "✗"} (${a.tempo.toFixed(1)}↔${b.tempo.toFixed(1)}) | Key ${keyMatch ? "✓" : "✗"}`);
        return { bpmMatch, keyMatch };
    }

    // ─── Smart Trigger ────────────────────────────────────────────────
    // Determines the ms position in Song A at which to call Player.next().
    // Priority: beat-boundary → outro section → fixed fallback.
    function calcTrigger(analysis, compat, durationMs) {
        if (!analysis || !durationMs) return null;
        const timingMs = timingSec * 1000;

        // Beat-synced: snap to the last bar boundary before (end - timingMs)
        if (compat?.bpmMatch && analysis.bars.length > 0) {
            const target = durationMs - timingMs;
            let bestBar = null;
            for (const bar of analysis.bars) {
                const bMs = Math.round(bar.start * 1000);
                if (bMs <= target) bestBar = bMs;
            }
            if (bestBar !== null) { log(`🥁 Beat trigger: ${bestBar}ms`); return bestBar; }
        }

        // Outro section: natural musical fade point
        if (analysis.outroStart && analysis.outroStart < durationMs - 2000) {
            log(`🎼 Outro trigger: ${analysis.outroStart}ms`);
            return analysis.outroStart;
        }

        // Simple fallback
        const fb = Math.max(0, durationMs - timingMs);
        log(`⏱ Fallback trigger: ${fb}ms`);
        return fb;
    }

    // ─── Execute Skip ────────────────────────────────────────────────
    // This is ALL we do. Spotify's native crossfade handles the rest.
    function executeSkip() {
        hasSkipped = true;
        const remaining = (Spicetify.Player.getDuration() - Spicetify.Player.getProgress()) / 1000;
        log(`⏭ EARLY SKIP | Song A has ${remaining.toFixed(1)}s left | Spotify crossfade mixes audio`);
        try { Spicetify.Player.next(); }
        catch (ex) { err("next() failed:", ex); hasSkipped = false; }
    }

    // ─── Pre-fetch & Plan ─────────────────────────────────────────────
    async function prefetchNext() {
        const queue = Spicetify.Queue?.nextTracks;
        if (!queue?.length) { nextTrackUri = null; nextTrackAnalysis = null; return; }
        const c = queue[0];
        const uri = c?.uri || c?.track?.uri || c?.contextTrack?.uri;
        if (!uri || uri === nextTrackUri) return;
        nextTrackUri = uri;
        nextTrackAnalysis = await analyzeTrack(uri);
    }

    async function planTransition() {
        hasSkipped = false;
        currentTriggerMs = null;
        currentCompatResult = null;
        const uri = Spicetify.Player?.data?.item?.uri;
        const duration = Spicetify.Player.getDuration();
        if (!duration || duration < MIN_TRACK_MS) return;
        const analysisA = await analyzeTrack(uri);
        await prefetchNext();
        const compat = checkCompat(analysisA, nextTrackAnalysis);
        currentCompatResult = compat;
        currentTriggerMs = calcTrigger(analysisA, compat, duration);
        log(`📋 Plan | trigger=${currentTriggerMs}ms | duration=${duration}ms`);
    }

    // ─── Progress Monitor ─────────────────────────────────────────────
    function checkProgress() {
        if (!isEnabled || hasSkipped) return;
        if (!Spicetify.Player.isPlaying()) return;
        let progress, duration;
        try { progress = Spicetify.Player.getProgress(); duration = Spicetify.Player.getDuration(); }
        catch (_) { return; }
        if (!duration || duration < MIN_TRACK_MS || progress < 3000) return;
        if (currentTriggerMs !== null) {
            if (progress >= currentTriggerMs) executeSkip();
            return;
        }
        if (duration - progress <= timingSec * 1000) executeSkip();
    }

    function onSongChange() {
        const uri = Spicetify.Player?.data?.item?.uri;
        if (uri === currentSongUri) return;
        currentSongUri = uri;
        log("🎵 New track:", uri?.split(":")?.[2]?.slice(-6));
        planTransition();
    }

    setInterval(checkProgress, HEARTBEAT_MS);
    Spicetify.Player.addEventListener("onprogress", checkProgress);
    Spicetify.Player.addEventListener("songchange", onSongChange);

    // ─── Icons ───────────────────────────────────────────────────────
    const ICON_ON = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/><circle cx="13" cy="4" r="2" fill="#1DB954"/></svg>`;
    const ICON_OFF = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor"><path opacity=".4" d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/></svg>`;

    // ─── Playbar Button ───────────────────────────────────────────────
    let pb = null;
    function updatePb() {
        if (!pb) return;
        try { pb.active = isEnabled; pb.icon = isEnabled ? ICON_ON : ICON_OFF; pb.label = isEnabled ? "Glide: ON" : "Glide: OFF"; }
        catch (_) { }
    }
    try { pb = new Spicetify.Playbar.Button(isEnabled ? "Glide: ON" : "Glide: OFF", isEnabled ? ICON_ON : ICON_OFF, openSettings, false, isEnabled, true); }
    catch (ex) { err("Playbar:", ex); }

    // ─── Profile Menu ─────────────────────────────────────────────────
    let mi = null;
    function updateMenu() {
        if (!mi) return;
        try { mi.setState(isEnabled); mi.setName(isEnabled ? "Glide: ON ✨" : "Glide: OFF"); } catch (_) { }
    }
    try {
        mi = new Spicetify.Menu.Item(isEnabled ? "Glide: ON ✨" : "Glide: OFF", isEnabled, () => {
            isEnabled = !isEnabled; saveSettings(); updatePb(); updateMenu();
            Spicetify.showNotification(isEnabled ? "✨ Glide enabled" : "Glide disabled", !isEnabled, 2000);
        }, "enhance");
        mi.register();
    } catch (ex) { err("Menu:", ex); }

    // ─── Settings UI — Minimal ─────────────────────────────────────────
    //   ┌──────────────────────────────────────┐
    //   │  Glide                          [5s] │
    //   │  ████████─────────────────────       │
    //   │  Seamless transition timing          │
    //   │  ──────────────────────────────      │
    //   │  Enable Glide            [toggle]    │
    //   │                  Glide v3.0          │
    //   └──────────────────────────────────────┘
    function openSettings() {
        const c = document.createElement("div");
        c.innerHTML = `
            <style>
                .g{padding:8px 0 4px;font-family:var(--font-family,'CircularSp',sans-serif);color:var(--spice-text,#fff)}
                .g__row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
                .g__lbl{font-size:14px;font-weight:700}
                .g__val{font-size:14px;font-weight:700;color:#1DB954;min-width:28px;text-align:right}
                .g__sub{font-size:11px;color:var(--spice-subtext,#b3b3b3);margin-bottom:14px}
                .g__sl{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;background:var(--spice-button-disabled,#535353);outline:none;cursor:pointer;margin:10px 0 6px}
                .g__sl::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#1DB954;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);transition:transform .15s}
                .g__sl::-webkit-slider-thumb:hover{transform:scale(1.25)}
                .g__ticks{display:flex;justify-content:space-between;margin-bottom:20px}
                .g__tick{font-size:10px;color:var(--spice-subtext,#b3b3b3);opacity:.5}
                .g__div{height:1px;background:rgba(255,255,255,.08);margin:4px 0 14px}
                .g__tgl{position:relative;width:38px;height:20px;background:var(--spice-button-disabled,#535353);border-radius:10px;border:none;cursor:pointer;transition:background .2s;padding:0;flex-shrink:0}
                .g__tgl.on{background:#1DB954}
                .g__tgl::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
                .g__tgl.on::after{transform:translateX(18px)}
                .g__foot{font-size:11px;color:var(--spice-subtext,#b3b3b3);opacity:.4;text-align:center;margin-top:18px}
            </style>
            <div class="g">
                <div class="g__row">
                    <span class="g__lbl">Glide</span>
                    <span class="g__val" id="g-val">${timingSec}s</span>
                </div>
                <input type="range" class="g__sl" id="g-sl" min="${MIN_TIMING}" max="${MAX_TIMING}" step="0.5" value="${timingSec}"/>
                <div class="g__ticks">
                    <span class="g__tick">1s</span><span class="g__tick">5s</span><span class="g__tick">10s</span><span class="g__tick">15s</span>
                </div>
                <p class="g__sub">Seamless transition timing</p>
                <div class="g__div"></div>
                <div class="g__row">
                    <span class="g__lbl">Enable Glide</span>
                    <button class="g__tgl ${isEnabled ? "on" : ""}" id="g-tgl"></button>
                </div>
                <div class="g__foot">Glide v3.0</div>
            </div>`;

        const sl = c.querySelector("#g-sl"), val = c.querySelector("#g-val");
        sl.addEventListener("input", () => {
            timingSec = parseFloat(sl.value);
            val.textContent = `${timingSec}s`;
            saveSettings();
            autoEnableCrossfade();
            planTransition();
        });
        const tgl = c.querySelector("#g-tgl");
        tgl.addEventListener("click", () => {
            isEnabled = !isEnabled;
            tgl.classList.toggle("on", isEnabled);
            saveSettings(); updatePb(); updateMenu();
            Spicetify.showNotification(isEnabled ? "✨ Glide enabled" : "Glide disabled", !isEnabled, 2000);
        });
        Spicetify.PopupModal.display({ title: "⚡ Glide", content: c });
    }

    // ─── Initialize ───────────────────────────────────────────────────
    loadSettings();
    autoEnableCrossfade();
    planTransition();

    if (isEnabled) Spicetify.showNotification("✨ Glide v3.0", false, 2000);
    log(`v3.0 loaded | timing=${timingSec}s | AuraMix smart trigger active`);
})();
