/**
 * Backify — app.js
 * Browser-only Spotify backup/restore via PKCE OAuth 2.0.
 *
 * Fixes applied vs original:
 *  1. CSRF: state parameter added to OAuth flow
 *  2. Operation locking: buttons disabled during backup/restore
 *  3. Rate-limit handling: 429 + Retry-After respected with retries
 *  4. Token refresh race condition: singleton refresh promise
 *  5. 401 auto-retry: one transparent retry after token refresh
 *  6. fetchAllPages loop guard: max 500 pages
 *  7. URL constructor for limit param: no duplicate query params
 *  8. loadOverview uses paged `total` field: 2 calls instead of N
 *  9. Restore confirmation dialog before destructive operation
 * 10. Restore respects playlist.public from backup
 * 11. Profile cache cleared on 401 (account-switch safety)
 */

"use strict";

const CONFIG = window.BACKIFY_CONFIG || {};

// ── LocalStorage keys ─────────────────────────────────────────────────────────
const KEY = {
  ACCESS_TOKEN:  "bfy_access_token",
  REFRESH_TOKEN: "bfy_refresh_token",
  EXPIRES_AT:    "bfy_expires_at",
  CODE_VERIFIER: "bfy_code_verifier",
  OAUTH_STATE:   "bfy_oauth_state",
  USER_PROFILE:  "bfy_user_profile",
};

// ── State ─────────────────────────────────────────────────────────────────────
let _refreshPromise = null;   // singleton guard for concurrent refresh calls
let _operationActive = false; // guard against concurrent backup/restore runs

// ── UI helpers ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setStatus(msg, isError = false) {
  const el = $("status") || $("callbackStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
}

function showApp() {
  const loginBtn = $("loginBtn");
  const app      = $("app");
  if (loginBtn) loginBtn.classList.add("hidden");
  if (app)      app.classList.remove("hidden");
}

function hideApp() {
  const loginBtn = $("loginBtn");
  const app      = $("app");
  if (loginBtn) loginBtn.classList.remove("hidden");
  if (app)      app.classList.add("hidden");
}

function updateStat(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "—";
}

function setProgress(percent, label = "") {
  const wrap = $("progressWrap");
  const bar  = $("progressBar");
  const lbl  = $("progressLabel");
  if (!wrap || !bar || !lbl) return;

  wrap.classList.remove("hidden");
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  bar.style.width = safe + "%";
  lbl.textContent = `${safe}%${label ? "  —  " + label : ""}`;
}

function hideProgress() {
  const wrap = $("progressWrap");
  if (wrap) wrap.classList.add("hidden");
}

/** Disable / enable all interactive controls during an operation */
function setOperationActive(active) {
  _operationActive = active;
  ["backupBtn", "restoreBtn", "fileInput", "logoutBtn"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = active;
  });
  const backupBtn = $("backupBtn");
  if (backupBtn) {
    backupBtn.textContent = active ? "Working…" : "Backup My Music";
  }
}

function goHome() {
  // Use index.html explicitly to avoid Workers routing ambiguity
  window.location.replace((CONFIG.APP_BASE_PATH || "/").replace(/\/?$/, "") + "/index.html");
}

function slugify(text) {
  return String(text || "spotify-user")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g,  "-")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase() || "spotify-user";
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf   = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => chars[b % chars.length]).join("");
}

async function sha256(plain) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function login() {
  try {
    const scopes = [
      "playlist-read-private",
      "playlist-read-collaborative",
      "playlist-modify-private",
      "playlist-modify-public",
      "user-library-read",
      "user-library-modify",
    ];

    const verifier   = randomString(64);
    const state      = randomString(16);
    const challenge  = base64url(await sha256(verifier));
    const redirectUri = CONFIG.REDIRECT_URI || `${location.origin}/callback.html`;

    localStorage.setItem(KEY.CODE_VERIFIER, verifier);
    localStorage.setItem(KEY.OAUTH_STATE,   state);

    const params = new URLSearchParams({
      client_id:             CONFIG.SPOTIFY_CLIENT_ID,
      response_type:         "code",
      redirect_uri:          redirectUri,
      code_challenge_method: "S256",
      code_challenge:        challenge,
      scope:                 scopes.join(" "),
      state,
      show_dialog:           "false",
    });

    location.href = `https://accounts.spotify.com/authorize?${params}`;
  } catch (err) {
    console.error(err);
    setStatus("Failed to start Spotify login.", true);
  }
}

