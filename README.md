# 3itter — Material 3 Twitter

A small social platform with a Twitter-style layout, built on a hand-made **Material 3 Expressive** design system,
with its own **3itter-only federation protocol**. There are no dependencies: the server uses Node's built-in
`node:http`, `node:sqlite` and `node:crypto`, and the browser runs vanilla ES modules.

## Run

```sh
npm start            # http://127.0.0.1:3000
npm run dev          # same, restarts on server changes
```

Requires Node 22.13+ (tested on Node 26). The database lives in `data/` and is seeded with demo accounts on first run.
Demo accounts can't be signed into.

**The first account you create becomes the instance admin.** Instances upgraded from v1 promote their oldest real account.

| Env var                  | Default                  | Purpose |
| ------------------------ | ------------------------ | ------- |
| `PORT`                   | `3000`                   | HTTP port |
| `HOST`                   | `127.0.0.1`              | Bind address (`0.0.0.0` to expose) |
| `PUBLIC_URL`             | `http://HOST:PORT`       | Public address. Its host is the instance's **federation domain**. Set it before federating and don't change it afterwards. |
| `DATA_DIR`               | `./data`                 | SQLite database and uploads |
| `SEED`                   | `1`                      | `0` skips demo content on a new database |
| `SECURE_COOKIES`         | auto (on for https)      | Force `Secure` cookies |
| `TRUST_PROXY`            | unset                    | `1` to read the client IP from `X-Forwarded-For` |
| `FEDERATION_ALLOW_HTTP`  | auto (on if PUBLIC_URL is http) | Allow federating over plain HTTP (dev only) |
| `ADMIN_HANDLE`           | unset                    | Only this handle can become the first admin (recommended for public instances) |
| `COOKIE_NAME`            | derived from domain      | Session cookie name |

Upgrading from Orbit: `orbit.db` is renamed to `3itter.db` automatically, and saved theme settings carry over.

Admin CLI: `npm run admin -- promote|moderator|demote|verify|unverify|unsuspend <handle>` or `npm run admin -- list`.

## Features

