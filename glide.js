// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 4.0.0
// DESCRIPTION: AuraMix engine — Apple Music-style intelligent crossfade using Spotify audio analysis. Beat-synced, key-aware, loudness-normalized transitions.

/// <reference path="../cli/globals.d.ts" />

(async function Glide() {
    // ─── Wait for Spicetify APIs ─────────────────────────────────────
    const needed = [
        Spicetify?.Player?.addEventListener,
        Spicetify?.Player?.getProgress,
        Spicetify?.Player?.getDuration,
        Spicetify?.Player?.getVolume,
        Spicetify?.Player?.setVolume,
        Spicetify?.Player?.next,
        Spicetify?.Player?.isPlaying,
        Spicetify?.Playbar,
        Spicetify?.PopupModal,
        Spicetify?.LocalStorage,
        Spicetify?.CosmosAsync,
        Spicetify?.getAudioData,
        Spicetify?.Queue,
    ];
    if (needed.some((x) => !x)) {
        setTimeout(Glide, 300);
        return;
    }

    // ─── Logger ──────────────────────────────────────────────────────
    const TAG = "[AuraMix]";
    const log = (...a) => console.log(`%c${TAG}`, "color:#1DB954;font-weight:bold", ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err = (...a) => console.error(TAG, ...a);

    // ─── Constants ───────────────────────────────────────────────────
    const STORE = {
        ENABLED: "glide:enabled",
        TIMING: "glide:timing",
    };
    const DEFAULT_TIMING = 5;   // seconds
    const MIN_TIMING = 1;
    const MAX_TIMING = 15;
    const FADE_STEPS = 30;
    const HEARTBEAT_MS = 400;
    const MIN_TRACK_MS = 30000;  // ignore tracks under 30 seconds
    const BPM_TOLERANCE = 0.05;   // ±5 % for beat matching
    const FADE_RAMP_MS = 1200;   // quick ramp before/after skip

    // ─── Camelot Wheel (Pitch Class → number 1-12, plus major/minor) ─
    // Standard Pitch Class Notation: C=0, C#=1, D=2 ... B=11
    // Mode: 1=Major(B), 0=Minor(A)
    //
    // Compatible pairs share the same number, or differ by ±1 (same letter)
    // or share the same number with opposite letter.
    const PITCH_TO_CAMELOT = [
        { n: 8, l: "B" }, // 0  C  major → 8B
        { n: 3, l: "B" }, // 1  C# major → 3B
        { n: 10, l: "B" }, // 2  D  major → 10B
        { n: 5, l: "B" }, // 3  D# major → 5B
        { n: 12, l: "B" }, // 4  E  major → 12B
        { n: 7, l: "B" }, // 5  F  major → 7B
        { n: 2, l: "B" }, // 6  F# major → 2B
        { n: 9, l: "B" }, // 7  G  major → 9B
        { n: 4, l: "B" }, // 8  G# major → 4B
        { n: 11, l: "B" }, // 9  A  major → 11B
        { n: 6, l: "B" }, // 10 A# major → 6B
        { n: 1, l: "B" }, // 11 B  major → 1B
    ];
    // For minor: same numbers, letter A
    function pitchToCamelot(key, mode) {
        if (key < 0 || key > 11) return null;
        const entry = PITCH_TO_CAMELOT[key];
        return { n: entry.n, l: mode === 1 ? "B" : "A" };
    }
    function camelotCompatible(a, b) {
        if (!a || !b) return false;
        if (a.n === b.n && a.l === b.l) return true;                        // identical
        if (a.l === b.l && Math.abs(a.n - b.n) <= 1) return true;           // ±1 same mode
        if (a.l === b.l && (Math.max(a.n, b.n) === 12 && Math.min(a.n, b.n) === 1)) return true; // wrap 12↔1
        if (a.n === b.n && a.l !== b.l) return true;                        // same number, parallel key
        return false;
    }

    // ─── State ────────────────────────────────────────────────────────
    let isEnabled = true;
    let timingSec = DEFAULT_TIMING;  // single user-facing control
    let isTransitioning = false;
    let activeTimers = [];
    let transitionId = 0;
    let initialVolume = 1;

    // Analysis cache: uri → AnalysisResult
    const analysisCache = new Map();

    // Pre-fetched next track analysis
    let nextTrackUri = null;
    let nextTrackAnalysis = null;

    // Current song context
    let currentTriggerMs = null;   // ms into the song at which to fire transition
    let currentCompatResult = null;
    let hasTriggered = false;
    let currentSongUri = null;

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
            log("Settings:", { isEnabled, timingSec });
        } catch (ex) { err("loadSettings:", ex); }
    }

    function saveSettings() {
        try {
            Spicetify.LocalStorage.set(STORE.ENABLED, String(isEnabled));
            Spicetify.LocalStorage.set(STORE.TIMING, String(timingSec));
        } catch (ex) { err("saveSettings:", ex); }
    }

    // ─── Auto-Enable Spotify Native Crossfade ────────────────────────
    // Tries to programmatically enable Spotify's native crossfade engine
    // so the user never has to touch Settings → Playback.
    async function autoEnableCrossfade() {
        const durationMs = Math.round(timingSec * 1000);

        // Method 1: Platform.PlayerAPI internal prefs
        try {
            const prefs = Spicetify.Platform?.PlayerAPI?._prefs;
            if (prefs && typeof prefs.setCrossfade === "function") {
                prefs.setCrossfade(true, durationMs);
                log("✅ Crossfade enabled via PlayerAPI._prefs.setCrossfade");
                return;
            }
        } catch (ex) { warn("Method 1 failed:", ex.message); }

        // Method 2: Cosmos sp://player/v2/main
        try {
            await Spicetify.CosmosAsync.post("sp://player/v2/main", {
                crossfade: { enabled: true, duration_ms: durationMs }
            });
            log("✅ Crossfade enabled via cosmos player/v2/main");
            return;
        } catch (ex) { warn("Method 2 failed:", ex.message); }

        // Method 3: Cosmos sp://connect/v1/player/crossfade
        try {
            await Spicetify.CosmosAsync.put("sp://connect/v1/player/crossfade", {
                enabled: true, duration_ms: durationMs
            });
            log("✅ Crossfade enabled via cosmos connect/crossfade");
            return;
        } catch (ex) { warn("Method 3 failed:", ex.message); }

        warn("Could not auto-enable crossfade — Spotify internals not exposed in this build. Transitions still work via early-skip.");
    }

    // ─── Audio Analysis ───────────────────────────────────────────────
    async function analyzeTrack(uri) {
        if (!uri) return null;
        if (analysisCache.has(uri)) return analysisCache.get(uri);

        let raw;
        try {
            raw = await Spicetify.getAudioData(uri);
        } catch (ex) {
            warn("getAudioData failed for", uri, ex.message);
            return null;
        }
        if (!raw) return null;

        const track = raw.track || {};
        const sections = raw.sections || [];
        const bars = raw.bars || [];
        const beats = raw.beats || [];

        // Find outro: last section with loudness below average (fade-out)
        const avgLoudness = sections.reduce((s, x) => s + (x.loudness || 0), 0) / (sections.length || 1);
        const outroSection = sections.slice().reverse().find(s => s.loudness <= avgLoudness) || sections[sections.length - 1];

        // Find intro: first section
        const introSection = sections[0] || null;

        const result = {
            uri,
            tempo: track.tempo || 120,
            key: track.key ?? -1,
            mode: track.mode ?? 1,
            loudness: track.loudness || -10,
            durationMs: Math.round((track.duration || 0) * 1000),
            camelot: pitchToCamelot(track.key ?? -1, track.mode ?? 1),
            outroStart: outroSection ? Math.round(outroSection.start * 1000) : null,
            introDuration: introSection ? Math.round(introSection.duration * 1000) : null,
            bars,
            beats,
        };

        analysisCache.set(uri, result);
        log(`🎵 Analyzed ${uri.split(":")[2]?.slice(-6) || "?"} | BPM=${result.tempo.toFixed(1)} | Key=${result.key} Mode=${result.mode} | Outro@${result.outroStart}ms`);
        return result;
    }

    // ─── Compatibility Check ──────────────────────────────────────────
    function checkCompatibility(songA, songB) {
        if (!songA || !songB) return { compatible: false, bpmMatch: false, keyMatch: false, volumeAdjust: 0 };

        const tempoRatio = Math.abs(songA.tempo - songB.tempo) / songA.tempo;
        const bpmMatch = tempoRatio <= BPM_TOLERANCE;
        const keyMatch = camelotCompatible(songA.camelot, songB.camelot);

        // Volume normalization: positive means we need to raise Song B, negative means lower
        const volumeAdjust = Math.max(-0.3, Math.min(0.3, (songA.loudness - songB.loudness) / 30));

        const compatible = bpmMatch || keyMatch;

        log(`🔍 Compat | BPM: A=${songA.tempo.toFixed(1)} B=${songB.tempo.toFixed(1)} match=${bpmMatch} | Key: A=${JSON.stringify(songA.camelot)} B=${JSON.stringify(songB.camelot)} match=${keyMatch} | volAdj=${volumeAdjust.toFixed(2)}`);
        return { compatible, bpmMatch, keyMatch, volumeAdjust };
    }

    // ─── Smart Trigger Calculator ─────────────────────────────────────
    // Returns the millisecond position in Song A's timeline to start the transition.
    function calculateTriggerPoint(analysisA, compat, durationMs) {
        if (!analysisA || !durationMs) return null;

        const timingMs = timingSec * 1000;

        // If BPM-matched: find the last bar boundary before (durationMs - timingMs)
        if (compat?.bpmMatch && analysisA.bars.length > 0) {
            const targetMs = durationMs - timingMs;
            const bars = analysisA.bars;
            // Find the last bar that starts before our target
            let bestBar = null;
            for (const bar of bars) {
                const barStartMs = Math.round(bar.start * 1000);
                if (barStartMs <= targetMs) bestBar = barStartMs;
            }
            if (bestBar !== null) {
                log(`🥁 Beat-synced trigger at bar boundary: ${bestBar}ms (target was ${targetMs}ms)`);
                return bestBar;
            }
        }

        // If we have outro section data: use the outro start point
        if (analysisA.outroStart && analysisA.outroStart < durationMs - 2000) {
            log(`🎼 Section-based trigger at outro start: ${analysisA.outroStart}ms`);
            return analysisA.outroStart;
        }

        // Fallback: fixed timing (timingSec before end)
        const fallback = durationMs - timingMs;
        log(`⏱ Fallback trigger at: ${fallback}ms (${timingSec}s before end)`);
        return Math.max(0, fallback);
    }

    // ─── Volume Utilities ─────────────────────────────────────────────
    function logCurve(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return t * t; // power curve — perceptually linear
    }

    function safeSetVolume(v) {
        try { Spicetify.Player.setVolume(Math.max(0, Math.min(1, v))); }
        catch (ex) { err("setVolume:", ex); }
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            const id = setTimeout(() => {
                const i = activeTimers.indexOf(id);
                if (i !== -1) activeTimers.splice(i, 1);
                resolve();
            }, ms);
            activeTimers.push(id);
        });
    }

    function cancelAllTimers() {
        for (const id of activeTimers) clearTimeout(id);
        activeTimers.length = 0;
    }

    // ─── Cancel Transition ────────────────────────────────────────────
    function cancelTransition(reason) {
        if (isTransitioning) log("Transition cancelled:", reason);
        cancelAllTimers();
        isTransitioning = false;
        hasTriggered = false;
        transitionId++;
        try { Spicetify.Player.setVolume(initialVolume); } catch (_) { }
    }

    // ─── Execute Transition ───────────────────────────────────────────
    async function executeTransition(compat) {
        if (isTransitioning) return;
        isTransitioning = true;
        transitionId++;
        const myId = transitionId;
        const alive = () => isTransitioning && transitionId === myId;

        initialVolume = Spicetify.Player.getVolume();
        if (initialVolume <= 0) { isTransitioning = false; return; }

        const targetVol = Math.max(0.1, Math.min(1, initialVolume + (compat?.volumeAdjust || 0)));
        log(`🚀 Transition start | vol=${initialVolume.toFixed(2)} → ${targetVol.toFixed(2)} | bpmMatch=${compat?.bpmMatch} | keyMatch=${compat?.keyMatch}`);

        try {
            // Phase 1: Quick ramp down (~1.2s)
            const rampSteps = 15;
            const rampStepMs = FADE_RAMP_MS / rampSteps;
            for (let i = 1; i <= rampSteps; i++) {
                if (!alive()) return;
                safeSetVolume(initialVolume * logCurve(1 - i / rampSteps));
                await sleep(rampStepMs);
            }
            if (!alive()) return;

            // Phase 2: Skip — fires while Song A still has timingSec remaining
            log("⏭ Player.next()");
            safeSetVolume(0);
            try { Spicetify.Player.next(); }
            catch (ex) { err("next() failed:", ex); cancelTransition("next() error"); return; }

            await sleep(300); // let track load
            if (!alive()) return;

            // Phase 3: Fade in Song B over timingSec
            const fadeMs = timingSec * 1000;
            const fadeStepMs = fadeMs / FADE_STEPS;
            for (let i = 1; i <= FADE_STEPS; i++) {
                if (!alive()) return;
                safeSetVolume(targetVol * logCurve(i / FADE_STEPS));
                await sleep(fadeStepMs);
            }
            safeSetVolume(targetVol);
            isTransitioning = false;
            log("✅ Transition complete");
        } catch (ex) {
            err("Transition exception:", ex);
            cancelTransition("exception");
        }
    }

    // ─── Pre-fetch Next Track ─────────────────────────────────────────
    async function prefetchNextTrack() {
        const queue = Spicetify.Queue?.nextTracks;
        if (!queue || queue.length === 0) {
            nextTrackUri = null;
            nextTrackAnalysis = null;
            return;
        }

        const candidate = queue[0];
        const uri = candidate?.uri || candidate?.track?.uri || candidate?.contextTrack?.uri;
        if (!uri || uri === nextTrackUri) return;

        nextTrackUri = uri;
        nextTrackAnalysis = await analyzeTrack(uri);
        log("📥 Pre-fetched next track:", uri.split(":")[2]?.slice(-6));
    }

    // ─── Calculate Transition Plan ────────────────────────────────────
    async function planTransition() {
        hasTriggered = false;
        currentTriggerMs = null;
        currentCompatResult = null;

        const duration = Spicetify.Player.getDuration();
        if (!duration || duration < MIN_TRACK_MS) return;

        const currentUri = Spicetify.Player?.data?.item?.uri;
        const analysisA = await analyzeTrack(currentUri);

        await prefetchNextTrack();

        const compat = checkCompatibility(analysisA, nextTrackAnalysis);
        currentCompatResult = compat;
        currentTriggerMs = calculateTriggerPoint(analysisA, compat, duration);

        log(`📋 Plan: triggerAt=${currentTriggerMs}ms | duration=${duration}ms`);
    }

    // ─── Progress Monitor ─────────────────────────────────────────────
    function checkProgress() {
        if (!isEnabled || isTransitioning || hasTriggered) return;
        if (!Spicetify.Player.isPlaying()) return;

        let progress, duration;
        try {
            progress = Spicetify.Player.getProgress();
            duration = Spicetify.Player.getDuration();
        } catch (_) { return; }

        if (!duration || duration < MIN_TRACK_MS) return;
        if (progress < 3000) return;

        // If we have a smart trigger point, use it
        if (currentTriggerMs !== null) {
            if (progress >= currentTriggerMs) {
                log(`🎯 Smart trigger! progress=${progress}ms ≥ trigger=${currentTriggerMs}ms`);
                hasTriggered = true;
                executeTransition(currentCompatResult);
            }
            return;
        }

        // Fallback: simple time-based (timing sec before end)
        const remaining = duration - progress;
        if (remaining <= timingSec * 1000) {
            log(`⏱ Fallback trigger! remaining=${remaining}ms`);
            hasTriggered = true;
            executeTransition(null);
        }
    }

    // ─── Song Change Handler ──────────────────────────────────────────
    function onSongChange() {
        const newUri = Spicetify.Player?.data?.item?.uri;
        if (newUri === currentSongUri && isTransitioning) {
            // Same URI? Probably a queue jump, finish the transition
            return;
        }
        currentSongUri = newUri;
        cancelTransition("song changed");
        log("🎵 New track:", newUri?.split(":")[2]?.slice(-6));
        planTransition();
    }

    function onPlayPause(event) {
        if (event?.data?.isPaused && isTransitioning) cancelTransition("paused");
    }

    // ─── Heartbeat ───────────────────────────────────────────────────
    setInterval(() => {
        if (isEnabled && !isTransitioning) checkProgress();
    }, HEARTBEAT_MS);

    // ─── Playbar Button ───────────────────────────────────────────────
    const ICON_ON = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/>
        <circle cx="13" cy="4" r="2" fill="#1DB954"/>
    </svg>`;
    const ICON_OFF = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path opacity=".4" d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/>
    </svg>`;

    let playbarBtn = null;
    function updatePlaybarButton() {
        if (!playbarBtn) return;
        try {
            playbarBtn.active = isEnabled;
            playbarBtn.icon = isEnabled ? ICON_ON : ICON_OFF;
            playbarBtn.label = isEnabled ? "Glide: ON" : "Glide: OFF";
        } catch (_) { }
    }

    try {
        playbarBtn = new Spicetify.Playbar.Button(
            isEnabled ? "Glide: ON" : "Glide: OFF",
            isEnabled ? ICON_ON : ICON_OFF,
            () => openSettings(),
            false, isEnabled, true
        );
    } catch (ex) { err("Playbar:", ex); }

    // ─── Profile Menu ─────────────────────────────────────────────────
    let menuItem = null;
    function updateMenu() {
        if (!menuItem) return;
        try {
            menuItem.setState(isEnabled);
            menuItem.setName(isEnabled ? "Glide: ON ✨" : "Glide: OFF");
        } catch (_) { }
    }
    try {
        menuItem = new Spicetify.Menu.Item(
            isEnabled ? "Glide: ON ✨" : "Glide: OFF",
            isEnabled,
            () => {
                isEnabled = !isEnabled;
                saveSettings();
                updatePlaybarButton();
                updateMenu();
                if (!isEnabled) cancelTransition("disabled");
            },
            "enhance"
        );
        menuItem.register();
    } catch (ex) { err("Menu:", ex); }

    // ─── Settings UI — Minimal ─────────────────────────────────────────
    //
    //  ┌─────────────────────────────────┐
    //  │  Glide          [slider]  5s    │
    //  │  Seamless transition timing     │
    //  │  ──────────────────────────     │
    //  │  Enable Glide         [toggle]  │
    //  │              Glide v4.0         │
    //  └─────────────────────────────────┘
    //
    function openSettings() {
        const container = document.createElement("div");
        container.innerHTML = `
            <style>
                .g { padding: 8px 0 4px; font-family: var(--font-family, 'CircularSp', sans-serif); color: var(--spice-text, #fff); }
                .g__row { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
                .g__label { font-size:14px; font-weight:700; }
                .g__val   { font-size:14px; font-weight:700; color:#1DB954; min-width:28px; text-align:right; }
                .g__sub   { font-size:11px; color:var(--spice-subtext,#b3b3b3); margin-bottom:14px; }
                .g__slider {
                    -webkit-appearance:none; appearance:none;
                    width:100%; height:4px; border-radius:2px;
                    background:var(--spice-button-disabled,#535353);
                    outline:none; cursor:pointer; margin:10px 0 6px;
                }
                .g__slider::-webkit-slider-thumb {
                    -webkit-appearance:none; appearance:none;
                    width:14px; height:14px; border-radius:50%;
                    background:#1DB954; cursor:pointer;
                    box-shadow:0 1px 4px rgba(0,0,0,.4);
                    transition:transform .15s;
                }
                .g__slider::-webkit-slider-thumb:hover { transform:scale(1.25); }
                .g__ticks { display:flex; justify-content:space-between; margin-bottom:20px; }
                .g__tick  { font-size:10px; color:var(--spice-subtext,#b3b3b3); opacity:.5; }
                .g__div   { height:1px; background:rgba(255,255,255,.08); margin:4px 0 14px; }
                .g__tgl {
                    position:relative; width:38px; height:20px;
                    background:var(--spice-button-disabled,#535353);
                    border-radius:10px; border:none; cursor:pointer;
                    transition:background .2s; padding:0; flex-shrink:0;
                }
                .g__tgl.on { background:#1DB954; }
                .g__tgl::after {
                    content:''; position:absolute; top:2px; left:2px;
                    width:16px; height:16px; border-radius:50%; background:#fff;
                    transition:transform .2s; box-shadow:0 1px 3px rgba(0,0,0,.3);
                }
                .g__tgl.on::after { transform:translateX(18px); }
                .g__tgl-lbl { font-size:14px; font-weight:600; }
                .g__foot { font-size:11px; color:var(--spice-subtext,#b3b3b3); opacity:.4; text-align:center; margin-top:18px; }
            </style>
            <div class="g">
                <div class="g__row">
                    <span class="g__label">Glide</span>
                    <span class="g__val" id="g-val">${timingSec}s</span>
                </div>
                <input type="range" class="g__slider" id="g-sl"
                    min="${MIN_TIMING}" max="${MAX_TIMING}" step="0.5" value="${timingSec}" />
                <div class="g__ticks">
                    <span class="g__tick">1s</span>
                    <span class="g__tick">5s</span>
                    <span class="g__tick">10s</span>
                    <span class="g__tick">15s</span>
                </div>
                <p class="g__sub">Seamless transition timing</p>
                <div class="g__div"></div>
                <div class="g__row">
                    <span class="g__tgl-lbl">Enable Glide</span>
                    <button class="g__tgl ${isEnabled ? "on" : ""}" id="g-tgl"></button>
                </div>
                <div class="g__foot">Glide v4.0</div>
            </div>
        `;

        // Slider
        const sl = container.querySelector("#g-sl");
        const val = container.querySelector("#g-val");
        sl.addEventListener("input", () => {
            const v = parseFloat(sl.value);
            val.textContent = `${v}s`;
            timingSec = v;
            saveSettings();
            autoEnableCrossfade(); // sync Spotify's crossfade duration
            // Recalculate trigger for current song
            if (currentTriggerMs !== null) planTransition();
        });

        // Toggle
        const tgl = container.querySelector("#g-tgl");
        tgl.addEventListener("click", () => {
            isEnabled = !isEnabled;
            tgl.classList.toggle("on", isEnabled);
            saveSettings();
            updatePlaybarButton();
            updateMenu();
            if (!isEnabled) cancelTransition("disabled");
            Spicetify.showNotification(
                isEnabled ? "✨ Glide enabled" : "Glide disabled",
                !isEnabled, 2000
            );
        });

        Spicetify.PopupModal.display({ title: "⚡ Glide", content: container });
    }

    // ─── Initialize ───────────────────────────────────────────────────
    loadSettings();
    autoEnableCrossfade();

    Spicetify.Player.addEventListener("onprogress", () => checkProgress());
    Spicetify.Player.addEventListener("songchange", onSongChange);
    Spicetify.Player.addEventListener("onplaypause", onPlayPause);

    // Kick off analysis for the current track (if already playing)
    planTransition();

    if (isEnabled) Spicetify.showNotification("✨ Glide v4.0", false, 2000);

    log("v4.0 loaded!", {
        enabled: isEnabled,
        timing: timingSec + "s",
        note: "AuraMix engine — beat-synced, key-aware, loudness-normalized"
    });
})();
