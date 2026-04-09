# Backify

![Visit Backify](https://app.backify.workers.dev)

Spotify Playlist and Library Backup Tool

Backify is a browser-based application that allows users to back up and restore their Spotify playlists and liked songs into a single JSON file.

All operations are performed client-side. No user data is stored on any external server.

---

## Overview

Backify connects to a user’s Spotify account using the Authorization Code Flow with PKCE and retrieves playlist and library data. The application then generates a structured backup file which can later be used to restore the same data.

---

## Demo

### Login Interface

![Login UI](https://i.ibb.co.com/s9C89jL5/demo-login.png)

### Dashboard After Login

![Dashboard UI](https://i.ibb.co.com/NdNncTVQ/demo-dashboard.png)

---

## Features

* Spotify authentication using OAuth 2.0 (PKCE)
* Backup of all playlists including track data
* Backup of liked songs
* Export to a single JSON file
* Restore playlists and liked songs from backup
* Progress tracking during backup and restore
* Fully client-side execution with no backend dependency

---

## Technology Stack

* HTML, CSS, JavaScript (Vanilla)
* Spotify Web API
* OAuth 2.0 Authorization Code Flow with PKCE
* LocalStorage for session management
* Static hosting (Cloudflare)

---

## Project Structure

```text
backify/
├── index.html
├── callback.html
├── app.js
├── config.js
└── assets/
```

---

## Setup Instructions

1. Clone the repository:

```bash
git clone https://github.com/shadowf97/backify.git
```

2. Configure the application:

Edit `config.js` and update the following:

```js
window.BACKIFY_CONFIG = {
  SPOTIFY_CLIENT_ID: "YOUR_CLIENT_ID",
  REDIRECT_URI: "https://your-domain/callback.html",
  APP_BASE_PATH: "/",
  APP_NAME: "Backify"
};
```

3. Configure Spotify Developer Dashboard:

Add the following Redirect URI:

```text
https://your-domain/callback.html
```

4. Deploy the project:

You can deploy using:

* Cloudflare Pages (recommended)
* Netlify

---

## How It Works

### Authentication

The user logs in using Spotify. The app uses PKCE to securely obtain access and refresh tokens.

### Backup

* Fetch user profile
* Fetch playlists and their tracks
* Fetch liked songs
* Generate and download a JSON backup file

### Restore

* Upload backup file
* Recreate playlists
* Re-add tracks to playlists
* Restore liked songs to the library

---

## Limitations

* Spotify Development Mode restricts usage to allowlisted users
* Maximum of five users unless quota extension is approved
* Some playlists may not be accessible due to permission restrictions
* Some tracks may not restore due to regional or availability limitations

---

## Security

* Uses Authorization Code Flow with PKCE
* No client secret exposed in frontend
* Tokens stored locally in browser
* No external storage or server involved

---

## Future Improvements

* Selective playlist backup and restore
* Duplicate handling during restore
* Cloud-based backup integration
* Multi-account support



---

## License

This project is intended for educational and personal use.