function logout() {
  Object.values(KEY).forEach(k => localStorage.removeItem(k));
  hideProgress();
  hideApp();
  goHome();
}

function getToken()   { return localStorage.getItem(KEY.ACCESS_TOKEN); }
function tokenExpired() {
  const exp = Number(localStorage.getItem(KEY.EXPIRES_AT) || "0");
  return !exp || Date.now() >= exp;
}

function saveTokens(data) {
  localStorage.setItem(KEY.ACCESS_TOKEN, data.access_token);
  if (data.refresh_token) localStorage.setItem(KEY.REFRESH_TOKEN, data.refresh_token);
  localStorage.setItem(KEY.EXPIRES_AT, String(Date.now() + Math.max(data.expires_in - 60, 60) * 1000));
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem(KEY.CODE_VERIFIER);
  if (!verifier) throw new Error("Missing code verifier. Please try logging in again.");

  const body = new URLSearchParams({
    client_id:     CONFIG.SPOTIFY_CLIENT_ID,
    grant_type:    "authorization_code",
    code,
    redirect_uri:  CONFIG.REDIRECT_URI || `${location.origin}/callback.html`,
    code_verifier: verifier,
  });

  const res  = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Token exchange failed");

  saveTokens(data);
  localStorage.removeItem(KEY.CODE_VERIFIER);
}

