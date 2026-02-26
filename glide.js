// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 4.1.0
// DESCRIPTION: AuraMix engine — Apple Music-style intelligent crossfade. Beat-synced, key-aware early skip. Spotify's native crossfade handles all audio mixing. Zero volume manipulation.

/// <reference path="../cli/globals.d.ts" />

(async function Glide() {
    // ─── Wait for Spicetify APIs ─────────────────────────────────────
    const needed = [
        Spicetify?.Player?.addEventListener,
        Spicetify?.Player?.getProgress,
        Spicetify?.Player?.getDuration,
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
    const DEFAULT_TIMING = 5;
    const MIN_TIMING = 1;
    const MAX_TIMING = 15;
    const HEARTBEAT_MS = 400;
    const MIN_TRACK_MS = 30000;
    const BPM_TOLERANCE = 0.05;   // ±5%

    // ─── Camelot Wheel ───────────────────────────────────────────────
    const PITCH_TO_CAMELOT = [
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
    function pitchToCamelot(key, mode) {
        if (key < 0 || key > 11) return null;
        const e = PITCH_TO_CAMELOT[key];
        return { n: e.n, l: mode === 1 ? "B" : "A" };
    }
    function camelotCompatible(a, b) {
        if (!a || !b) return false;
        if (a.n === b.n && a.l === b.l) return true;
        if (a.l === b.l && Math.abs(a.n - b.n) <= 1) return true;
        if (a.l === b.l && Math.max(a.n, b.n) === 12 && Math.min(a.n, b.n) === 1) return true;
        if (a.n === b.n && a.l !== b.l) return true;
        return false;
    }

    // ─── State ────────────────────────────────────────────────────────
    let isEnabled = true;
    let timingSec = DEFAULT_TIMING;

    // Transition guard: prevent double-firing for the same song
    let hasTriggered = false;
    let currentSongUri = null;

    // Analysis cache & pre-fetched next track
    const analysisCache = new Map();
    let nextTrackUri = null;
    let nextTrackAnalysis = null;

    // Calculated trigger point for the current song (ms)
    let currentTriggerMs = null;
    let currentCompatResult = null;

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

    // ─── Auto-Enable Spotify Native Crossfade ─────────────────────────
    // Silently enables Spotify's built-in crossfade engine on load.
    // This is what creates the true audio overlap — not us.
    async function autoEnableCrossfade() {
        const durationMs = Math.round(timingSec * 1000);

        try {
            const prefs = Spicetify.Platform?.PlayerAPI?._prefs;
            if (prefs && typeof prefs.setCrossfade === "function") {
                prefs.setCrossfade(true, durationMs);
                log("✅ Crossfade active via PlayerAPI._prefs");
                return;
            }
        } catch (ex) { warn("Method 1:", ex.message); }

        try {
            await Spicetify.CosmosAsync.post("sp://player/v2/main", {
                crossfade: { enabled: true, duration_ms: durationMs }
            });
            log("✅ Crossfade active via cosmos player/v2/main");
            return;
        } catch (ex) { warn("Method 2:", ex.message); }

        try {
            await Spicetify.CosmosAsync.put("sp://connect/v1/player/crossfade", {
                enabled: true, duration_ms: durationMs
            });
            log("✅ Crossfade active via cosmos connect/crossfade");
            return;
        } catch (ex) { warn("Method 3:", ex.message); }

        warn("Auto-enable crossfade not available in this Spotify build. Manual setting: Settings → Playback → Crossfade songs.");
    }

    // ─── Audio Analysis ───────────────────────────────────────────────
    async function analyzeTrack(uri) {
        if (!uri) return null;
        if (analysisCache.has(uri)) return analysisCache.get(uri);

        let raw;
        try { raw = await Spicetify.getAudioData(uri); }
        catch (ex) { warn("getAudioData failed:", uri, ex.message); return null; }
        if (!raw) return null;

        const track = raw.track || {};
        const sections = raw.sections || [];
        const bars = raw.bars || [];

        const avgLoudness = sections.reduce((s, x) => s + (x.loudness || 0), 0) / (sections.length || 1);
        const outroSection = sections.slice().reverse().find(s => s.loudness <= avgLoudness)
            || sections[sections.length - 1];

        const result = {
            uri,
            tempo: track.tempo || 120,
            key: track.key ?? -1,
            mode: track.mode ?? 1,
            loudness: track.loudness || -10,
            camelot: pitchToCamelot(track.key ?? -1, track.mode ?? 1),
            outroStart: outroSection ? Math.round(outroSection.start * 1000) : null,
            bars,
        };

        analysisCache.set(uri, result);
        log(`🎵 Analyzed | BPM=${result.tempo.toFixed(1)} | Camelot=${JSON.stringify(result.camelot)} | Outro@${result.outroStart}ms`);
        return result;
    }

    // ─── Compatibility Check ──────────────────────────────────────────
    function checkCompatibility(songA, songB) {
        if (!songA || !songB) return { bpmMatch: false, keyMatch: false };
        const tempoRatio = Math.abs(songA.tempo - songB.tempo) / songA.tempo;
        const bpmMatch = tempoRatio <= BPM_TOLERANCE;
        const keyMatch = camelotCompatible(songA.camelot, songB.camelot);
        log(`🔍 Compat | BPM match=${bpmMatch} (${songA.tempo.toFixed(1)}↔${songB.tempo.toFixed(1)}) | Key match=${keyMatch}`);
        return { bpmMatch, keyMatch };
    }

    // ─── Smart Trigger Calculator ─────────────────────────────────────
    // Returns the ms position in Song A at which to call Player.next().
    // After next(), Spotify's native crossfade handles the audio overlap.
    function calculateTriggerPoint(analysisA, compat, durationMs) {
        if (!analysisA || !durationMs) return null;
        const timingMs = timingSec * 1000;

        // BPM-matched: snap to last bar boundary before target
        if (compat?.bpmMatch && analysisA.bars.length > 0) {
            const targetMs = durationMs - timingMs;
            let bestBar = null;
            for (const bar of analysisA.bars) {
                const barMs = Math.round(bar.start * 1000);
                if (barMs <= targetMs) bestBar = barMs;
            }
            if (bestBar !== null) {
                log(`🥁 Beat-synced trigger at bar: ${bestBar}ms`);
                return bestBar;
            }
        }

        // Outro-section: use where the song naturally starts to fade
        if (analysisA.outroStart && analysisA.outroStart < durationMs - 2000) {
            log(`🎼 Outro-section trigger at: ${analysisA.outroStart}ms`);
            return analysisA.outroStart;
        }

        // Fallback: fixed seconds before end
        const fallback = Math.max(0, durationMs - timingMs);
        log(`⏱ Fallback trigger: ${fallback}ms (${timingSec}s before end)`);
        return fallback;
    }

    // ─── Execute Transition ───────────────────────────────────────────
    // THIS IS ALL WE DO: call Player.next().
    // Spotify's crossfade engine mixes the audio. We do NOT touch volume.
    function executeTransition() {
        hasTriggered = true;

        const remaining = Spicetify.Player.getDuration() - Spicetify.Player.getProgress();
        log(`⏭️ EARLY SKIP | Song A still has ${(remaining / 1000).toFixed(1)}s left. Spotify crossfade mixes audio.`);

        try {
            Spicetify.Player.next();
        } catch (ex) {
            err("Player.next() failed:", ex);
            hasTriggered = false;
        }
    }

    // ─── Pre-fetch Next Track ─────────────────────────────────────────
    async function prefetchNextTrack() {
        const queue = Spicetify.Queue?.nextTracks;
        if (!queue || queue.length === 0) { nextTrackUri = null; nextTrackAnalysis = null; return; }

        const candidate = queue[0];
        const uri = candidate?.uri || candidate?.track?.uri || candidate?.contextTrack?.uri;
        if (!uri || uri === nextTrackUri) return;

        nextTrackUri = uri;
        nextTrackAnalysis = await analyzeTrack(uri);
        log("📥 Pre-fetched next:", uri.split(":")[2]?.slice(-6));
    }

    // ─── Plan Transition ─────────────────────────────────────────────
    // Called on every song change — analyzes current + next track and
    // calculates the ideal moment to call next().
    async function planTransition() {
        hasTriggered = false;
        currentTriggerMs = null;
        currentCompatResult = null;

        const uri = Spicetify.Player?.data?.item?.uri;
        const duration = Spicetify.Player.getDuration();
        if (!duration || duration < MIN_TRACK_MS) return;

        const analysisA = await analyzeTrack(uri);
        await prefetchNextTrack();

        const compat = checkCompatibility(analysisA, nextTrackAnalysis);
        currentCompatResult = compat;
        currentTriggerMs = calculateTriggerPoint(analysisA, compat, duration);

        log(`📋 Plan ready | trigger=${currentTriggerMs}ms of ${duration}ms`);
    }

    // ─── Progress Monitor ─────────────────────────────────────────────
    function checkProgress() {
        if (!isEnabled || hasTriggered) return;
        if (!Spicetify.Player.isPlaying()) return;

        let progress, duration;
        try {
            progress = Spicetify.Player.getProgress();
            duration = Spicetify.Player.getDuration();
        } catch (_) { return; }

        if (!duration || duration < MIN_TRACK_MS) return;
        if (progress < 3000) return;

        // Smart trigger
        if (currentTriggerMs !== null) {
            if (progress >= currentTriggerMs) {
                log(`🎯 Smart trigger! progress=${progress}ms ≥ trigger=${currentTriggerMs}ms`);
                executeTransition();
            }
            return;
        }

        // Fallback: timingSec before end
        const remaining = duration - progress;
        if (remaining <= timingSec * 1000) {
            log(`⏱ Fallback trigger | remaining=${(remaining / 1000).toFixed(1)}s`);
            executeTransition();
        }
    }

    // ─── Song Change ─────────────────────────────────────────────────
    function onSongChange() {
        const newUri = Spicetify.Player?.data?.item?.uri;
        currentSongUri = newUri;
        hasTriggered = false;
        log("🎵 Song changed:", newUri?.split(":")?.[2]?.slice(-6));
        planTransition();
    }

    // Heartbeat backup
    setInterval(() => {
        if (isEnabled && !hasTriggered) checkProgress();
    }, HEARTBEAT_MS);

    Spicetify.Player.addEventListener("onprogress", checkProgress);
    Spicetify.Player.addEventListener("songchange", onSongChange);

    // ─── Icons ───────────────────────────────────────────────────────
    const ICON_ON = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/>
        <circle cx="13" cy="4" r="2" fill="#1DB954"/>
    </svg>`;
    const ICON_OFF = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path opacity=".4" d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/>
    </svg>`;

    // ─── Playbar Button ───────────────────────────────────────────────
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
                Spicetify.showNotification(
                    isEnabled ? "✨ Glide enabled" : "Glide disabled",
                    !isEnabled, 2000
                );
            },
            "enhance"
        );
        menuItem.register();
    } catch (ex) { err("Menu:", ex); }

    // ─── Settings UI — Minimal ────────────────────────────────────────
    function openSettings() {
        const c = document.createElement("div");
        c.innerHTML = `
            <style>
                .g { padding:8px 0 4px; font-family:var(--font-family,'CircularSp',sans-serif); color:var(--spice-text,#fff); }
                .g__row { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
                .g__lbl { font-size:14px; font-weight:700; }
                .g__val { font-size:14px; font-weight:700; color:#1DB954; min-width:28px; text-align:right; }
                .g__sub { font-size:11px; color:var(--spice-subtext,#b3b3b3); margin-bottom:14px; }
                .g__sl {
                    -webkit-appearance:none; appearance:none;
                    width:100%; height:4px; border-radius:2px;
                    background:var(--spice-button-disabled,#535353);
                    outline:none; cursor:pointer; margin:10px 0 6px;
                }
                .g__sl::-webkit-slider-thumb {
                    -webkit-appearance:none; appearance:none;
                    width:14px; height:14px; border-radius:50%;
                    background:#1DB954; cursor:pointer;
                    box-shadow:0 1px 4px rgba(0,0,0,.4);
                    transition:transform .15s;
                }
                .g__sl::-webkit-slider-thumb:hover { transform:scale(1.25); }
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
                .g__foot { font-size:11px; color:var(--spice-subtext,#b3b3b3); opacity:.4; text-align:center; margin-top:18px; }
            </style>
            <div class="g">
                <div class="g__row">
                    <span class="g__lbl">Glide</span>
                    <span class="g__val" id="g-val">${timingSec}s</span>
                </div>
                <input type="range" class="g__sl" id="g-sl"
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
                    <span class="g__lbl">Enable Glide</span>
                    <button class="g__tgl ${isEnabled ? "on" : ""}" id="g-tgl"></button>
                </div>
                <div class="g__foot">Glide v4.1</div>
            </div>
        `;

        const sl = c.querySelector("#g-sl");
        const val = c.querySelector("#g-val");
        sl.addEventListener("input", () => {
            const v = parseFloat(sl.value);
            val.textContent = `${v}s`;
            timingSec = v;
            saveSettings();
            autoEnableCrossfade();
            planTransition(); // recalculate trigger for current song
        });

        const tgl = c.querySelector("#g-tgl");
        tgl.addEventListener("click", () => {
            isEnabled = !isEnabled;
            tgl.classList.toggle("on", isEnabled);
            saveSettings();
            updatePlaybarButton();
            updateMenu();
            Spicetify.showNotification(
                isEnabled ? "✨ Glide enabled" : "Glide disabled",
                !isEnabled, 2000
            );
        });

        Spicetify.PopupModal.display({ title: "⚡ Glide", content: c });
    }

    // ─── Initialize ───────────────────────────────────────────────────
    loadSettings();
    autoEnableCrossfade();
    planTransition();

    if (isEnabled) Spicetify.showNotification("✨ Glide v4.1", false, 2000);
    log("v4.1 loaded | NO volume manipulation | Spotify crossfade handles audio mixing", { timingSec });
})();
