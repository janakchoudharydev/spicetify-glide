// NAME: Glide
// AUTHOR: Project Glide
// VERSION: 3.0.0
// DESCRIPTION: Apple Music-style seamless transitions. Uses Spotify's native crossfade engine for true audio overlap + early skip for the next song to start before the current one ends.

/// <reference path="../cli/globals.d.ts" />

(async function Glide() {
    // ─── Wait for Spicetify APIs ─────────────────────────────────────
    if (
        !Spicetify?.Player?.addEventListener ||
        !Spicetify?.Player?.getProgress ||
        !Spicetify?.Player?.getDuration ||
        !Spicetify?.Player?.getVolume ||
        !Spicetify?.Player?.next ||
        !Spicetify?.Player?.isPlaying ||
        !Spicetify?.Playbar ||
        !Spicetify?.PopupModal ||
        !Spicetify?.LocalStorage ||
        !Spicetify?.CosmosAsync ||
        !Spicetify?.Platform
    ) {
        setTimeout(Glide, 300);
        return;
    }

    // ─── Logger ──────────────────────────────────────────────────────
    const LOG = "[Glide]";
    const log = (...a) => console.log(`%c${LOG}`, "color:#1DB954;font-weight:bold", ...a);
    const warn = (...a) => console.warn(LOG, ...a);
    const err = (...a) => console.error(LOG, ...a);

    // ─── Constants ───────────────────────────────────────────────────
    const STORAGE = {
        ENABLED: "glide:enabled",
        EARLY_START: "glide:earlyStart",
        CROSSFADE_DURATION: "glide:crossfadeDuration",
    };
    const MIN_EARLY = 1;      // seconds
    const MAX_EARLY = 15;
    const DEFAULT_EARLY = 5;  // seconds
    const MIN_CF = 1;         // seconds  
    const MAX_CF = 12;
    const DEFAULT_CF = 5;     // seconds
    const HEARTBEAT_MS = 400;

    // ─── SVG Icons ───────────────────────────────────────────────────
    const ICON_ON = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z"/>
        <circle cx="13" cy="4" r="2" fill="#1DB954"/>
    </svg>`;
    const ICON_OFF = `<svg viewBox="0 0 16 16" height="16" width="16" fill="currentColor">
        <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h1.38a2.5 2.5 0 0 1 2.236 1.382l1.768 3.536a.5.5 0 0 0 .448.276H11.5a1.5 1.5 0 0 1 0 3h-1.19a2.5 2.5 0 0 1-2.236-1.382L6.306 5.276A.5.5 0 0 0 5.858 5H4.5A1.5 1.5 0 0 0 3 6.5v3A1.5 1.5 0 0 0 4.5 11h.19a.5.5 0 0 0 .447-.276L5.691 9.5h1.118l-.829 1.658A2.5 2.5 0 0 1 3.743 12.5H4.5A2.5 2.5 0 0 1 2 10V4.5z" opacity="0.4"/>
    </svg>`;

    // ─── State ────────────────────────────────────────────────────────
    let isEnabled = true;
    let earlyStartSec = DEFAULT_EARLY;
    let crossfadeSec = DEFAULT_CF;
    let hasSkipped = false;         // Prevents re-triggering for the same song
    let lastSkippedUri = null;      // URI of the song we triggered the skip from
    let spotifyCrossfadeStatus = "unknown"; // "enabled", "disabled", "unknown"

    // ─── Settings Persistence ────────────────────────────────────────
    function loadSettings() {
        try {
            const e = Spicetify.LocalStorage.get(STORAGE.ENABLED);
            if (e !== null) isEnabled = e === "true";

            const es = Spicetify.LocalStorage.get(STORAGE.EARLY_START);
            if (es !== null) {
                const v = parseFloat(es);
                if (!isNaN(v) && v >= MIN_EARLY && v <= MAX_EARLY) earlyStartSec = v;
            }

            const cf = Spicetify.LocalStorage.get(STORAGE.CROSSFADE_DURATION);
            if (cf !== null) {
                const v = parseFloat(cf);
                if (!isNaN(v) && v >= MIN_CF && v <= MAX_CF) crossfadeSec = v;
            }

            log("Settings loaded:", { isEnabled, earlyStartSec, crossfadeSec });
        } catch (e) {
            err("Load settings failed:", e);
        }
    }

    function saveSettings() {
        try {
            Spicetify.LocalStorage.set(STORAGE.ENABLED, String(isEnabled));
            Spicetify.LocalStorage.set(STORAGE.EARLY_START, String(earlyStartSec));
            Spicetify.LocalStorage.set(STORAGE.CROSSFADE_DURATION, String(crossfadeSec));
        } catch (e) {
            err("Save settings failed:", e);
        }
    }

    // ─── Spotify Native Crossfade Control ────────────────────────────
    // Spotify has a built-in crossfade engine that does TRUE audio overlap
    // at the audio-pipeline level. We try to enable + configure it.
    //
    // API paths (Spotify internals, may vary by version):
    //   - Spicetify.Platform.PlayerAPI._prefs
    //   - sp://player/v2/main (cosmos)
    //   - DOM: Settings > Playback > Crossfade songs
    //
    async function enableSpotifyCrossfade() {
        try {
            // Method 1: Try Platform.PlayerAPI
            if (Spicetify.Platform?.PlayerAPI?._prefs) {
                const prefs = Spicetify.Platform.PlayerAPI._prefs;
                if (typeof prefs.setCrossfade === "function") {
                    prefs.setCrossfade(true, crossfadeSec);
                    spotifyCrossfadeStatus = "enabled";
                    log("Crossfade enabled via PlayerAPI._prefs.setCrossfade()");
                    return true;
                }
            }
        } catch (e) {
            warn("PlayerAPI crossfade method not available:", e.message);
        }

        try {
            // Method 2: Try cosmos prefs API
            await Spicetify.CosmosAsync.post("sp://player/v2/main", {
                crossfade: {
                    enabled: true,
                    duration_ms: crossfadeSec * 1000,
                }
            });
            spotifyCrossfadeStatus = "enabled";
            log("Crossfade enabled via cosmos sp://player/v2/main");
            return true;
        } catch (e) {
            warn("Cosmos crossfade method not available:", e.message);
        }

        try {
            // Method 3: Try the connect player prefs path
            await Spicetify.CosmosAsync.put("sp://connect/v1/player/crossfade", {
                enabled: true,
                duration_ms: crossfadeSec * 1000,
            });
            spotifyCrossfadeStatus = "enabled";
            log("Crossfade enabled via cosmos sp://connect/v1/player/crossfade");
            return true;
        } catch (e) {
            warn("Connect crossfade method not available:", e.message);
        }

        // If all programmatic methods fail, we still proceed.
        // The early skip will work regardless, and if the user
        // manually enables crossfade in Settings > Playback,
        // they'll get the full Apple Music experience.
        spotifyCrossfadeStatus = "manual";
        warn("Could not programmatically enable crossfade. User should enable it in Settings > Playback.");
        return false;
    }

    // ─── Core: Early Skip ────────────────────────────────────────────
    //
    // THE KEY INSIGHT:
    //   Apple Music's crossfade is done at the AUDIO ENGINE level,
    //   not by ramping volume up/down in JavaScript.
    //
    //   Spotify ALSO has this capability (Settings > Playback > Crossfade).
    //   When crossfade is enabled, calling Player.next() triggers
    //   Spotify's native audio mixing — both songs overlap seamlessly.
    //
    //   Our job is simply to call next() EARLY — X seconds before the
    //   current song ends. Spotify handles the rest.
    //
    //   Timeline:
    //   ┌──── Song A ────────────────────────────┐
    //   │                          ↓ next()       │
    //   │                   earlyStart sec before  │ natural end
    //   │                   Spotify crossfades     │
    //   └──────────────────────┬──────────────────┘
    //                          │
    //   ┌──────────────────────┴──── Song B ──────────────────────┐
    //   │  (starts with Spotify's native crossfade overlap)       │
    //   └────────────────────────────────────────────────────────┘
    //
    function triggerEarlySkip() {
        if (hasSkipped) return;

        const currentUri = Spicetify.Player?.data?.item?.uri || "";
        if (currentUri === lastSkippedUri) return; // Already skipped this song

        hasSkipped = true;
        lastSkippedUri = currentUri;

        const actualRemaining = Spicetify.Player.getDuration() - Spicetify.Player.getProgress();
        log(`⏭️ EARLY SKIP! Song still has ${(actualRemaining / 1000).toFixed(1)}s remaining. Spotify crossfade handles the mix.`);

        Spicetify.showNotification("🎵 Glide → next track");

        try {
            Spicetify.Player.next();
        } catch (e) {
            err("Player.next() failed:", e);
            hasSkipped = false;
            lastSkippedUri = null;
        }
    }

    // ─── Progress Monitor ────────────────────────────────────────────
    function checkProgress() {
        if (!isEnabled) return;
        if (!Spicetify.Player.isPlaying()) return;
        if (hasSkipped) return;

        let progress, duration;
        try {
            progress = Spicetify.Player.getProgress();
            duration = Spicetify.Player.getDuration();
        } catch (e) {
            return;
        }

        if (!duration || duration <= 0) return;
        if (progress < 3000) return; // Skip check if we're in the first 3 seconds

        const remaining = duration - progress;
        if (remaining <= 0) return;

        const earlyMs = earlyStartSec * 1000;

        // Don't trigger for very short tracks (shorter than 2x earlyStart)
        if (duration < earlyMs * 2) return;

        if (remaining <= earlyMs) {
            log(`⏱ Trigger! remaining=${(remaining / 1000).toFixed(1)}s ≤ earlyStart=${earlyStartSec}s`);
            triggerEarlySkip();
        }
    }

    // Dual monitoring: onprogress events + heartbeat backup
    function onProgressChange() {
        checkProgress();
    }

    let heartbeatId = null;
    function startHeartbeat() {
        if (heartbeatId) return;
        heartbeatId = setInterval(checkProgress, HEARTBEAT_MS);
        log("Heartbeat started (" + HEARTBEAT_MS + "ms)");
    }

    // ─── Song Change Handler ─────────────────────────────────────────
    function onSongChange() {
        // Reset skip state for the new song
        hasSkipped = false;
        log("Song changed — ready for next glide");
    }

    // ─── Settings UI — Minimal ─────────────────────────────────────────
    function openSettingsModal() {
        const container = document.createElement("div");
        container.innerHTML = `
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
                    <span class="g__val" id="g-val">${earlyStartSec}s</span>
                </div>
                <input type="range" class="g__sl" id="g-sl"
                    min="${MIN_EARLY}" max="${MAX_EARLY}" step="0.5" value="${earlyStartSec}"/>
                <div class="g__ticks">
                    <span class="g__tick">1s</span><span class="g__tick">5s</span>
                    <span class="g__tick">10s</span><span class="g__tick">15s</span>
                </div>
                <p class="g__sub">Seamless transition timing</p>
                <div class="g__div"></div>
                <div class="g__row">
                    <span class="g__lbl">Enable Glide</span>
                    <button class="g__tgl ${isEnabled ? "on" : ""}" id="g-toggle"></button>
                </div>
                <div class="g__foot">Glide v3.0</div>
            </div>`;

        const sl = container.querySelector("#g-sl");
        const val = container.querySelector("#g-val");
        sl.addEventListener("input", () => {
            const v = parseFloat(sl.value);
            val.textContent = `${v}s`;
            earlyStartSec = v;
            crossfadeSec = v;   // keep crossfade in sync with the single slider
            saveSettings();
            enableSpotifyCrossfade(); // silently sync Spotify's crossfade duration
        });

        const toggle = container.querySelector("#g-toggle");
        toggle.addEventListener("click", () => {
            isEnabled = !isEnabled;
            toggle.classList.toggle("on", isEnabled);
            saveSettings();
            updatePlaybarButton();
            updateMenuState();
            Spicetify.showNotification(
                isEnabled ? "✨ Glide enabled" : "Glide disabled",
                !isEnabled
            );
        });

        Spicetify.PopupModal.display({
            title: "⚡ Glide",
            content: container,
        });
    }

    // ─── Test Skip ───────────────────────────────────────────────────
    function testSkip() {
        if (!Spicetify.Player.isPlaying()) {
            Spicetify.showNotification("▶️ Play a song first", true);
            return;
        }
        Spicetify.showNotification("🧪 Testing early skip...");
        log("Manual test triggered");
        hasSkipped = false;
        lastSkippedUri = null;
        triggerEarlySkip();
    }

    // ─── Playbar Button ──────────────────────────────────────────────
    let playbarBtn = null;

    function updatePlaybarButton() {
        if (!playbarBtn) return;
        try {
            playbarBtn.active = isEnabled;
            playbarBtn.icon = isEnabled ? ICON_ON : ICON_OFF;
            playbarBtn.label = isEnabled ? "Glide: ON" : "Glide: OFF";
        } catch (e) { err("Playbar update failed:", e); }
    }

    function initPlaybarButton() {
        try {
            playbarBtn = new Spicetify.Playbar.Button(
                isEnabled ? "Glide: ON" : "Glide: OFF",
                isEnabled ? ICON_ON : ICON_OFF,
                () => openSettingsModal(),
                false, isEnabled, true
            );
            log("Playbar button ready");
        } catch (e) { err("Playbar init failed:", e); }
    }

    // ─── Profile Menu ────────────────────────────────────────────────
    let menuItem = null;

    function updateMenuState() {
        if (!menuItem) return;
        try {
            menuItem.setState(isEnabled);
            menuItem.setName(isEnabled ? "Glide: ON ✨" : "Glide: OFF");
        } catch (e) { err("Menu update failed:", e); }
    }

    function initMenu() {
        try {
            menuItem = new Spicetify.Menu.Item(
                isEnabled ? "Glide: ON ✨" : "Glide: OFF",
                isEnabled,
                () => {
                    isEnabled = !isEnabled;
                    saveSettings();
                    updatePlaybarButton();
                    updateMenuState();
                    Spicetify.showNotification(
                        isEnabled ? "✨ Glide enabled" : "Glide disabled",
                        !isEnabled
                    );
                },
                "enhance"
            );
            menuItem.register();
            log("Menu ready");
        } catch (e) { err("Menu init failed:", e); }
    }

    // ─── Initialize ──────────────────────────────────────────────────
    loadSettings();
    initPlaybarButton();
    initMenu();

    // Try to enable Spotify's native crossfade
    enableSpotifyCrossfade();

    // Register event listeners
    Spicetify.Player.addEventListener("onprogress", onProgressChange);
    Spicetify.Player.addEventListener("songchange", onSongChange);

    // Start heartbeat backup
    startHeartbeat();

    if (isEnabled) {
        Spicetify.showNotification("✨ Glide v3.0 — Apple Music transitions active");
    }

    log("v3.0 loaded!", {
        enabled: isEnabled,
        earlyStart: earlyStartSec + "s",
        crossfade: crossfadeSec + "s",
        spotifyCrossfade: spotifyCrossfadeStatus,
    });
})();