async function doRefreshToken() {
  const refreshToken = localStorage.getItem(KEY.REFRESH_TOKEN);
  if (!refreshToken) throw new Error("Session expired. Please sign in again.");

  const body = new URLSearchParams({
    client_id:     CONFIG.SPOTIFY_CLIENT_ID,
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const res  = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Token refresh failed");

  saveTokens(data);
}

/** FIX #4: singleton refresh promise prevents parallel refresh races */
async function ensureValidToken() {
  if (!getToken()) return null;

  if (tokenExpired()) {
    if (!_refreshPromise) {
      _refreshPromise = doRefreshToken().finally(() => { _refreshPromise = null; });
    }
    await _refreshPromise;
  }

  return getToken();
}

// ── API layer ─────────────────────────────────────────────────────────────────
/**
 * FIX #3: rate-limit retry  FIX #5: 401 auto-retry
 * One transparent retry after a 401 (token refresh) or 429 (rate limit).
 */
async function spotifyFetch(url, options = {}, _retryCount = 0) {
  const token = await ensureValidToken();
  if (!token) throw Object.assign(new Error("Not logged in"), { status: 401 });

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  // Rate limited — wait for Retry-After header then retry (max 4 retries)
  if (res.status === 429 && _retryCount < 4) {
    const wait = parseInt(res.headers.get("Retry-After") || "2", 10);
    setStatus(`Rate limited by Spotify — waiting ${wait}s…`);
    await new Promise(r => setTimeout(r, (wait + 0.5) * 1000));
    return spotifyFetch(url, options, _retryCount + 1);
  }

  // Token expired mid-operation — refresh once and retry
  if (res.status === 401 && _retryCount === 0) {
    localStorage.removeItem(KEY.USER_PROFILE); // FIX #11: clear stale profile cache
    _refreshPromise = null;                    // clear any stale singleton
    await doRefreshToken();
    return spotifyFetch(url, options, 1);
  }

  if (!res.ok) {
    let message = `Spotify API error ${res.status}`;
    try {
      const d = await res.json();
      message = d?.error?.message || d?.error_description || (typeof d?.error === "string" ? d.error : message);
    } catch (_) {}
    throw Object.assign(new Error(message), { status: res.status });
  }

  if (res.status === 204) return null;
  return res.json();
}

/** FIX #6: loop guard  FIX #7: URL constructor for clean limit param */
async function fetchAllPages(initialUrl, maxPages = 500) {
  const items = [];
  // Normalise URL and set limit to max allowed
  const startUrl = new URL(initialUrl);
  if (!startUrl.searchParams.has("limit")) startUrl.searchParams.set("limit", "50");
  let next  = startUrl.toString();
  let pages = 0;

  while (next && pages++ < maxPages) {
    const data = await spotifyFetch(next);
    if (!data) break;
    items.push(...(data.items || []));
    next = data.next || null;
  }

  return items;
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function getCurrentUserProfile() {
  const cached = localStorage.getItem(KEY.USER_PROFILE);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  const me = await spotifyFetch("https://api.spotify.com/v1/me");
  localStorage.setItem(KEY.USER_PROFILE, JSON.stringify(me));
  return me;
}

/** Show user info badge in the header */
function renderUserBadge(me) {
  const badge       = document.getElementById("userBadge");
  const nameEl      = document.getElementById("userName");
  const avatarImg   = document.getElementById("userAvatarImg");
  const avatarPlaceholder = document.getElementById("userAvatarPlaceholder");

  if (!badge) return;

  const name = me?.display_name || me?.id || "Spotify User";
  if (nameEl) nameEl.textContent = name;

  // Avatar: use first image from profile images array if available
  const imgUrl = me?.images?.[0]?.url || me?.images?.[1]?.url || null;
  if (imgUrl && avatarImg) {
    avatarImg.src = imgUrl;
    avatarImg.alt = name;
    avatarImg.classList.remove("hidden");
    if (avatarPlaceholder) avatarPlaceholder.style.display = "none";
  } else if (avatarPlaceholder) {
    // Initials fallback
    avatarPlaceholder.textContent = name.charAt(0).toUpperCase();
  }

  badge.classList.remove("hidden");
}

/** FIX #8: uses paged `total` field — only 2 API calls instead of fetching every page */
async function loadOverview() {
  let me = null;

  // ── Phase 1: User profile (always attempt, show name in header) ──
  try {
    me = await getCurrentUserProfile();
    const name = me?.display_name || me?.id || "there";
    renderUserBadge(me);
    setStatus(`Signed in as ${name}. Ready to back up your music.`);
  } catch (profileErr) {
    console.error("Profile fetch failed:", profileErr);
    if (profileErr.status === 403) {
      setStatus(
        "Spotify blocked API access. If your app is in Development Mode, add this account to the allowlist in your Spotify Developer Dashboard.",
        true
      );
      showApp();
      return;
    }
    setStatus("Signed in, but failed to load profile.", true);
  }

  // ── Phase 2: Stats (handled gracefully — 403 from Development Mode is non-fatal) ──
  try {
    const [playlistPage, likedPage] = await Promise.all([
      spotifyFetch("https://api.spotify.com/v1/me/playlists?limit=1"),
      spotifyFetch("https://api.spotify.com/v1/me/tracks?limit=1"),
    ]);

    updateStat("playlistCount", playlistPage?.total ?? "—");
    updateStat("likedCount",    likedPage?.total    ?? "—");
  } catch (statsErr) {
    console.warn("Stats fetch failed:", statsErr);
    if (statsErr.status === 403) {
      const name = me?.display_name || me?.id || "there";
      setStatus(
        `Signed in as ${name}. ⚠️ Spotify API access is restricted — your account isn't on the app's allowlist in the Spotify Developer Dashboard. Backup/restore may not work until you add this account.`,
        true
      );
    }
    // Leave stat counters as "—" — not fatal
  }
}

async function fetchPlaylistTracksSafe(playlist) {
  try {
    // FIX #7: use URL constructor to avoid duplicate `limit` params
    const base = playlist?.tracks?.href
      || `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlist.id)}/tracks`;
    const url = new URL(base);
    url.searchParams.set("limit", "100");

    const items = await fetchAllPages(url.toString());
    return {
      ok:       true,
      tracks:   items.map(i => i?.track?.uri).filter(Boolean),
      forbidden: false,
    };
  } catch (err) {
    if (err.status === 403) return { ok: false, forbidden: true, tracks: [] };
    throw err;
  }
}

// ── Backup ────────────────────────────────────────────────────────────────────
async function backupMusic() {
  if (_operationActive) return;

  try {
    setOperationActive(true);
    setStatus("Loading playlists…");
    setProgress(5, "Starting backup");

    const me = await getCurrentUserProfile();
    const username = me?.display_name || me?.id || "spotify-user";

    const playlists = await fetchAllPages("https://api.spotify.com/v1/me/playlists?limit=50");
    setProgress(18, `Found ${playlists.length} playlist(s)`);

    setStatus("Loading liked songs…");
    const likedItems   = await fetchAllPages("https://api.spotify.com/v1/me/tracks?limit=50");
    const likedSongUris = likedItems.map(i => i?.track?.uri).filter(Boolean);
    setProgress(32, `Loaded ${likedSongUris.length} liked song(s)`);

    const enrichedPlaylists = [];
    let forbiddenCount = 0;

    for (let i = 0; i < playlists.length; i++) {
      const pl     = playlists[i];
      const result = await fetchPlaylistTracksSafe(pl);

      if (result.forbidden) forbiddenCount++;

      enrichedPlaylists.push({
        id:            pl.id,
        name:          pl.name,
        description:   pl.description || "",
        public:        !!pl.public,
        collaborative: !!pl.collaborative,
        trackUris:     result.tracks,
      });

      const pct = 32 + ((i + 1) / Math.max(playlists.length, 1)) * 53;
      setProgress(pct, `Reading playlist ${i + 1} of ${playlists.length}`);
    }

    const backup = {
      app:         "Backify",
      version:     6,
      exportedAt:  new Date().toISOString(),
      account: {
        id:            me?.id            || "",
        displayName:   me?.display_name  || "",
        playlistCount: playlists.length,
        likedSongCount: likedSongUris.length,
      },
      skippedForbiddenPlaylists: forbiddenCount,
      likedSongUris,
      playlists: enrichedPlaylists,
    };

    setStatus("Preparing download…");
    setProgress(92, "Building JSON");

    const blob     = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const objUrl   = URL.createObjectURL(blob);
    const dateStr  = new Date().toISOString().slice(0, 10);
    const fileName = `${slugify(username)}-backify-${dateStr}.json`;

    const a = Object.assign(document.createElement("a"), { href: objUrl, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);

    setProgress(100, "Download complete");

    if (forbiddenCount > 0) {
      setStatus(
        `Backup saved as "${fileName}". ${forbiddenCount} playlist(s) skipped — Spotify denied access (Development Mode).`,
        true
      );
    } else {
      setStatus(`Backup saved as "${fileName}".`);
    }

    // Refresh stat counters
    updateStat("playlistCount", playlists.length);
    updateStat("likedCount",    likedSongUris.length);

    setTimeout(hideProgress, 1500);
  } catch (err) {
    console.error(err);
    hideProgress();
    setStatus("Backup failed: " + err.message, true);
  } finally {
    setOperationActive(false);
  }
}

// ── Restore ───────────────────────────────────────────────────────────────────
async function createPlaylist(name, description, isPublic) {
  return spotifyFetch("https://api.spotify.com/v1/me/playlists", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: isPublic }),
  });
}

async function addTracksToPlaylist(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await spotifyFetch(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: chunk }),
      }
    );
  }
}