- **Posting:** up to 500 characters, replies and threads, quote posts, reposts, likes, bookmarks, and **pinned posts**.
- **Media:** up to **4 images** per post with **alt text**, a gallery viewer, **sensitive-media** blur, and paste or drag-and-drop uploads.
- **Video:** one MP4, WebM or MOV per post (default limit 50 MB, `MAX_VIDEO_MB`). It uploads as soon as you pick it, with a progress bar. The poster frame is taken in the browser, so the server never decodes video. Videos stream with HTTP range requests, federate (the file stays on its home instance; the poster is copied) and show as `og:video` in link previews.
- **Link previews:** the first link in a post gets a card (title, description, site, image). The server fetches the page itself, so readers never contact the linked site: only ports 80/443, private and local addresses are refused at connect time, at most 4 redirects, a 6 s timeout and a size cap. The preview image is stored with the uploads and cards are cached (`server/unfurl.js`).
- **Affiliations:** admins mark accounts as **organizations** (Admin → user → Make organization). An organization invites accounts in Settings → Affiliation, with an optional label such as "Engineer". The affiliation only shows once the person accepts, and either side can end it. Affiliated accounts show the organization's avatar as a small badge next to their name, plus an "Affiliated with …" line on their profile; organizations get an **Affiliates** tab. Affiliations federate.
- **Bots:** Settings → Bots & API marks an account as **Automated** (a robot badge, optionally "run by @someone"), and creates **personal API tokens** with `read`, `write` and `messages` scopes. Tokens are shown once and stored hashed. They work as `Authorization: Bearer 3tt_…` on the whole API, including the realtime stream and video uploads. Passwords, sessions, tokens, account deletion and admin stay cookie-only. Docs are at **`/developers`** on every instance, and there's a zero-dependency example bot in `examples/bots/echo-bot.mjs`.
- **Profile picture editor:** drag to position, pinch / scroll / slider to zoom, rotate, previewed in your avatar shape (banners get a 3:1 frame). GIFs can keep their animation.
- **Content warnings:** a post can hide behind a short warning.
- **Polls:** 2–4 choices, single or multiple choice, open from 1 hour to 7 days. Polls work across federated instances.
- **Editing:** posts can be edited for 30 minutes, with an "Edited" label and the full edit history.
- **Reply controls:** everyone, only people you follow, or only people you mention.
- **Composer:** @mention and #hashtag autocomplete, a character ring, and emoji.
- **Keyboard shortcuts:** `j`/`k`, `l`, `r`, `t`, `b`, `n`, `/`, `g h`…; press `?` for the full list.
- **"Show new posts" pill** on the home timeline, and **search tabs** (Posts / People / Media).
- **Installable** as an app (web manifest), plus an **RSS feed** per account at `/u/:handle/rss.xml`.
- **Notifications:** likes, reposts and follows are grouped ("Ana, Ben and 3 others liked your post"), with **All / Mentions** tabs.
- **Post details:** tap the repost, quote or like count to see **who reposted, quoted or liked** a post.
- **Muted words:** words, phrases or #hashtags hidden from your timelines, search and replies (Settings → Privacy & safety).
- **Profiles:** "Followed by people you follow", and the **Media tab** shows an image grid.
- **Messages:** you can delete your own messages.
- **Small things:** composer **drafts are saved automatically**, **recent searches**, the native **share sheet** on phones, and timestamps that update live.
- **Lists:** curated timelines of the accounts you pick, public or private. Add people from their profile (••• → Add to lists).
- **Scheduling:** schedule posts up to 90 days ahead from the composer (clock button), and manage them at `/scheduled` (change time, post now, cancel).
- **Threads:** "Add another post" in the composer publishes a chain of replies in one go.
- **View counts:** a post counts a view when it stays on screen for a second, once per person per day. Authors aren't counted, and signed-out link previews count anonymously. Views also show in embeds (👁).
- **Hide replies:** hide replies on your own posts; people can still open them under "Hidden replies".
- **Search operators:** `from:` `to:` `has:media|poll|links` `since:YYYY-MM-DD` `until:` `"exact phrase"` `-exclude` (see the ⚙ tips in Explore).
- **Messages:** "Seen" read receipts.
- **Admin:** a site-wide **announcement** banner (dismissible, can expire), and **invite codes** for invite-only sign-ups.
- **Content filter** (`server/wordfilter.js`): handles and display names are checked for slurs, profanity and adult content. It sees through leetspeak (f4gg0t), look-alike letters, repeated letters, dotted or underscored splits and CamelCase.
  Whole-word and prefix rules plus an allow-list avoid false positives (Scunthorpe, cocktail, Sussex, analysis, Fagan).
  Reserved handles (admin, support, staff…) can't be registered. Bios block slurs by default; posts are unfiltered unless an admin turns it on.
  Admin → Instance → Content filter has extra blocked, allowed and reserved words and **Scan accounts**, which finds existing offenders.
  From there admins can suspend an account, change its handle, reset its display name, clear its bio or delete it.
