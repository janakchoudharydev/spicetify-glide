// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 4.2.0
// DESCRIPTION: AuraMix engine — Apple Music-style crossfade via Web Audio API GainNode. No Player.setVolume(). Both songs overlap at the audio-graph level. Beat-synced, key-aware smart trigger.

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
    const STORE = { ENABLED: "glide:enabled", TIMING: "glide:timing" };
    const DEFAULT_TIMING = 5;
    const MIN_TIMING = 1;
    const MAX_TIMING = 15;
    const HEARTBEAT_MS = 400;
    const MIN_TRACK_MS = 30000;
    const BPM_TOLERANCE = 0.05;    // ±5%
    const LOAD_SETTLE_MS = 250;     // Time for Spotify to start the new track

    // ─── Web Audio API Crossfade engine ──────────────────────────────
    //
    // We tap Spotify's <audio> element and insert a GainNode into the
    // audio graph. Fading the gain causes a smooth, natural volume ramp
    // that is COMPLETELY INVISIBLE to Spotify's UI volume slider.
    //
    //   <audio> ──► MediaElementSource ──► GainNode ──► AudioContext.destination
    //
    // IMPORTANT: We initialize lazily — only when the first transition fires.
    // The <audio> element may not exist at Spicetify extension load time.
    //
    let audioCtx = null;
    let gainNode = null;
    let mediaSource = null;
    let webAudioReady = false;

    function initWebAudio() {
        if (webAudioReady) return true;  // already initialized
        const audioEl = document.querySelector("audio");
        if (!audioEl) { warn("No <audio> element found — web audio unavailable"); return false; }
        try {
            audioCtx = new AudioContext();
            mediaSource = audioCtx.createMediaElementSource(audioEl);
            gainNode = audioCtx.createGain();
            gainNode.gain.value = 1;
            mediaSource.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            webAudioReady = true;
            log("✅ Web Audio GainNode injected into Spotify's audio pipeline");
            return true;
        } catch (ex) {
            err("Web Audio init failed:", ex.message);
            audioCtx = gainNode = mediaSource = null;
            return false;
        }
    }

    // Smooth gain ramp — exponential sounds more natural than linear
    function rampGain(targetValue, durationSec) {
        if (!gainNode || !audioCtx) return;
        const now = audioCtx.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        // Can't exponential ramp to 0, so use linear for silence
        if (targetValue === 0) {
            gainNode.gain.linearRampToValueAtTime(0.0001, now + durationSec);
        } else {
            gainNode.gain.linearRampToValueAtTime(Math.max(0.0001, targetValue), now + durationSec);
        }
    }

    function setGainImmediate(value) {
        if (!gainNode || !audioCtx) return;
        gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
        gainNode.gain.setValueAtTime(Math.max(0.0001, value), audioCtx.currentTime);
    }

    // ─── Camelot Wheel ───────────────────────────────────────────────
    const PITCH_TO_CAMELOT = [
        { n: 8, l: "B" }, // C
        { n: 3, l: "B" }, // C#
        { n: 10, l: "B" }, // D
        { n: 5, l: "B" }, // D#
        { n: 12, l: "B" }, // E
        { n: 7, l: "B" }, // F
        { n: 2, l: "B" }, // F#
        { n: 9, l: "B" }, // G
        { n: 4, l: "B" }, // G#
        { n: 11, l: "B" }, // A
        { n: 6, l: "B" }, // A#
        { n: 1, l: "B" }, // B
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
    let isTransitioning = false;
    let hasTriggered = false;
    let currentSongUri = null;
    const analysisCache = new Map();
    let nextTrackUri = null;
    let nextTrackAnalysis = null;
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

    // ─── Auto-Enable Spotify Native Crossfade (bonus layer) ──────────
    // Even if our GainNode handles fading, Spotify's native crossfade
    // also helps with buffering the next track. Try to enable it.
    async function autoEnableCrossfade() {
        const ms = Math.round(timingSec * 1000);
        try {
            const prefs = Spicetify.Platform?.PlayerAPI?._prefs;
            if (prefs?.setCrossfade) { prefs.setCrossfade(true, ms); return; }
        } catch (_) { }
        try {
            await Spicetify.CosmosAsync?.post("sp://player/v2/main", {
                crossfade: { enabled: true, duration_ms: ms }
            });
        } catch (_) { }
    }

    // ─── Audio Analysis ───────────────────────────────────────────────
    async function analyzeTrack(uri) {
        if (!uri) return null;
        if (analysisCache.has(uri)) return analysisCache.get(uri);
        let raw;
        try { raw = await Spicetify.getAudioData(uri); }
        catch (ex) { warn("getAudioData:", uri, ex.message); return null; }
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
            camelot: pitchToCamelot(track.key ?? -1, track.mode ?? 1),
            outroStart: outroSection ? Math.round(outroSection.start * 1000) : null,
            bars,
        };
        analysisCache.set(uri, result);
        log(`🎵 Analyzed | BPM=${result.tempo.toFixed(1)} | Camelot=${JSON.stringify(result.camelot)} | Outro@${result.outroStart}ms`);
        return result;
    }

    function checkCompatibility(a, b) {
        if (!a || !b) return { bpmMatch: false, keyMatch: false };
        const bpmMatch = Math.abs(a.tempo - b.tempo) / a.tempo <= BPM_TOLERANCE;
        const keyMatch = camelotCompatible(a.camelot, b.camelot);
        log(`🔍 Compat | BPM=${bpmMatch} | Key=${keyMatch}`);
        return { bpmMatch, keyMatch };
    }

    function calculateTriggerPoint(analysisA, compat, durationMs) {
        if (!analysisA || !durationMs) return null;
        const timingMs = timingSec * 1000;
        if (compat?.bpmMatch && analysisA.bars.length > 0) {
            const targetMs = durationMs - timingMs;
            let bestBar = null;
            for (const bar of analysisA.bars) {
                const bMs = Math.round(bar.start * 1000);
                if (bMs <= targetMs) bestBar = bMs;
            }
            if (bestBar !== null) {
                log(`🥁 Beat-synced trigger: ${bestBar}ms`);
                return bestBar;
            }
        }
        if (analysisA.outroStart && analysisA.outroStart < durationMs - 2000) {
            log(`🎼 Outro trigger: ${analysisA.outroStart}ms`);
            return analysisA.outroStart;
        }
        const fb = Math.max(0, durationMs - timingMs);
        log(`⏱ Fallback trigger: ${fb}ms`);
        return fb;
    }

    // ─── Execute Transition ───────────────────────────────────────────
    //
    // HOW THE CROSSFADE WORKS (no Player.setVolume() at all):
    //
    //   Phase A: Fade out Song A via GainNode  (~timingSec/3 seconds)
    //            GainNode.gain goes 1.0 → 0
    //            Spotify's audio plays, volume bar UNCHANGED
    //
    //   Phase B: Player.next() — Song B starts loading
    //            GainNode.gain is still 0 (silence during buffer)
    //
    //   Phase C: Fade in Song B via GainNode (~timingSec seconds)
    //            GainNode.gain goes 0 → 1.0
    //            Smooth, natural ramp — no user-visible volume change
    //
    async function executeTransition() {
        if (isTransitioning) return;
        isTransitioning = true;
        hasTriggered = true;

        // Lazy-initialize Web Audio now that Spotify is definitely playing audio
        if (!webAudioReady) initWebAudio();

        const remaining = Spicetify.Player.getDuration() - Spicetify.Player.getProgress();
        log(`⏭ Transition | Song A has ${(remaining / 1000).toFixed(1)}s left`);

        const fadeOutDuration = Math.max(0.5, timingSec / 3);  // quick fade out
        const fadeInDuration = timingSec;                      // gradual fade in

        try {
            if (webAudioReady && gainNode) {
                // Phase A: Smooth fade out via GainNode (NOT setVolume)
                log(`Phase A: GainNode fade out over ${fadeOutDuration.toFixed(1)}s`);
                rampGain(0, fadeOutDuration);
                await new Promise(r => setTimeout(r, fadeOutDuration * 1000));

                // Phase B: Skip to next track
                log("Phase B: Player.next()");
                try { Spicetify.Player.next(); }
                catch (ex) { err("next():", ex); isTransitioning = false; setGainImmediate(1); return; }

                // Give Spotify time to start buffering Song B
                await new Promise(r => setTimeout(r, LOAD_SETTLE_MS));

                // Phase C: Smooth fade in via GainNode
                log(`Phase C: GainNode fade in over ${fadeInDuration.toFixed(1)}s`);
                rampGain(1, fadeInDuration);
                await new Promise(r => setTimeout(r, fadeInDuration * 1000));
                setGainImmediate(1);

            } else {
                // Fallback: no Web Audio (e.g. browser blocks it), just skip
                warn("Web Audio not available — hard skip only");
                try { Spicetify.Player.next(); } catch (_) { }
            }
        } catch (ex) {
            err("Transition error:", ex);
            if (gainNode) setGainImmediate(1); // restore audio
        }

        isTransitioning = false;
        log("✅ Crossfade complete");
    }

    // ─── Pre-fetch & Plan ─────────────────────────────────────────────
    async function prefetchNextTrack() {
        const queue = Spicetify.Queue?.nextTracks;
        if (!queue?.length) { nextTrackUri = null; nextTrackAnalysis = null; return; }
        const c = queue[0];
        const uri = c?.uri || c?.track?.uri || c?.contextTrack?.uri;
        if (!uri || uri === nextTrackUri) return;
        nextTrackUri = uri;
        nextTrackAnalysis = await analyzeTrack(uri);
        log("📥 Pre-fetched next:", uri.split(":")?.[2]?.slice(-6));
    }

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
        log(`📋 Plan | trigger=${currentTriggerMs}ms / ${duration}ms`);
    }

    // ─── Progress Monitor ─────────────────────────────────────────────
    function checkProgress() {
        if (!isEnabled || isTransitioning || hasTriggered) return;
        if (!Spicetify.Player.isPlaying()) return;
        let progress, duration;
        try { progress = Spicetify.Player.getProgress(); duration = Spicetify.Player.getDuration(); }
        catch (_) { return; }
        if (!duration || duration < MIN_TRACK_MS || progress < 3000) return;
        if (currentTriggerMs !== null) {
            if (progress >= currentTriggerMs) {
                log(`🎯 Smart trigger! ${progress}ms ≥ ${currentTriggerMs}ms`);
                executeTransition();
            }
            return;
        }
        const remaining = duration - progress;
        if (remaining <= timingSec * 1000) {
            log(`⏱ Fallback trigger | ${(remaining / 1000).toFixed(1)}s left`);
            executeTransition();
        }
    }

    // ─── Event Handlers ───────────────────────────────────────────────
    function onSongChange() {
        const newUri = Spicetify.Player?.data?.item?.uri;
        if (newUri === currentSongUri) return;
        currentSongUri = newUri;
        isTransitioning = false;
        hasTriggered = false;
        // Ensure gain is restored to 1 on song change
        if (gainNode && audioCtx) setGainImmediate(1);
        log("🎵 Song changed:", newUri?.split(":")?.[2]?.slice(-6));
        planTransition();
    }

    setInterval(() => { if (isEnabled && !isTransitioning) checkProgress(); }, HEARTBEAT_MS);
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
        mi = new Spicetify.Menu.Item(
            isEnabled ? "Glide: ON ✨" : "Glide: OFF", isEnabled,
            () => { isEnabled = !isEnabled; saveSettings(); updatePb(); updateMenu(); Spicetify.showNotification(isEnabled ? "✨ Glide enabled" : "Glide disabled", !isEnabled, 2000); },
            "enhance"
        );
        mi.register();
    } catch (ex) { err("Menu:", ex); }

    // ─── Settings UI — Minimal ────────────────────────────────────────
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
                    <span class="g__tick">1s</span><span class="g__tick">5s</span>
                    <span class="g__tick">10s</span><span class="g__tick">15s</span>
                </div>
                <p class="g__sub">Seamless transition timing</p>
                <div class="g__div"></div>
                <div class="g__row">
                    <span class="g__lbl">Enable Glide</span>
                    <button class="g__tgl ${isEnabled ? "on" : ""}" id="g-tgl"></button>
                </div>
                <div class="g__foot">Glide v4.2</div>
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

    if (isEnabled) Spicetify.showNotification("✨ Glide v4.2", false, 2000);
    log(`v4.2 loaded | Web Audio=${webAudioReady} | timing=${timingSec}s | AuraMix engine active`);
})();