async function saveLikedSongs(uris) {
  for (let i = 0; i < uris.length; i += 50) {
    const ids = uris.slice(i, i + 50).map(u => u.split(":").pop()).filter(Boolean);
    if (!ids.length) continue;
    await spotifyFetch("https://api.spotify.com/v1/me/tracks", {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }
}

async function restoreFromFile() {
  if (_operationActive) return;

  const input = $("fileInput");
  const file  = input?.files?.[0];
  if (!file) { setStatus("Please choose a backup file first.", true); return; }

  // FIX #9: confirmation before destructive operation
  const confirmed = window.confirm(
    "This will recreate all playlists and re-like all songs from the backup file.\n\nContinue?"
  );
  if (!confirmed) return;

  try {
    setOperationActive(true);
    setStatus("Reading backup file…");
    setProgress(5, "Loading file");

    const data = JSON.parse(await file.text());

    if (!data || !Array.isArray(data.playlists) || !Array.isArray(data.likedSongUris)) {
      hideProgress();
      setStatus("Invalid backup file — missing playlists or likedSongUris.", true);
      return;
    }

    const total = data.playlists.length;
    setProgress(15, `Creating ${total} playlist(s)`);

    for (let i = 0; i < total; i++) {
      const pl = data.playlists[i];
      const created = await createPlaylist(
        pl.name || `Restored Playlist ${i + 1}`,
        pl.description || "",
        pl.public === true // FIX #10: respect original visibility
      );

      if (Array.isArray(pl.trackUris) && pl.trackUris.length > 0) {
        await addTracksToPlaylist(created.id, pl.trackUris);
      }

      const pct = 15 + ((i + 1) / Math.max(total, 1)) * 65;
      setProgress(pct, `Restored ${i + 1} of ${total} playlist(s)`);
    }

    setStatus("Restoring liked songs…");
    await saveLikedSongs(data.likedSongUris || []);
    setProgress(96, "Liked songs restored");

    setProgress(100, "Restore complete");
    setStatus(`Restore completed. ${total} playlist(s) and ${data.likedSongUris.length} liked song(s) restored.`);
    setTimeout(hideProgress, 1500);
  } catch (err) {
    console.error(err);
    hideProgress();
    setStatus("Restore failed: " + err.message, true);
  } finally {
    setOperationActive(false);
  }
}

// ── Callback page ─────────────────────────────────────────────────────────────
async function handleCallbackPage() {
  const params = new URLSearchParams(location.search);
  const error  = params.get("error");
  const code   = params.get("code");
  const state  = params.get("state");

  // FIX #1: verify state to prevent CSRF
  const savedState = localStorage.getItem(KEY.OAUTH_STATE);
  localStorage.removeItem(KEY.OAUTH_STATE);

  if (error) {
    setStatus(`Spotify login failed: ${error}`, true);
    return;
  }

  if (!code) {
    setStatus("Login failed: no authorization code returned.", true);
    return;
  }

  if (!state || state !== savedState) {
    setStatus("Login failed: state mismatch. Please try again.", true);
    return;
  }

  try {
    setStatus("Completing sign-in…");
    await exchangeCodeForToken(code);
    goHome();
  } catch (err) {
    console.error(err);
    setStatus("Login failed: " + err.message, true);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("load", async () => {
  // Wire up buttons
  $("loginBtn")  ?.addEventListener("click", login);
  $("backupBtn") ?.addEventListener("click", backupMusic);
  $("restoreBtn")?.addEventListener("click", restoreFromFile);
  $("logoutBtn") ?.addEventListener("click", logout);

  $("fileInput")?.addEventListener("change", () => {
    const f = $("fileInput").files?.[0];
    updateStat("importCount", f ? "1" : "—");
    if (f) setStatus(`File selected: ${f.name}`);
  });

  // Callback page — detect by pathname OR by presence of OAuth params in query string
  // (Cloudflare Workers may route the URL differently than Pages)
  const _cbParams = new URLSearchParams(location.search);
  const _isCallback = location.pathname.endsWith("/callback.html")
    || location.pathname.endsWith("/callback")
    || (_cbParams.has("code") || _cbParams.has("error"));
  if (_isCallback) {
    await handleCallbackPage();
    return;
  }

  // Main page boot
  if (!getToken()) {
    hideApp();
    return;
  }

  try {
    await ensureValidToken();
    showApp();
    await loadOverview();
  } catch (err) {
    console.error(err);
    localStorage.removeItem(KEY.ACCESS_TOKEN);
    localStorage.removeItem(KEY.REFRESH_TOKEN);
    localStorage.removeItem(KEY.EXPIRES_AT);
    hideApp();
    setStatus("Session expired. Please sign in again.", true);
  }
});