- **Account switcher:** stay signed in to up to 5 accounts in one browser and switch from the account menu (or the mobile drawer). Logging out moves you to the next account. Tokens stay in HttpOnly cookies.
- **Mobile:** a navigation drawer from your avatar, a bottom bar and compose button that hide while you scroll, pull-to-refresh, and bigger touch targets.
- **Realtime:** notifications, messages and unread badges arrive instantly over Server-Sent Events (`/api/stream`), with a snackbar in the app or a desktop notification when the tab is in the background (Settings → Notifications).
- **"3itter for …":** posts show the device they were written on (3itter for Android, iPhone, Windows, Mac…). It can be turned off in Settings → Privacy & safety.
- **Languages:** English, Polski, Deutsch, Español, Français, Português, Українська, Italiano, Nederlands, Türkçe, Čeština and 日本語. The language is picked automatically from where you sign in (Cloudflare's country header, then the browser) and can be changed in Settings → Language or on the landing page. Translations live in `public/js/i18n/strings.js` and `strings-extra.js` (same layout, so a language can be added without touching every row) and are shared with the Android app.
- **Devices & sessions:** every signed-in browser and app, with device, approximate country, IP and last activity. Sign out one or all others.
- **Embeds of 3itter links:** Open Graph / Twitter Card tags, oEmbed and a Mastodon-compatible status endpoint, so shared links get FixupX-style embeds in Discord and others.
- **Timelines:** "Following", and a personalised **"For you"** (`server/feed.js`): engagement, people you follow, what they liked or reposted, accounts you interact with, freshness, a damper so one account can't flood the feed, and stable paging.
- **Profiles:** banner, avatar photo, 14 avatar **shapes**, colour, **pronouns**, up to 4 **pride flags**, and a **verified badge**.
- **Safety:** **block**, **mute**, **report** posts or accounts, and choose who can DM you (everyone / people you follow / no one).
- **Account:** change password, see and sign out sessions, **download your data** (JSON), **delete your account**.
- **Passkeys (WebAuthn):** sign in with Face ID, Touch ID, Windows Hello, Android screen lock, a password manager or a security key. There's a "Sign in with a passkey" button, and passkeys also appear in the handle field's autofill.
  Manage them in Settings → Account (add, rename, remove). Verification is done in `server/passkeys.js` with `node:crypto`: ES256, EdDSA and RS256; challenge, origin and RP ID checks; signature counters.
  The RP ID is the hostname of `PUBLIC_URL`, so passkeys work on HTTPS domains and on `http://localhost` (not on raw IP addresses).
  Changing the domain invalidates existing passkeys.
- **Settings:** account, privacy & safety, per-type notification switches, appearance (theme, 12 colours, text size, higher contrast, reduce motion), federation, about.
- **Admin panel** (`/admin`):
  - **Overview:** stats and 14-day activity charts.
  - **Reports:** a queue with dismiss / delete / suspend actions.
  - **Users:** verify, set roles (admin / moderator), suspend, purge posts, and (admins only) **reset a password** for someone who's locked out: a generated temporary password shown once, or one you type, optionally signing them out everywhere. Resets are in the audit log; the password never is.
  - **Federation:** connect, approve, disconnect or block instances.
  - **Instance:** name, description, contact, rules, minimum age, open/closed sign-ups.
  - **Audit log.**
- **Terms of Service** (`/terms`) and **Privacy Policy** (`/privacy`). Both are readable without an account and fill in the instance's name, domain, contact and rules.
  They are *templates*. Have them reviewed for your jurisdiction before opening an instance to the public.

## Android app

`android/` is a **native** Android client written in Rust. The UI is [Slint](https://slint.dev) (`android/ui/*.slint`), drawn by Skia in a `NativeActivity`. There is no WebView, and no Java code apart from Slint's small built-in keyboard helper.

- **Screens:** instance picker, sign in / sign up, home ("For you" / "Following"), explore (trends, who to follow, search for posts and people), notifications, messages and chats, profiles, threads with quick reply, a composer, settings, devices & sessions, and language.
- **Instance picker:** enter any 3itter instance's address. The app checks `/.well-known/3itter`, remembers instances and their sign-ins, and can switch instances at any time.
- **Same server, same language:** the app speaks the JSON API, signs posts as "3itter for Android", and uses the instance's translation table (and its automatic language choice).
- **Notifications:** while the app is running it keeps the realtime stream open. New activity and messages update the badges live and become Android notifications ("Activity" and "Messages" channels) when the app isn't on screen. Fully closed apps get nothing until next launch: real push would need a push service (FCM).
- **Composer:** text, up to 4 photos, a video (uploaded right away), a poll, emoji, a content warning, sensitive media, who can reply, and scheduling (presets or a date and time picker).
- **Photos and videos** come from the system picker. `android/java/.../MainActivity.java` is a tiny `NativeActivity` subclass that opens the picker, reads the files and hands them to Rust over JNI; it also opens links and the share sheet. Everything else is Rust.
- **Settings:** edit profile (with photo and banner), privacy & safety (who can message you, discoverability, the device label, muted words, blocked and muted accounts), notifications, appearance (system, light or dark), language, devices & sessions, password and instance info.
- Pull down on the home feed to refresh. Link previews, pride flags, affiliation and bot badges show like on the web.
- **Videos** show their poster frame with a play badge; playback is in the web app.
- Develop on the desktop with `cargo run` in `android/`. `ITTER_SCRIPT=steps.txt` renders headlessly with the software renderer and takes screenshots (see `src/main.rs`).
- Build a signed APK with `android/build-apk.sh`. You need Rust (rustup) with the Android targets, a JDK, the Android SDK (build-tools, a platform) and the NDK. The script expects them in `~/.local/opt/android-build`; override that with `TOOLCHAIN=...`. It builds `libitter.so`, packs it with `aapt2`, aligns it for 16 KB pages and signs it.
  It creates a signing key next to the toolchain on first run. Keep that key: every update must be signed with it.

## Federation (3itter ↔ 3itter only)

An ActivityPub-inspired protocol that only 3itter instances speak:

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/3itter` | Discovery: `software: "3itter"`, protocol version, domain, base URL, name, Ed25519 public key |
| `POST /fed/inbox` | Receives signed activities |
| `GET /fed/users/:handle` | Signed, connected peers only: profile and recent posts |

- **Signatures:** every request between instances is signed with the sender's Ed25519 key over
  `METHOD path\ndomain\ntimestamp\nsha256(body)`. Requests older than 5 minutes, replays (activity id dedupe) and
  actors that don't belong to the sending domain are rejected.
- **Peering is mutual:** admin A adds B's URL, which sends `peer.request`. B's admin approves it, which sends `peer.accept`.
  If both admins add each other, the instances connect automatically. Software that isn't 3itter is refused at discovery.
- **Activities:** `follow`/`unfollow`, `post.create`/`post.delete`, `like`/`unlike`, `repost`/`unrepost`, `post.counts`,
  `message` (DMs), `user.update`, `user.delete`, `peer.remove`/`peer.reject`.
- **Delivery:** through a persistent outbox with exponential backoff (up to 10 attempts). Remote images are copied locally.
- **Remote people:** look like `@bob@other.domain`. Search that address in Explore to load and follow them.
- **Disconnecting or blocking an instance** hides its people and posts. Reconnecting restores them.

Try it locally with two instances:

```sh
PORT=3001 DATA_DIR=./data-a npm start
PORT=3002 DATA_DIR=./data-b SEED=0 npm start
```

Sign up on both. On instance A go to Admin → Federation and connect `http://127.0.0.1:3002`. Approve the request on B.
Then search `@yourhandle@127.0.0.1:3002` on A.

## Credits

Rainbow and transgender flag graphics are from [Twemoji](https://github.com/jdecked/twemoji), © Twitter, Inc. and other
contributors, licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Twemoji only covers Unicode emoji, so the
other pride flags in `public/flags/` were drawn for 3itter in the same style. Fonts: Roboto Flex and Material Symbols (Google Fonts);
the Android app bundles a subset of Material Symbols Rounded (Apache 2.0) in `android/ui/fonts/`. The Android UI uses [Slint](https://slint.dev)
under its royalty-free license.

## Layout

```
server/      index.js (entry) · http.js · db.js (schema + migrations) · core.js · api.js · admin.js
             federation.js · seed.js · cli.js
public/
  css/       tokens.css · components.css · app.css
  js/        app.js (shell, router, actions) · views.js · settings.js · adminView.js · docs.js · dialogs.js · ui.js · store.js
  js/lib/    api · html · motion · shapes · theme · flags
  flags/     pride flag SVGs
```
