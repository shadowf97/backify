# Backify

Browser-based Spotify playlist & liked-song backup/restore tool.  
Zero backend. All data stays in your browser.

---

## Project structure

```
backify/
├── index.html       ← Main app UI
├── callback.html    ← OAuth redirect handler
├── app.js           ← All logic (auth, backup, restore)
├── config.js        ← Spotify app credentials & config
├── _headers         ← Cloudflare Pages security headers
├── _redirects       ← Cloudflare Pages redirect rules
└── assets/
    └── backify-icon.png
```

---

## Deploy to Cloudflare Pages (recommended)

### Option A — Git-connected deploy (easiest)

1. Push this folder to a GitHub / GitLab repo.
2. Go to [Cloudflare Pages](https://pages.cloudflare.com) → **Create a project** → Connect to Git.
3. Select your repo.
4. **Build settings**: leave blank (no build command, no build output directory — deploy root as-is).
5. Click **Save and Deploy**.
6. Note your Pages URL, e.g. `https://backify.pages.dev`.

### Option B — Direct upload (no Git)

1. Go to [Cloudflare Pages](https://pages.cloudflare.com) → **Create a project** → **Direct Upload**.
2. Drag-and-drop the entire `backify/` folder.
3. Note your Pages URL.

---

## Configure Spotify

1. Open [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Select your app (or create one).
3. Click **Edit Settings**.
4. Under **Redirect URIs**, add:
   ```
   https://<your-pages-domain>/callback.html
   ```
   e.g. `https://backify.pages.dev/callback.html`
5. Save.

Then update `config.js`:
```js
window.BACKIFY_CONFIG = {
  SPOTIFY_CLIENT_ID: "<your client id>",
  REDIRECT_URI:      "https://<your-pages-domain>/callback.html",
  APP_BASE_PATH:     "/",
  APP_NAME:          "Backify"
};
```

---

## Spotify Development Mode limits

While your Spotify app is in **Development Mode**, only up to 25 allowlisted
users can log in.

To allow users:
1. Spotify Developer Dashboard → your app → **Users and Access**.
2. Add each user's Spotify email.

To go beyond 25 users, apply for **Extended Quota Mode** via the Dashboard.

---

## What was fixed (vs original)

| # | Issue | Fix |
|---|-------|-----|
| 1 | No CSRF protection | `state` param added to OAuth flow, verified on callback |
| 2 | Buttons not locked during operations | `setOperationActive()` disables all controls |
| 3 | No rate-limit handling | 429 + `Retry-After` respected, up to 4 retries |
| 4 | Token refresh race condition | Singleton refresh promise |
| 5 | No 401 auto-retry | One transparent retry after refresh |
| 6 | `fetchAllPages` infinite-loop risk | 500-page guard added |
| 7 | Duplicate `limit=` query param | `URL` constructor used instead of string concat |
| 8 | `loadOverview` fetched all pages just to count | Uses paged `total` field — 2 API calls instead of N |
| 9 | No restore confirmation | `confirm()` before destructive operation |
| 10 | Restore always created private playlists | Respects `playlist.public` from backup |
| 11 | Stale profile cache after account switch | Cache cleared on 401 |

---

## License

MIT
