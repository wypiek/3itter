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
- **Desktop notifications** while 3itter is open in a background tab (Settings → Notifications).
- **Link previews:** Open Graph / Twitter Card tags, oEmbed and a Mastodon-compatible status endpoint, so shared links get FixupX-style embeds in Discord and others.
- **Timelines:** "For you" (engagement × recency) and "Following".
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
  - **Users:** verify, set roles (admin / moderator), suspend, purge posts.
  - **Federation:** connect, approve, disconnect or block instances.
  - **Instance:** name, description, contact, rules, minimum age, open/closed sign-ups.
  - **Audit log.**
- **Terms of Service** (`/terms`) and **Privacy Policy** (`/privacy`). Both are readable without an account and fill in the instance's name, domain, contact and rules.
  They are *templates*. Have them reviewed for your jurisdiction before opening an instance to the public.

## Android app

`android/` contains the 3itter Android client: a Rust ([Tauri v2](https://tauri.app)) app around the system WebView.

- It starts on an **instance picker**: enter any 3itter instance's address. The picker checks `/.well-known/3itter` to make sure the server really runs 3itter, remembers it, and opens it next time.
- Inside an instance, the web app knows it's running in the app. The sign-in screen and the account menu get a **Switch instance** button that returns to the picker, so you can change instances after logging out.
- Build a signed APK with `android/build-apk.sh`. You need Rust (rustup) with Android targets, JDK 17, the Android SDK and the NDK. The script expects them in `~/.local/opt/android-build`; override that with `TOOLCHAIN=...`.
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
other pride flags in `public/flags/` were drawn for 3itter in the same style. Fonts: Roboto Flex and Material Symbols (Google Fonts).

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
