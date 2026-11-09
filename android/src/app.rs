//! App state, navigation and API wiring. Everything here runs on the UI thread; network calls run
//! on worker threads (`bg`) and post their results back with `slint::invoke_from_event_loop`.

use crate::api::{Api, ApiError, J};
use crate::store::{Instance, Store};
use crate::{i18n, images, theme, timefmt};
use crate::{AppState, AppWindow, Author, ComposeImage, Conv, I18n, Lang, Message, Notif, Post, Profile, SavedInstance, Session, SheetItem, Theme, Trend, UserRow};
use serde_json::{json, Value};
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

struct Models {
    feed: Rc<VecModel<Post>>,
    thread: Rc<VecModel<Post>>,
    replies: Rc<VecModel<Post>>,
    search_posts: Rc<VecModel<Post>>,
    profile_posts: Rc<VecModel<Post>>,
    notifications: Rc<VecModel<Notif>>,
    conversations: Rc<VecModel<Conv>>,
    chat: Rc<VecModel<Message>>,
    search_users: Rc<VecModel<UserRow>>,
    suggestions: Rc<VecModel<UserRow>>,
    trends: Rc<VecModel<Trend>>,
    sessions: Rc<VecModel<Session>>,
    languages: Rc<VecModel<Lang>>,
    instances: Rc<VecModel<SavedInstance>>,
    sheet: Rc<VecModel<SheetItem>>,
    compose_images: Rc<VecModel<ComposeImage>>,
    muted_words: Rc<VecModel<SharedString>>,
    blocked: Rc<VecModel<UserRow>>,
    muted: Rc<VecModel<UserRow>>,
    about_rules: Rc<VecModel<SharedString>>,
}

impl Models {
    fn post_models(&self) -> [&Rc<VecModel<Post>>; 5] {
        [&self.feed, &self.thread, &self.replies, &self.search_posts, &self.profile_posts]
    }
}

struct App {
    ui: slint::Weak<AppWindow>,
    api: Arc<Api>,
    store: Store,
    instance: Value,
    me: Value,
    current: String,
    stack: Vec<String>,
    feed_next: Option<i64>,
    feed_busy: bool,
    notif_next: Option<i64>,
    notif_busy: bool,
    profile_handle: String,
    profile_next: Option<i64>,
    profile_busy: bool,
    thread_id: i64,
    chat_handle: String,
    compose_reply: Option<i64>,
    compose_quote: Option<i64>,
    sheet_actions: Vec<Rc<dyn Fn()>>,
    toast_gen: u64,
    compose_images: Vec<String>,       // data URLs, in the order shown
    compose_video_id: Option<String>,
    compose_upload_gen: u64,
    schedule_at: Option<i64>,
    schedule_date: Option<(i32, i32, i32)>,
    m: Models,
}

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut App) -> R) -> R {
    APP.with(|a| f(a.borrow_mut().as_mut().expect("app not started")))
}

fn ui() -> AppWindow {
    with(|a| a.ui.upgrade()).expect("window gone")
}

thread_local! {
    // One strong handle kept for the app's lifetime, so globals can be reached from anywhere.
    static WINDOW: std::cell::OnceCell<&'static AppWindow> = const { std::cell::OnceCell::new() };
}

fn st() -> AppState<'static> {
    WINDOW.with(|w| *w.get().expect("window not created")).global::<AppState>()
}

/// Run `work` on a worker thread, then `done` on the UI thread.
fn bg<R: Send + 'static>(work: impl FnOnce(&Api) -> R + Send + 'static, done: impl FnOnce(R) + Send + 'static) {
    let api = with(|a| a.api.clone());
    std::thread::spawn(move || {
        let r = work(&api);
        let _ = slint::invoke_from_event_loop(move || done(r));
    });
}

/// UI callbacks are deferred to the next event-loop turn so they never re-enter `with`.
fn later(f: impl FnOnce() + Send + 'static) {
    let _ = slint::invoke_from_event_loop(f);
}

fn toast(msg: impl Into<String>) {
    let msg: String = msg.into();
    let gen = with(|a| {
        a.toast_gen += 1;
        a.toast_gen
    });
    st().set_toast(msg.into());
    slint::Timer::single_shot(std::time::Duration::from_millis(3200), move || {
        if with(|a| a.toast_gen) == gen {
            st().set_toast(SharedString::new());
        }
    });
}

fn fail(e: ApiError) {
    if e.status == 401 {
        // Signed out elsewhere (or the session expired).
        with(|a| a.api.clear_cookies());
        save_cookies();
        st().set_screen("auth".into());
    }
    toast(e.message);
}

fn t(s: &str) -> SharedString {
    i18n::t(s).into()
}

// ------------------------------------------------------------------ JSON -> UI rows

fn author(u: &Value) -> Author {
    let api = with(|a| a.api.clone());
    let mut handle = u.s("handle");
    let domain = u.s("domain");
    if !domain.is_empty() {
        handle = format!("{handle}@{domain}");
    }
    let mut name = u.s("name");
    if name.is_empty() {
        name = handle.clone();
    }
    let letter: String = name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into());
    let (bg, fg) = theme::avatar_colors(u.i("hue"));
    let url = api.abs(&u.s("avatar"));
    // Pride flags (PNG copies served by the instance) and the affiliation badge.
    let flag_urls: Vec<String> = u["flags"].as_array().map(|a| a.iter().filter_map(|f| f.as_str())
        .filter(|f| f.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).take(4)
        .map(|f| format!("{}/flags/png/{f}.png", api.base())).collect()).unwrap_or_default();
    let flags: Vec<slint::Image> = flag_urls.iter().map(|f| images::get(f, 128)).collect();
    let aff = &u["affiliation"];
    let has_aff = aff.is_object() && !aff.s("handle").is_empty();
    let aff_url = if has_aff { api.abs(&aff.s("avatar")) } else { String::new() };
    let aff_name = if aff.s("name").is_empty() { aff.s("handle") } else { aff.s("name") };
    Author {
        flags: ModelRc::new(VecModel::from(flags)),
        flag_urls: flag_urls.join(" ").into(),
        bot: u["bot"].is_object(),
        has_aff,
        aff_letter: aff_name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default().into(),
        aff_name: aff_name.into(),
        aff_handle: aff.s("handle").into(),
        aff_label: aff.s("label").into(),
        aff_color: theme::oklch(0.55, 0.15, aff.i("hue") as f32),
        aff_avatar: images::get(&aff_url, 96),
        aff_url: aff_url.into(),
        name: name.into(),
        handle: handle.into(),
        letter: letter.into(),
        color: bg,
        on_color: fg,
        avatar: images::get(&url, 192),
        avatar_url: url.into(),
        verified: u.b("verified"),
        pronouns: u.s("pronouns").into(),
    }
}

const CLIENTS: [(&str, &str, &str); 13] = [
    ("android-app", "Android", "android"),
    ("vr", "VR", "devices"),
    ("quest", "Meta Quest", "devices"),
    ("vr-web", "VR Web", "devices"),
    ("iphone", "iPhone", "phone_iphone"),
    ("ipad", "iPad", "tablet_mac"),
    ("android", "Android Web", "smartphone"),
    ("windows", "Windows", "computer"),
    ("mac", "Mac", "computer"),
    ("linux", "Linux", "computer"),
    ("chromeos", "ChromeOS", "computer"),
    ("web", "Web", "language"),
    ("api", "API", "terminal"),
];

fn post_row(p: &Value) -> Post {
    let api = with(|a| a.api.clone());
    let images_list = p["images"].as_array().cloned().unwrap_or_default();
    let video = &p["video"];
    let is_video = video.is_object();
    let image_url = if is_video {
        api.abs(&video.s("poster"))
    } else {
        images_list.first().map(|i| api.abs(&i.s("src"))).unwrap_or_default()
    };
    let counts = &p["counts"];
    let viewer = &p["viewer"];
    let (context, context_icon) = if p["repostedBy"].is_object() {
        (format!("{} {}", i18n::t("Reposted by"), p["repostedBy"].s("name")), "repeat")
    } else if !p.s("replyToHandle").is_empty() {
        (format!("{} @{}", i18n::t("Replying to"), p.s("replyToHandle")), "chat_bubble")
    } else {
        (String::new(), "")
    };
    let client = p.s("client");
    let (client_label, client_icon) = CLIENTS.iter().find(|c| c.0 == client)
        .map(|c| (i18n::t1("3itter for {device}", &i18n::t(c.1)), c.2)).unwrap_or_default();
    let q = &p["quote"];
    let (quote_author, quote_text) = if q.is_object() && !q.b("deleted") {
        (format!("{} @{}", q["author"].s("name"), q["author"].s("handle")), q.s("text"))
    } else if q.is_object() {
        (i18n::t("This post is unavailable."), String::new())
    } else {
        (String::new(), String::new())
    };
    let created = p.i("createdAt");
    let card = &p["card"];
    let card_image = if card.is_object() { api.abs(&card.s("image")) } else { String::new() };
    Post {
        id: p.i("id") as i32,
        author: author(&p["author"]),
        time: timefmt::rel(created).into(),
        full_time: timefmt::full(created).into(),
        text: p.s("text").into(),
        image: images::get(&image_url, 1280),
        image_ratio: images::ratio(&image_url),
        image_url: image_url.into(),
        image_count: if is_video { 1 } else { images_list.len() as i32 },
        is_video,
        replies: counts.i("replies") as i32,
        reposts: counts.i("reposts") as i32,
        likes: counts.i("likes") as i32,
        views: counts.i("views") as i32,
        liked: viewer.b("liked"),
        reposted: viewer.b("reposted"),
        bookmarked: viewer.b("bookmarked"),
        context: context.into(),
        context_icon: context_icon.into(),
        client: client_label.into(),
        client_icon: client_icon.into(),
        cw: p.s("cw").into(),
        quote_text: quote_text.into(),
        quote_author: quote_author.into(),
        edited: p.i("editedAt") > 0,
        card_url: card.s("url").into(),
        card_title: card.s("title").chars().take(140).collect::<String>().into(),
        card_site: card.s("site").into(),
        card_desc: card.s("description").chars().take(160).collect::<String>().into(),
        card_image: images::get(&card_image, 960),
        card_image_url: card_image.into(),
        card_large: card.b("large"),
    }
}

fn posts_of(v: &Value) -> Vec<Post> {
    v.as_array().map(|a| a.iter().filter(|p| !p.b("deleted")).map(post_row).collect()).unwrap_or_default()
}

fn user_row(u: &Value) -> UserRow {
    let me = with(|a| a.me.s("handle"));
    UserRow {
        author: author(u),
        bio: u.s("bio").into(),
        following: u.b("isFollowing"),
        follows_you: u.b("followsYou"),
        is_me: u.s("handle") == me && u.s("domain").is_empty(),
    }
}

fn notif_row(n: &Value) -> Notif {
    let actors = n["actors"].as_array().cloned().unwrap_or_default();
    let first = actors.first().cloned().unwrap_or(Value::Null);
    let count = n.i("actorCount").max(actors.len() as i64);
    let name = |u: &Value| { let s = u.s("name"); if s.is_empty() { u.s("handle") } else { s } };
    let who = match count {
        0 | 1 => name(&first),
        2 => format!("{} {} {}", name(&first), i18n::t("and"), actors.get(1).map(name).unwrap_or_default()),
        _ => format!("{} {}", name(&first), i18n::tf(if count - 1 == 1 { "and {n} other" } else { "and {n} others" }, &[("n", &(count - 1).to_string())])),
    };
    let kind = n.s("type");
    let (icon, action) = match kind.as_str() {
        "like" => ("favorite", "liked your post"),
        "repost" => ("repeat", "reposted your post"),
        "follow" => ("person_add", "followed you"),
        "reply" => ("chat_bubble", "replied to you"),
        "mention" => ("alternate_email", "mentioned you"),
        "affiliation" => ("apartment", "invited you to be affiliated with them"),
        _ => ("format_quote", "quoted your post"),
    };
    let post = &n["post"];
    let snippet = if post.is_object() { if post.s("cw").is_empty() { post.s("text") } else { format!("⚠ {}", post.s("cw")) } } else { String::new() };
    Notif {
        id: n.i("id") as i32,
        icon: icon.into(),
        kind: kind.into(),
        text: format!("{who} {}", i18n::t(action)).into(),
        snippet: snippet.into(),
        time: timefmt::rel(n.i("createdAt")).into(),
        post_id: if post.is_object() { post.i("id") as i32 } else { 0 },
        handle: first.s("handle").into(),
        author: author(&first),
        more: (count - 1).max(0) as i32,
        unread: !n.b("read"),
    }
}

fn set_models<T: Clone + 'static>(model: &Rc<VecModel<T>>, rows: Vec<T>) {
    model.set_vec(rows);
}

// ------------------------------------------------------------------ live updates

/// A picture finished loading: patch every row that shows it.
fn image_ready(url: &str) {
    let Some(img) = images::cached(url) else { return };
    let fix_author = |a: &mut Author| -> bool {
        let mut changed = false;
        if a.avatar_url.as_str() == url { a.avatar = img.clone(); changed = true; }
        if a.aff_url.as_str() == url { a.aff_avatar = img.clone(); changed = true; }
        if a.flag_urls.split(' ').any(|f| f == url) {
            let flags: Vec<slint::Image> = a.flag_urls.split(' ').filter(|f| !f.is_empty()).map(|f| images::cached(f).unwrap_or_default()).collect();
            a.flags = ModelRc::new(VecModel::from(flags));
            changed = true;
        }
        changed
    };
    let m = with(|a| {
        (a.m.post_models().map(|m| m.clone()), a.m.notifications.clone(), a.m.conversations.clone(),
         a.m.search_users.clone(), a.m.suggestions.clone())
    });
    for model in m.0.iter() {
        for i in 0..model.row_count() {
            let mut p = model.row_data(i).unwrap();
            let mut changed = fix_author(&mut p.author);
            if p.image_url.as_str() == url {
                p.image = img.clone();
                p.image_ratio = images::ratio(url);
                changed = true;
            }
            if p.card_image_url.as_str() == url {
                p.card_image = img.clone();
                changed = true;
            }
            if changed { model.set_row_data(i, p); }
        }
    }
    for i in 0..m.1.row_count() {
        let mut n = m.1.row_data(i).unwrap();
        if fix_author(&mut n.author) { m.1.set_row_data(i, n); }
    }
    for i in 0..m.2.row_count() {
        let mut c = m.2.row_data(i).unwrap();
        if fix_author(&mut c.author) { m.2.set_row_data(i, c); }
    }
    for model in [&m.3, &m.4] {
        for i in 0..model.row_count() {
            let mut u = model.row_data(i).unwrap();
            if fix_author(&mut u.author) { model.set_row_data(i, u); }
        }
    }
    let s = st();
    let mut me = s.get_me();
    if fix_author(&mut me) { s.set_me(me); }
    let mut cw = s.get_chat_with();
    if fix_author(&mut cw) { s.set_chat_with(cw); }
    let mut p = s.get_profile();
    let mut changed = fix_author(&mut p.author);
    if images::cached(url).is_some() && profile_banner_url() == url {
        p.banner = img.clone();
        changed = true;
    }
    if changed { s.set_profile(p); }
}

thread_local! {
    static BANNER: RefCell<String> = const { RefCell::new(String::new()) };
}
fn profile_banner_url() -> String {
    BANNER.with(|b| b.borrow().clone())
}

/// The server returned a fresh copy of a post: update it wherever it's shown (keeping list context).
fn update_post(v: &Value) {
    let fresh = post_row(v);
    let models = with(|a| a.m.post_models().map(|m| m.clone()));
    for model in models.iter() {
        for i in 0..model.row_count() {
            let old = model.row_data(i).unwrap();
            if old.id == fresh.id {
                let mut p = fresh.clone();
                p.context = old.context.clone();
                p.context_icon = old.context_icon.clone();
                model.set_row_data(i, p);
            }
        }
    }
}

fn find_post(id: i32) -> Option<Post> {
    let models = with(|a| a.m.post_models().map(|m| m.clone()));
    models.iter().find_map(|m| m.iter().find(|p| p.id == id))
}

fn remove_post(id: i32) {
    let models = with(|a| a.m.post_models().map(|m| m.clone()));
    for model in models.iter() {
        let mut i = 0;
        while i < model.row_count() {
            if model.row_data(i).map(|p| p.id) == Some(id) { model.remove(i); } else { i += 1; }
        }
    }
}

// ------------------------------------------------------------------ instances & auth

fn normalize(input: &str) -> Result<String, String> {
    let mut s = input.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err(i18n::t("Enter an instance address, like twitter.republican"));
    }
    let local = |h: &str| h.starts_with("localhost") || h.starts_with("127.0.0.1") || h.starts_with("10.0.2.2") || h.starts_with("192.168.");
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = if local(&s) { format!("http://{s}") } else { format!("https://{s}") };
    }
    if s.starts_with("http://") && !local(&s[7..]) {
        return Err(i18n::t("Instances must use https."));
    }
    let host_end = s[8..].find('/').map(|i| i + 8).unwrap_or(s.len());
    Ok(s[..host_end].to_string())
}

fn connect(input: String) {
    let origin = match normalize(&input) {
        Ok(o) => o,
        Err(e) => { st().set_error(e.into()); return; }
    };
    st().set_error(SharedString::new());
    st().set_busy(true);
    let probe_url = format!("{origin}/.well-known/3itter");
    bg(move |api| api.call_url("GET", &probe_url, None), move |r| {
        st().set_busy(false);
        match r {
            Ok(info) if info.s("software") == "3itter" => {
                let inst = Instance {
                    url: origin.clone(),
                    name: if info.s("name").is_empty() { info.s("domain") } else { info.s("name") },
                    domain: if info.s("domain").is_empty() { origin.split("//").nth(1).unwrap_or_default().to_string() } else { info.s("domain") },
                };
                with(|a| { a.store.remember(inst); a.store.save(); });
                refresh_instances();
                open_instance(origin);
            }
            Ok(_) => st().set_error(t("That server isn’t a 3itter instance.")),
            Err(e) => st().set_error(e.message.into()),
        }
    });
}

fn refresh_instances() {
    let (model, list) = with(|a| (a.m.instances.clone(), a.store.instances.clone()));
    set_models(&model, list.into_iter().map(|i| SavedInstance { url: i.url.into(), name: i.name.into(), domain: i.domain.into() }).collect());
}

fn save_cookies() {
    with(|a| {
        let base = a.api.base();
        a.store.cookies.insert(base, a.api.cookies());
        a.store.save();
    });
}

/// Point the client at an instance and find out whether we're signed in there.
fn open_instance(url: String) {
    with(|a| {
        let jar = a.store.cookies.get(&url).cloned().unwrap_or_default();
        a.api.set_base(&url, jar);
        a.store.current = Some(url.clone());
        a.store.save();
    });
    st().set_screen("loading".into());
    bg(move |api| {
        let inst = api.call("GET", "/instance", None);
        let me = api.call("GET", "/me", None);
        let fetch = |name: &str| api.bytes(&format!("{}/js/i18n/{name}", api.base()), 2 * 1024 * 1024).ok()
            .and_then(|b| String::from_utf8(b).ok()).map(|s| i18n::parse(&s));
        let strings = match (fetch("strings.js"), fetch("strings-extra.js")) {
            (Some(main), Some(extra)) => Some(i18n::merge(main, extra)),
            (main, _) => main,
        };
        (inst, me, strings)
    }, |(inst, me, strings)| {
        if let Some(tbl) = strings { i18n::install(tbl); }
        let inst = match inst {
            Ok(i) => i,
            Err(e) => {
                st().set_screen("instance".into());
                st().set_error(e.message.into());
                return;
            }
        };
        let s = st();
        s.set_instance_name(inst.s("name").into());
        s.set_instance_domain(inst.s("domain").into());
        s.set_instance_description(inst.s("description").into());
        s.set_registrations_open(inst.get("registrationsOpen").and_then(Value::as_bool).unwrap_or(true));
        with(|a| a.instance = inst);
        match me {
            Ok(m) if m["user"].is_object() => signed_in(m["user"].clone()),
            _ => {
                apply_language(None);
                s.set_auth_mode(if s.get_registrations_open() { "signup".into() } else { "login".into() });
                s.set_screen("auth".into());
            }
        }
    });
}

fn apply_language(user: Option<&Value>) {
    let detected = with(|a| a.instance.s("detectedLanguage"));
    let pick = user.map(|u| u["settings"].s("language")).unwrap_or_default();
    let code = if !pick.is_empty() { pick.clone() } else if !detected.is_empty() { detected.clone() } else { "en".into() };
    i18n::set_language(&code);
    let w = ui();
    let g = w.global::<I18n>();
    g.set_rev(g.get_rev() + 1);
    let s = st();
    s.set_language(pick.clone().into());
    s.set_language_auto(if pick.is_empty() {
        format!("{} · {}", i18n::t("Automatic"), i18n::native_name(&code))
    } else {
        i18n::native_name(&pick)
    }.into());
    let mut rows = vec![Lang {
        code: "".into(),
        name: t("Automatic"),
        sub: i18n::tf("Based on your location and browser: {lang}", &[("lang", &i18n::native_name(if detected.is_empty() { "en" } else { &detected }))]).into(),
    }];
    for (c, native, english) in i18n::NAMES {
        rows.push(Lang { code: c.into(), name: native.into(), sub: if c == "en" { SharedString::new() } else { t(english) } });
    }
    let model = with(|a| a.m.languages.clone());
    set_models(&model, rows);
    // Instance stats on the sign-in screen, in the new language.
    let stats = with(|a| a.instance["stats"].clone());
    s.set_instance_stats(if stats.is_object() {
        format!("{} · {}", i18n::tf("{n} people so far", &[("n", &stats.i("users").to_string())]), i18n::tf("{n} posts", &[("n", &stats.i("posts").to_string())]))
    } else { String::new() }.into());
}

fn signed_in(user: Value) {
    with(|a| a.me = user.clone());
    save_cookies();
    apply_language(Some(&user));
    let s = st();
    s.set_me(author(&user));
    s.set_show_client(user["settings"].get("showClient").and_then(Value::as_bool).unwrap_or(true));
    apply_settings(&user);
    s.set_error(SharedString::new());
    s.set_screen("main".into());
    with(|a| { a.stack.clear(); a.current = String::new(); });
    show("home");
    load_feed(true);
    poll_badges();
    start_realtime();
}

// ------------------------------------------------------------------ realtime

/// Bumped on every sign-in/out so an old stream thread knows to stop.
static STREAM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Keep the instance's event stream open while signed in: badges update live, and new notifications
/// and messages become system notifications when the app isn't on screen.
fn start_realtime() {
    use std::sync::atomic::Ordering;
    let gen = STREAM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let api = with(|a| a.api.clone());
    std::thread::spawn(move || {
        let mut failures = 0u32;
        while STREAM_GEN.load(Ordering::SeqCst) == gen {
            let result = api.stream(|event, data| {
                if STREAM_GEN.load(Ordering::SeqCst) != gen { return false; }
                failures = 0;
                let (event, data) = (event.to_string(), data.to_string());
                let _ = slint::invoke_from_event_loop(move || on_realtime(&event, &data));
                true
            });
            if STREAM_GEN.load(Ordering::SeqCst) != gen { break; }
            if let Err(e) = result {
                if e.status == 401 { break; }
                failures += 1;
            }
            std::thread::sleep(std::time::Duration::from_secs((2u64 << failures.min(5)).min(60)));
        }
    });
}

fn stop_realtime() {
    STREAM_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

fn on_realtime(event: &str, data: &str) {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return };
    let s = st();
    match event {
        "badges" => {
            s.set_badge_notifications(v.i("notifications") as i32);
            s.set_badge_messages(v.i("messages") as i32);
        }
        "notification" => {
            let actor = &v["actor"];
            let who = if actor.s("name").is_empty() { actor.s("handle") } else { actor.s("name") };
            let action = match v.s("type").as_str() {
                "like" => "liked your post", "repost" => "reposted your post", "follow" => "followed you",
                "reply" => "replied to you", "mention" => "mentioned you", _ => "quoted your post",
            };
            let title = format!("{who} {}", i18n::t(action));
            let post = &v["post"];
            let body = if post.is_object() { if post.s("cw").is_empty() { post.s("text") } else { format!("⚠ {}", post.s("cw")) } } else { String::new() };
            let on_page = s.get_screen() == "main" && s.get_page() == "notifications";
            if on_page {
                load_notifications(true);
            } else if crate::notify::in_foreground() {
                toast(if body.is_empty() { title } else { format!("{title}: {body}") });
            } else {
                let id = (post.i("id") as i32).wrapping_mul(8).wrapping_add(v.s("type").len() as i32);
                crate::notify::show(id, "activity", &title, &body);
            }
        }
        "message" => {
            let from = &v["from"];
            let handle = if from.s("domain").is_empty() { from.s("handle") } else { format!("{}@{}", from.s("handle"), from.s("domain")) };
            let name = if from.s("name").is_empty() { handle.clone() } else { from.s("name") };
            let in_chat = s.get_page() == "chat" && with(|a| a.chat_handle.eq_ignore_ascii_case(&handle));
            if in_chat {
                load_chat(handle, false);
            } else {
                if s.get_page() == "messages" { load_conversations(); }
                if crate::notify::in_foreground() {
                    toast(format!("{}: {}", i18n::t1("New message from {name}", &name), v.s("text")));
                } else {
                    crate::notify::show(1_000_000 + (from.i("id") as i32 % 1_000_000), "messages", &name, &v.s("text"));
                }
            }
        }
        _ => {}
    }
}

fn login(handle: String, password: String) {
    st().set_busy(true);
    st().set_error(SharedString::new());
    let body = json!({ "handle": handle.trim().trim_start_matches('@'), "password": password });
    bg(move |api| api.call("POST", "/auth/login", Some(body)), |r| {
        st().set_busy(false);
        match r {
            Ok(v) => signed_in(v["user"].clone()),
            Err(e) => st().set_error(e.message.into()),
        }
    });
}

fn signup(handle: String, password: String, name: String) {
    st().set_busy(true);
    st().set_error(SharedString::new());
    let handle = handle.trim().trim_start_matches('@').to_string();
    let lang = i18n::language();
    let body = json!({
        "handle": handle, "password": password, "name": if name.trim().is_empty() { handle.clone() } else { name.trim().to_string() },
        "acceptTerms": true, "language": if lang == "en" { Value::Null } else { Value::String(lang) },
    });
    bg(move |api| api.call("POST", "/auth/signup", Some(body)), |r| {
        st().set_busy(false);
        match r {
            Ok(v) => signed_in(v["user"].clone()),
            Err(e) => st().set_error(e.message.into()),
        }
    });
}

fn logout() {
    stop_realtime();
    bg(|api| api.call("POST", "/auth/logout", None), |_| {
        with(|a| {
            a.api.clear_cookies();
            a.me = Value::Null;
            a.m.feed.set_vec(vec![]);
            a.m.notifications.set_vec(vec![]);
            a.m.conversations.set_vec(vec![]);
        });
        save_cookies();
        apply_language(None);
        st().set_screen("auth".into());
        st().set_auth_mode("login".into());
    });
}

fn switch_instance() {
    stop_realtime();
    with(|a| { a.store.current = None; a.store.save(); });
    refresh_instances();
    st().set_error(SharedString::new());
    st().set_screen("instance".into());
}

// ------------------------------------------------------------------ navigation

fn is_tab(key: &str) -> bool {
    matches!(key, "home" | "explore" | "notifications" | "messages" | "me")
}

/// Show a page by key: "home", "post:12", "profile:ana", "chat:ben", "settings", …
fn show(key: &str) {
    with(|a| a.current = key.to_string());
    let s = st();
    let (kind, arg) = key.split_once(':').unwrap_or((key, ""));
    match kind {
        "home" => {
            s.set_page("home".into());
            if with(|a| a.m.feed.row_count()) == 0 { load_feed(true); }
        }
        "explore" => {
            s.set_page("explore".into());
            if with(|a| a.m.trends.row_count() + a.m.suggestions.row_count()) == 0 { load_explore(); }
        }
        "notifications" => {
            s.set_page("notifications".into());
            load_notifications(true);
        }
        "messages" => {
            s.set_page("messages".into());
            load_conversations();
        }
        "me" => {
            let h = with(|a| a.me.s("handle"));
            load_profile(h);
            s.set_page("profile".into());
        }
        "profile" => {
            load_profile(arg.to_string());
            s.set_page("profile".into());
        }
        "post" => {
            load_thread(arg.parse().unwrap_or(0));
            s.set_page("post".into());
        }
        "chat" => {
            load_chat(arg.to_string(), true);
            s.set_page("chat".into());
        }
        "sessions" => {
            with(|a| a.m.sessions.set_vec(vec![]));
            load_sessions();
            s.set_page("sessions".into());
        }
        "privacy" => {
            load_privacy_lists();
            s.set_page("privacy".into());
        }
        "edit-profile" => {
            fill_edit_profile();
            s.set_page("edit-profile".into());
        }
        "about" => {
            fill_about();
            s.set_page("about".into());
        }
        other => s.set_page(other.into()),
    }
}

fn push(key: String) {
    with(|a| {
        let cur = a.current.clone();
        if !cur.is_empty() && cur != key { a.stack.push(cur); }
    });
    show(&key);
}

fn navigate(tab: String) {
    with(|a| a.stack.clear());
    show(&tab);
}

fn back() {
    if st().get_sheet().row_count() > 0 {
        close_sheet();
        return;
    }
    let screen = st().get_screen();
    if screen == "auth" && with(|a| !a.store.instances.is_empty()) {
        return switch_instance();
    }
    if screen != "main" { return; }
    let prev = with(|a| a.stack.pop());
    match prev {
        Some(k) => show(&k),
        None => {
            if with(|a| a.current != "home") { show("home"); }
        }
    }
}

// ------------------------------------------------------------------ loaders

fn load_feed(reset: bool) {
    let (busy, next, kind) = with(|a| (a.feed_busy, a.feed_next, st().get_feed_kind().to_string()));
    if busy || (!reset && next.is_none()) { return; }
    let offset = if reset { 0 } else { next.unwrap_or(0) };
    with(|a| a.feed_busy = true);
    st().set_feed_loading(true);
    let path = format!("/timeline?feed={}&offset={offset}", if kind == "following" { "following" } else { "foryou" });
    bg(move |api| api.call("GET", &path, None), move |r| {
        with(|a| a.feed_busy = false);
        st().set_feed_loading(false);
        match r {
            Ok(v) => {
                let rows = posts_of(&v["posts"]);
                let model = with(|a| { a.feed_next = v["next"].as_i64(); a.m.feed.clone() });
                if reset { model.set_vec(rows); } else { for p in rows { model.push(p); } }
            }
            Err(e) => fail(e),
        }
    });
}

fn load_more(which: String) {
    match which.as_str() {
        "feed" => load_feed(false),
        "notifications" => load_notifications(false),
        "profile" => load_profile_posts(false),
        _ => {}
    }
}

fn refresh() {
    let cur = with(|a| a.current.clone());
    if cur == "home" {
        let s = st();
        s.set_scroll_top(s.get_scroll_top() + 1);
        with(|a| a.feed_busy = false);
        load_feed(true);
    } else {
        show(&cur);
    }
    poll_badges();
}

fn load_thread(id: i64) {
    with(|a| { a.thread_id = id; a.m.thread.set_vec(vec![]); a.m.replies.set_vec(vec![]); });
    st().set_thread_loading(true);
    bg(move |api| api.call("GET", &format!("/posts/{id}"), None), move |r| {
        st().set_thread_loading(false);
        if with(|a| a.thread_id) != id { return; }
        match r {
            Ok(v) => {
                let mut rows = posts_of(&v["ancestors"]);
                let main = rows.len() as i32;
                rows.push(post_row(&v["post"]));
                let (thread, replies) = with(|a| (a.m.thread.clone(), a.m.replies.clone()));
                thread.set_vec(rows);
                replies.set_vec(posts_of(&v["replies"]));
                st().set_thread_main(main);
            }
            Err(e) => { fail(e); back(); }
        }
    });
}

fn load_profile(handle: String) {
    let s = st();
    let same = with(|a| a.profile_handle == handle);
    if !same {
        s.set_profile(Profile::default());
        with(|a| a.m.profile_posts.set_vec(vec![]));
        s.set_profile_tab("posts".into());
    }
    with(|a| a.profile_handle = handle.clone());
    s.set_profile_loading(true);
    let h = handle.clone();
    bg(move |api| api.call("GET", &format!("/users/{}", enc(&h)), None), move |r| {
        if with(|a| a.profile_handle != handle) { return; }
        match r {
            Ok(v) => {
                let u = v["user"].clone();
                let me = with(|a| a.me.s("handle"));
                let banner = with(|a| a.api.abs(&u.s("banner")));
                BANNER.with(|b| *b.borrow_mut() = banner.clone());
                let joined = timefmt::month_year(u.i("createdAt"));
                st().set_profile(Profile {
                    author: author(&u),
                    bio: u.s("bio").into(),
                    location: u.s("location").into(),
                    website: u.s("website").into(),
                    joined: i18n::t1("Joined {date}", &joined).into(),
                    followers: u["counts"].i("followers") as i32,
                    following: u["counts"].i("following") as i32,
                    posts: u["counts"].i("posts") as i32,
                    is_me: u.s("handle") == me && u.s("domain").is_empty(),
                    is_following: u.b("isFollowing"),
                    follows_you: u.b("followsYou"),
                    blocked: u.b("isBlocked") || u.b("blocksYou"),
                    org: u.b("org"),
                    bot_owner: u["bot"].s("owner").into(),
                    banner: images::get(&banner, 1280),
                    banner_color: theme::banner_color(u.i("hue")),
                });
                load_profile_posts(true);
            }
            Err(e) => { st().set_profile_loading(false); fail(e); back(); }
        }
    });
}

fn load_profile_posts(reset: bool) {
    let (busy, next, handle) = with(|a| (a.profile_busy, a.profile_next, a.profile_handle.clone()));
    if busy || handle.is_empty() || (!reset && next.is_none()) { return; }
    let offset = if reset { 0 } else { next.unwrap_or(0) };
    let tab = st().get_profile_tab().to_string();
    with(|a| a.profile_busy = true);
    st().set_profile_loading(true);
    let path = format!("/users/{}/posts?tab={tab}&offset={offset}", enc(&handle));
    bg(move |api| api.call("GET", &path, None), move |r| {
        with(|a| a.profile_busy = false);
        st().set_profile_loading(false);
        if with(|a| a.profile_handle != handle) || st().get_profile_tab() != tab.as_str() { return; }
        match r {
            Ok(v) => {
                let rows = posts_of(&v["posts"]);
                let model = with(|a| { a.profile_next = v["next"].as_i64(); a.m.profile_posts.clone() });
                if reset { model.set_vec(rows); } else { for p in rows { model.push(p); } }
            }
            Err(e) => fail(e),
        }
    });
}

fn load_notifications(reset: bool) {
    let (busy, next) = with(|a| (a.notif_busy, a.notif_next));
    if busy || (!reset && next.is_none()) { return; }
    let offset = if reset { 0 } else { next.unwrap_or(0) };
    let filter = st().get_notif_filter().to_string();
    with(|a| a.notif_busy = true);
    st().set_notif_loading(true);
    let path = format!("/notifications?offset={offset}{}", if filter == "mentions" { "&filter=mentions" } else { "" });
    bg(move |api| {
        let r = api.call("GET", &path, None);
        if reset { let _ = api.call("POST", "/notifications/read", None); }
        r
    }, move |r| {
        with(|a| a.notif_busy = false);
        st().set_notif_loading(false);
        match r {
            Ok(v) => {
                let rows: Vec<Notif> = v["notifications"].as_array().map(|a| a.iter().map(notif_row).collect()).unwrap_or_default();
                let model = with(|a| { a.notif_next = v["next"].as_i64(); a.m.notifications.clone() });
                if reset { model.set_vec(rows); st().set_badge_notifications(0); } else { for n in rows { model.push(n); } }
            }
            Err(e) => fail(e),
        }
    });
}

fn load_conversations() {
    st().set_conv_loading(true);
    bg(|api| api.call("GET", "/conversations", None), |r| {
        st().set_conv_loading(false);
        match r {
            Ok(v) => {
                let rows: Vec<Conv> = v["conversations"].as_array().map(|a| a.iter().map(|c| {
                    let last = &c["last"];
                    Conv {
                        author: author(&c["user"]),
                        last: format!("{}{}", if last.b("mine") { format!("{} ", i18n::t("You:")) } else { String::new() }, last.s("text")).into(),
                        time: timefmt::rel(last.i("createdAt")).into(),
                        unread: c.i("unread") as i32,
                    }
                }).collect()).unwrap_or_default();
                let model = with(|a| a.m.conversations.clone());
                model.set_vec(rows);
            }
            Err(e) => fail(e),
        }
    });
}

fn load_chat(handle: String, reset: bool) {
    if reset {
        with(|a| { a.chat_handle = handle.clone(); a.m.chat.set_vec(vec![]); });
        st().set_chat_blocked(SharedString::new());
    }
    let h = handle.clone();
    bg(move |api| api.call("GET", &format!("/conversations/{}", enc(&h)), None), move |r| {
        if with(|a| a.chat_handle != handle) { return; }
        match r {
            Ok(v) => {
                st().set_chat_with(author(&v["user"]));
                st().set_chat_blocked(v.s("blockedReason").into());
                let msgs = v["messages"].as_array().cloned().unwrap_or_default();
                let last_mine = msgs.iter().rposition(|m| m.b("mine"));
                let rows: Vec<Message> = msgs.iter().enumerate().map(|(i, m)| Message {
                    id: m.i("id") as i32,
                    text: m.s("text").into(),
                    mine: m.b("mine"),
                    time: timefmt::rel(m.i("createdAt")).into(),
                    seen: Some(i) == last_mine && m.b("read"),
                }).collect();
                let model = with(|a| a.m.chat.clone());
                if model.row_count() != rows.len() || reset { model.set_vec(rows); }
            }
            Err(e) => { fail(e); if reset { back(); } }
        }
    });
}

fn load_explore() {
    bg(|api| (api.call("GET", "/trends", None), api.call("GET", "/suggestions?limit=8", None)), |(tr, sg)| {
        let (trends, suggestions) = with(|a| (a.m.trends.clone(), a.m.suggestions.clone()));
        if let Ok(v) = tr {
            trends.set_vec(v["trends"].as_array().map(|a| a.iter().map(|x| Trend {
                tag: x.s("tag").into(),
                count: if x.i("posts") == 1 { t("1 post") } else { i18n::tf("{n} posts", &[("n", &x.i("posts").to_string())]).into() },
            }).collect::<Vec<_>>()).unwrap_or_default());
        }
        if let Ok(v) = sg {
            suggestions.set_vec(v["users"].as_array().map(|a| a.iter().map(user_row).collect::<Vec<_>>()).unwrap_or_default());
        }
    });
}

fn search(q: String, kind: String) {
    let s = st();
    s.set_query(q.clone().into());
    s.set_search_type(kind.clone().into());
    if q.trim().is_empty() { return; }
    s.set_search_loading(true);
    let path = format!("/search?q={}&type={}", enc(q.trim()), if kind == "people" { "people" } else { "posts" });
    bg(move |api| api.call("GET", &path, None), move |r| {
        st().set_search_loading(false);
        if st().get_query() != q.as_str() { return; }
        match r {
            Ok(v) => {
                let (posts, users) = with(|a| (a.m.search_posts.clone(), a.m.search_users.clone()));
                posts.set_vec(posts_of(&v["posts"]));
                users.set_vec(v["users"].as_array().map(|a| a.iter().map(user_row).collect::<Vec<_>>()).unwrap_or_default());
            }
            Err(e) => fail(e),
        }
    });
}

fn load_sessions() {
    bg(|api| api.call("GET", "/me/sessions", None), |r| match r {
        Ok(v) => {
            let rows = v["sessions"].as_array().map(|a| a.iter().map(session_row).collect::<Vec<_>>()).unwrap_or_default();
            let model = with(|a| a.m.sessions.clone());
            model.set_vec(rows);
        }
        Err(e) => fail(e),
    });
}

fn session_row(s: &Value) -> Session {
    let ua = s.s("userAgent");
    let has = |x: &str| ua.contains(x);
    let os = if has("Windows") { "Windows" } else if has("Android") { "Android" } else if has("iPhone") { "iPhone" } else if has("iPad") { "iPad" }
        else if has("CrOS") { "ChromeOS" } else if has("Mac OS") { "macOS" } else if has("Linux") { "Linux" } else { "" };
    let (title, kind, icon) = if s.s("client") == "android-app" {
        (i18n::t1("3itter for {device}", "Android"), i18n::t("App"), "android")
    } else {
        let browser = if has("Edg/") { "Edge" } else if has("OPR/") { "Opera" } else if has("SamsungBrowser") { "Samsung Internet" }
            else if has("Firefox/") { "Firefox" } else if has("Chrome/") { "Chrome" } else if has("Safari/") { "Safari" } else if has("curl") { "curl" } else { "" };
        let browser = if browser.is_empty() { i18n::t("Browser") } else { browser.to_string() };
        let title = if os.is_empty() { browser } else { i18n::tf("{browser} on {os}", &[("browser", &browser), ("os", os)]) };
        let mobile = has("Android") || has("iPhone") || has("Mobile");
        (title, i18n::t("Web browser"), if has("iPad") { "tablet_mac" } else if mobile { "smartphone" } else { "computer" })
    };
    let current = s.b("current");
    let place = s.s("country");
    let ip = if s.s("ip").is_empty() { i18n::t("Unknown IP") } else { s.s("ip") };
    let active = if current { i18n::t("Active now") } else { i18n::t1("Last active {time}", &timefmt::rel(s.i("lastUsed").max(s.i("createdAt")))) };
    Session {
        id: s.s("id").into(),
        title: title.into(),
        sub: if place.is_empty() { ip.into() } else { format!("{place} · {ip}").into() },
        detail: format!("{kind} · {active} · {}", i18n::t1("Signed in {date}", &timefmt::date(s.i("createdAt")))).into(),
        icon: icon.into(),
        current,
    }
}

fn poll_badges() {
    bg(|api| api.call("GET", "/badges", None), |r| {
        if let Ok(v) = r {
            st().set_badge_notifications(v.i("notifications") as i32);
            st().set_badge_messages(v.i("messages") as i32);
        }
    });
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'@' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ------------------------------------------------------------------ actions

fn toggle(id: i32, kind: &'static str) {
    let Some(p) = find_post(id) else { return };
    let on = match kind { "like" => p.liked, "repost" => p.reposted, _ => p.bookmarked };
    // Optimistic update first, so the heart pops immediately.
    let mut opt = p.clone();
    match kind {
        "like" => { opt.liked = !on; opt.likes += if on { -1 } else { 1 }; }
        "repost" => { opt.reposted = !on; opt.reposts += if on { -1 } else { 1 }; }
        _ => opt.bookmarked = !on,
    }
    let models = with(|a| a.m.post_models().map(|m| m.clone()));
    for m in models.iter() {
        for i in 0..m.row_count() {
            let old = m.row_data(i).unwrap();
            if old.id == id {
                let mut n = opt.clone();
                n.context = old.context.clone();
                n.context_icon = old.context_icon.clone();
                m.set_row_data(i, n);
            }
        }
    }
    let method = if on { "DELETE" } else { "POST" };
    bg(move |api| api.call(method, &format!("/posts/{id}/{kind}"), None), move |r| match r {
        Ok(v) => {
            update_post(&v["post"]);
            if kind == "bookmark" { toast(i18n::t(if on { "Removed from bookmarks" } else { "Added to bookmarks" })); }
        }
        Err(e) => { update_post_from_server(id); fail(e); }
    });
}

fn update_post_from_server(id: i32) {
    bg(move |api| api.call("GET", &format!("/posts/{id}"), None), |r| { if let Ok(v) = r { update_post(&v["post"]); } });
}

fn repost_menu(id: i32) {
    let Some(p) = find_post(id) else { return };
    let undo = p.reposted;
    open_sheet("", vec![
        ("repeat", if undo { "Undo repost" } else { "Repost" }, false, Rc::new(move || toggle(id, "repost")) as Rc<dyn Fn()>),
        ("format_quote", "Quote", false, Rc::new(move || quote(id))),
    ]);
}

fn open_sheet(title: &str, items: Vec<(&'static str, &'static str, bool, Rc<dyn Fn()>)>) {
    let rows: Vec<SheetItem> = items.iter().map(|(icon, label, danger, _)| SheetItem { icon: (*icon).into(), label: t(label), danger: *danger }).collect();
    let model = with(|a| {
        a.sheet_actions = items.into_iter().map(|i| i.3).collect();
        a.m.sheet.clone()
    });
    st().set_sheet_title(if title.is_empty() { SharedString::new() } else { t(title) });
    model.set_vec(rows);
}

fn close_sheet() {
    let model = with(|a| { a.sheet_actions.clear(); a.m.sheet.clone() });
    model.set_vec(vec![]);
}

fn sheet_pick(i: i32) {
    let action = with(|a| if i >= 0 { a.sheet_actions.get(i as usize).cloned() } else { None });
    close_sheet();
    if let Some(f) = action { f(); }
}

fn post_menu(id: i32) {
    let Some(p) = find_post(id) else { return };
    let mine = with(|a| a.me.s("handle")) == p.author.handle.as_str();
    let text = p.text.to_string();
    let handle = p.author.handle.to_string();
    let mut items: Vec<(&'static str, &'static str, bool, Rc<dyn Fn()>)> = vec![
        ("link", "Copy link", false, Rc::new(move || copy_link(id))),
        ("share", "Share", false, Rc::new(move || share(id))),
        ("edit", "Copy text", false, Rc::new(move || { ui().invoke_copy_text(text.clone().into()); toast(i18n::t("Text copied")); })),
        ("format_quote", "Quote post", false, Rc::new(move || quote(id))),
    ];
    if mine {
        items.push(("delete", "Delete post", true, Rc::new(move || confirm_delete(id))));
    } else {
        items.push(("person", "Profile", false, Rc::new(move || push(format!("profile:{handle}")))));
    }
    open_sheet("", items);
}

fn confirm_delete(id: i32) {
    open_sheet("Delete post?", vec![
        ("delete", "Delete", true, Rc::new(move || {
            bg(move |api| api.call("DELETE", &format!("/posts/{id}"), None), move |r| match r {
                Ok(_) => {
                    remove_post(id);
                    toast(i18n::t("Post deleted"));
                    if with(|a| a.current == format!("post:{id}")) { back(); }
                }
                Err(e) => fail(e),
            });
        }) as Rc<dyn Fn()>),
        ("close", "Cancel", false, Rc::new(|| {})),
    ]);
}

fn share(id: i32) {
    let base = with(|a| a.api.base());
    let link = format!("{base}/p/{id}");
    if !crate::notify::share_text(&link) {
        ui().invoke_copy_text(link.into());
        toast(i18n::t("Link copied"));
    }
}

fn copy_link(id: i32) {
    let base = with(|a| a.api.base());
    ui().invoke_copy_text(format!("{base}/p/{id}").into());
    toast(i18n::t("Link copied"));
}

fn open_compose(reply: Option<i64>, quote_of: Option<i64>, context: String) {
    with(|a| {
        a.compose_reply = reply;
        a.compose_quote = quote_of;
        a.compose_images.clear();
        a.compose_video_id = None;
        a.compose_upload_gen += 1;
        a.schedule_at = None;
        a.m.compose_images.set_vec(vec![]);
    });
    let s = st();
    s.set_compose_text(SharedString::new());
    s.set_compose_context(context.into());
    s.set_compose_video(SharedString::new());
    s.set_compose_poll(false);
    for f in [AppState::set_poll_1, AppState::set_poll_2, AppState::set_poll_3, AppState::set_poll_4] { f(&s, SharedString::new()); }
    s.set_poll_count(2);
    s.set_poll_hours(24);
    s.set_compose_cw_on(false);
    s.set_compose_cw(SharedString::new());
    s.set_compose_sensitive(false);
    s.set_compose_policy("everyone".into());
    s.set_compose_schedule(SharedString::new());
    push("compose".into());
}

fn reply_to(id: i32) {
    let handle = find_post(id).map(|p| p.author.handle.to_string()).unwrap_or_default();
    open_compose(Some(id as i64), None, format!("{} @{handle}", i18n::t("Replying to")));
}

fn quote(id: i32) {
    let handle = find_post(id).map(|p| p.author.handle.to_string()).unwrap_or_default();
    open_compose(None, Some(id as i64), format!("{} · @{handle}", i18n::t("Quote post")));
}

fn submit_post(text: String) {
    let s = st();
    let (reply, quote_of, images, video, schedule_at) = with(|a| (a.compose_reply, a.compose_quote, a.compose_images.clone(), a.compose_video_id.clone(), a.schedule_at));
    if text.trim().is_empty() && images.is_empty() && video.is_none() { return; }
    let mut body = json!({ "text": text, "replyPolicy": s.get_compose_policy().to_string() });
    if let Some(r) = reply { body["replyTo"] = json!(r); }
    if let Some(q) = quote_of { body["quoteOf"] = json!(q); }
    if !images.is_empty() { body["images"] = json!(images.iter().map(|d| json!({ "data": d, "alt": "" })).collect::<Vec<_>>()); }
    if let Some(v) = &video { body["video"] = json!({ "id": v, "alt": "" }); }
    if s.get_compose_sensitive() && (!images.is_empty() || video.is_some()) { body["sensitive"] = json!(true); }
    if s.get_compose_cw_on() && !s.get_compose_cw().trim().is_empty() { body["cw"] = json!(s.get_compose_cw().to_string()); }
    if s.get_compose_poll() {
        let opts: Vec<String> = [s.get_poll_1(), s.get_poll_2(), s.get_poll_3(), s.get_poll_4()].iter().take(s.get_poll_count() as usize)
            .map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
        body["poll"] = json!({ "options": opts, "durationHours": s.get_poll_hours(), "multiple": false });
    }
    let scheduled = schedule_at.filter(|_| s.get_compose_schedule() != "" && reply.is_none());
    if let Some(at) = scheduled { body["publishAt"] = json!(at); }
    s.set_busy(true);
    let path = if scheduled.is_some() { "/scheduled" } else { "/posts" };
    bg(move |api| api.call("POST", path, Some(body)), move |r| {
        st().set_busy(false);
        match r {
            Ok(v) => {
                st().set_compose_text(SharedString::new());
                back();
                if scheduled.is_some() {
                    toast(i18n::t1("Scheduled for {when}", &timefmt::full(scheduled.unwrap())));
                    return;
                }
                toast(i18n::t(if reply.is_some() { "Reply sent" } else { "Your post was sent" }));
                if reply.is_none() {
                    let feed = with(|a| a.m.feed.clone());
                    feed.insert(0, post_row(&v["post"]));
                }
                let cur = with(|a| a.current.clone());
                if cur.starts_with("post:") { show(&cur); }
            }
            Err(e) => fail(e),
        }
    });
}

fn quick_reply(text: String) {
    if text.trim().is_empty() { return; }
    let id = with(|a| a.thread_id);
    bg(move |api| api.call("POST", "/posts", Some(json!({ "text": text, "replyTo": id }))), move |r| match r {
        Ok(_) => { toast(i18n::t("Reply sent")); load_thread(id); }
        Err(e) => fail(e),
    });
}

thread_local! { static HANDLE_ARG: RefCell<String> = const { RefCell::new(String::new()) }; }
fn apply_handle() -> String { HANDLE_ARG.with(|h| h.borrow().clone()) }

fn follow_request(method: &'static str, handle: String) {
    bg(move |api| api.call(method, &format!("/users/{}/follow", enc(&handle)), None), |r| {
        if let Err(e) = r { fail(e); }
    });
}

fn send_message(text: String) {
    if text.trim().is_empty() { return; }
    let handle = with(|a| a.chat_handle.clone());
    bg(move |api| api.call("POST", &format!("/conversations/{}", enc(&handle)), Some(json!({ "text": text })))
        , move |r| match r {
            Ok(_) => { let h = with(|a| a.chat_handle.clone()); load_chat(h, false); }
            Err(e) => fail(e),
        });
}

fn set_language(code: String) {
    let body = json!({ "language": if code.is_empty() { Value::Null } else { Value::String(code.clone()) } });
    bg(move |api| api.call("PATCH", "/me", Some(body)), |r| match r {
        Ok(v) => {
            with(|a| a.me = v["user"].clone());
            let me = with(|a| a.me.clone());
            apply_language(Some(&me));
            toast(i18n::t("Language"));
            // Re-render rows with translated labels and dates.
            load_feed(true);
        }
        Err(e) => fail(e),
    });
}

fn set_show_client(on: bool) {
    st().set_show_client(on);
    bg(move |api| api.call("PATCH", "/me", Some(json!({ "showClient": on }))), move |r| {
        if let Err(e) = r { st().set_show_client(!on); fail(e); }
    });
}

fn revoke_session(id: String) {
    let title = with(|a| a.m.sessions.iter().find(|s| s.id.as_str() == id).map(|s| s.title.to_string())).unwrap_or_default();
    let _ = title;
    open_sheet("Sign out this session?", vec![
        ("logout", "Sign out", true, Rc::new(move || {
            let id = id.clone();
            bg(move |api| api.call("DELETE", &format!("/me/sessions/{}", enc(&id)), None), |r| match r {
                Ok(_) => { toast(i18n::t("Session signed out")); load_sessions(); }
                Err(e) => fail(e),
            });
        }) as Rc<dyn Fn()>),
        ("close", "Cancel", false, Rc::new(|| {})),
    ]);
}

fn revoke_others() {
    open_sheet("Sign out other sessions?", vec![
        ("logout", "Sign out others", true, Rc::new(|| {
            bg(|api| api.call("DELETE", "/me/sessions", None), |r| match r {
                Ok(v) => {
                    let n = v.i("revoked");
                    toast(if n == 1 { i18n::t("1 session signed out") } else { i18n::tf("{n} sessions signed out", &[("n", &n.to_string())]) });
                    load_sessions();
                }
                Err(e) => fail(e),
            });
        }) as Rc<dyn Fn()>),
        ("close", "Cancel", false, Rc::new(|| {})),
    ]);
}

// ------------------------------------------------------------------ start-up

pub fn run(data_dir: PathBuf) -> Result<(), slint::PlatformError> {
    run_with(data_dir, |_| {})
}

/// Like `run`, with a hook that gets the window before the event loop starts (used by tests).
pub fn run_with(data_dir: PathBuf, on_start: impl FnOnce(&AppWindow)) -> Result<(), slint::PlatformError> {
    let window = AppWindow::new()?;
    let keep: &'static AppWindow = Box::leak(Box::new(window.clone_strong()));
    WINDOW.with(|w| { let _ = w.set(keep); });

    let th = window.global::<Theme>();
    th.set_light(ModelRc::new(VecModel::from(theme::scheme(285.0, false))));
    th.set_dark(ModelRc::new(VecModel::from(theme::scheme(285.0, true))));
    let tr = window.global::<I18n>();
    tr.on_lookup(|s, _| i18n::t(&s).into());
    tr.on_lookup1(|s, v, _| i18n::t1(&s, &v).into());

    let api = Arc::new(Api::new());
    images::start(api.clone(), image_ready);

    let m = Models {
        feed: Rc::new(VecModel::default()),
        thread: Rc::new(VecModel::default()),
        replies: Rc::new(VecModel::default()),
        search_posts: Rc::new(VecModel::default()),
        profile_posts: Rc::new(VecModel::default()),
        notifications: Rc::new(VecModel::default()),
        conversations: Rc::new(VecModel::default()),
        chat: Rc::new(VecModel::default()),
        search_users: Rc::new(VecModel::default()),
        suggestions: Rc::new(VecModel::default()),
        trends: Rc::new(VecModel::default()),
        sessions: Rc::new(VecModel::default()),
        languages: Rc::new(VecModel::default()),
        instances: Rc::new(VecModel::default()),
        sheet: Rc::new(VecModel::default()),
        compose_images: Rc::new(VecModel::default()),
        muted_words: Rc::new(VecModel::default()),
        blocked: Rc::new(VecModel::default()),
        muted: Rc::new(VecModel::default()),
        about_rules: Rc::new(VecModel::default()),
    };
    let s = window.global::<AppState>();
    s.set_feed(m.feed.clone().into());
    s.set_thread(m.thread.clone().into());
    s.set_replies(m.replies.clone().into());
    s.set_search_posts(m.search_posts.clone().into());
    s.set_profile_posts(m.profile_posts.clone().into());
    s.set_notifications(m.notifications.clone().into());
    s.set_conversations(m.conversations.clone().into());
    s.set_chat(m.chat.clone().into());
    s.set_search_users(m.search_users.clone().into());
    s.set_suggestions(m.suggestions.clone().into());
    s.set_trends(m.trends.clone().into());
    s.set_sessions(m.sessions.clone().into());
    s.set_languages(m.languages.clone().into());
    s.set_instances(m.instances.clone().into());
    s.set_sheet(m.sheet.clone().into());
    s.set_compose_images(m.compose_images.clone().into());
    s.set_muted_words(m.muted_words.clone().into());
    s.set_blocked(m.blocked.clone().into());
    s.set_muted(m.muted.clone().into());
    s.set_about_rules(m.about_rules.clone().into());
    s.set_version(env!("CARGO_PKG_VERSION").into());

    let store = Store::load(data_dir);
    APP.with(|a| *a.borrow_mut() = Some(App {
        ui: window.as_weak(),
        api,
        store,
        instance: Value::Null,
        me: Value::Null,
        current: String::new(),
        stack: vec![],
        feed_next: None,
        feed_busy: false,
        notif_next: None,
        notif_busy: false,
        profile_handle: String::new(),
        profile_next: None,
        profile_busy: false,
        thread_id: 0,
        chat_handle: String::new(),
        compose_reply: None,
        compose_quote: None,
        sheet_actions: vec![],
        toast_gen: 0,
        compose_images: vec![],
        compose_video_id: None,
        compose_upload_gen: 0,
        schedule_at: None,
        schedule_date: None,
        m,
    }));

    s.on_connect(|u| { let u = u.to_string(); later(move || connect(u)) });
    s.on_open_instance(|u| { let u = u.to_string(); later(move || open_instance(u)) });
    s.on_forget_instance(|u| {
        let u = u.to_string();
        later(move || { with(|a| { a.store.instances.retain(|i| i.url != u); a.store.cookies.remove(&u); a.store.save(); }); refresh_instances(); })
    });
    s.on_switch_instance(|| later(switch_instance));
    s.on_login(|h, p| { let (h, p) = (h.to_string(), p.to_string()); later(move || login(h, p)) });
    s.on_signup(|h, p, n| { let (h, p, n) = (h.to_string(), p.to_string(), n.to_string()); later(move || signup(h, p, n)) });
    s.on_logout(|| later(logout));
    s.on_navigate(|k| {
        let k = k.to_string();
        later(move || if is_tab(&k) { navigate(k) } else { push(k) })
    });
    s.on_back(|| later(back));
    s.on_refresh(|| later(refresh));
    s.on_load_more(|w| { let w = w.to_string(); later(move || load_more(w)) });
    s.on_open_post(|id| later(move || push(format!("post:{id}"))));
    s.on_open_user(|h| {
        let h = h.to_string();
        later(move || {
            let me = with(|a| a.me.s("handle"));
            if h == me && with(|a| a.stack.is_empty() && is_tab(&a.current)) { navigate("me".into()) } else { push(format!("profile:{h}")) }
        })
    });
    s.on_open_chat(|h| { let h = h.to_string(); later(move || push(format!("chat:{h}"))) });
    s.on_open_tag(|tag| { let tag = tag.to_string(); later(move || search(format!("#{tag}"), "posts".into())) });
    s.on_like(|id| later(move || toggle(id, "like")));
    s.on_repost(|id| later(move || repost_menu(id)));
    s.on_bookmark(|id| later(move || toggle(id, "bookmark")));
    s.on_reply_to(|id| later(move || reply_to(id)));
    s.on_quote(|id| later(move || quote(id)));
    s.on_post_menu(|id| later(move || post_menu(id)));
    s.on_share(|id| later(move || share(id)));
    s.on_compose(|| later(|| open_compose(None, None, String::new())));
    s.on_submit_post(|t| { let t = t.to_string(); later(move || submit_post(t)) });
    s.on_quick_reply(|t| { let t = t.to_string(); later(move || quick_reply(t)) });
    s.on_follow(|h| {
        let h = h.to_string();
        later(move || { HANDLE_ARG.with(|x| *x.borrow_mut() = h); follow_current(); })
    });
    s.on_search(|q, k| { let (q, k) = (q.to_string(), k.to_string()); later(move || search(q, k)) });
    s.on_set_feed(|k| {
        let k = k.to_string();
        later(move || { st().set_feed_kind(k.into()); with(|a| a.m.feed.set_vec(vec![])); load_feed(true); })
    });
    s.on_set_notif_filter(|k| { let k = k.to_string(); later(move || { st().set_notif_filter(k.into()); load_notifications(true); }) });
    s.on_set_profile_tab(|k| {
        let k = k.to_string();
        later(move || { st().set_profile_tab(k.into()); with(|a| a.m.profile_posts.set_vec(vec![])); load_profile_posts(true); })
    });
    s.on_send_message(|t| { let t = t.to_string(); later(move || send_message(t)) });
    s.on_set_language(|c| { let c = c.to_string(); later(move || set_language(c)) });
    s.on_set_show_client(|on| later(move || set_show_client(on)));
    s.on_revoke_session(|id| { let id = id.to_string(); later(move || revoke_session(id)) });
    s.on_revoke_others(|| later(revoke_others));
    s.on_sheet_pick(|i| later(move || sheet_pick(i)));

    // Badges every 30 s; the open conversation every 6 s.
    let badges = slint::Timer::default();
    badges.start(slint::TimerMode::Repeated, std::time::Duration::from_secs(30), || {
        if st().get_screen() == "main" { poll_badges(); }
    });
    let chat = slint::Timer::default();
    chat.start(slint::TimerMode::Repeated, std::time::Duration::from_secs(6), || {
        if st().get_screen() == "main" && st().get_page() == "chat" {
            let h = with(|a| a.chat_handle.clone());
            load_chat(h, false);
        }
    });

    let theme_mode = with(|a| a.store.theme.clone());
    window.global::<Theme>().set_mode(if theme_mode.is_empty() { "system".into() } else { theme_mode.into() });
    wire_extras(&s);
    refresh_instances();
    let current = with(|a| a.store.current.clone());
    match current {
        Some(url) => open_instance(url),
        None => s.set_screen("instance".into()),
    }
    on_start(&window);
    window.run()
}

/// Follow or unfollow the handle stored by the `follow` callback, based on what the UI shows.
fn follow_current() {
    let handle = apply_handle();
    let s = st();
    let p = s.get_profile();
    let mut following = if p.author.handle.as_str() == handle { Some(p.is_following) } else { None };
    let (users, sugg) = with(|a| (a.m.search_users.clone(), a.m.suggestions.clone()));
    for m in [&users, &sugg] {
        if following.is_none() {
            following = m.iter().find(|u| u.author.handle.as_str() == handle).map(|u| u.following);
        }
    }
    let now = !following.unwrap_or(false);
    if p.author.handle.as_str() == handle {
        let mut p = p;
        if p.is_following != now { p.followers += if now { 1 } else { -1 }; }
        p.is_following = now;
        s.set_profile(p);
    }
    for m in [&users, &sugg] {
        for i in 0..m.row_count() {
            let mut u = m.row_data(i).unwrap();
            if u.author.handle.as_str() == handle { u.following = now; m.set_row_data(i, u); }
        }
    }
    follow_request(if now { "POST" } else { "DELETE" }, handle);
}

// ------------------------------------------------------------------ composer tools, settings

const PICK_IMAGES: i32 = 1;
const PICK_VIDEO: i32 = 2;
const PICK_AVATAR: i32 = 3;
const PICK_BANNER: i32 = 4;

/// Prepare a picked picture for upload: GIFs stay as they are (animation), everything else is
/// downscaled and re-encoded as JPEG. `crop` = width/height to centre-crop to (avatars, banners).
fn encode_image(bytes: &[u8], mime: &str, max_w: u32, max_h: u32, crop: Option<f32>) -> Result<(String, slint::SharedPixelBuffer<slint::Rgba8Pixel>), String> {
    use base64::Engine;
    let img = image::load_from_memory(bytes).map_err(|_| i18n::t("That image couldn’t be opened."))?;
    let img = match crop {
        Some(r) => {
            let (w, h) = (img.width() as f32, img.height() as f32);
            let (cw, ch) = if w / h > r { (h * r, h) } else { (w, w / r) };
            img.crop_imm(((w - cw) / 2.0) as u32, ((h - ch) / 2.0) as u32, cw as u32, ch as u32)
        }
        None => img,
    };
    let thumb = img.thumbnail(320, 320).to_rgba8();
    let px = slint::SharedPixelBuffer::clone_from_slice(thumb.as_raw(), thumb.width(), thumb.height());
    let data = if mime == "image/gif" && crop.is_none() && bytes.len() < 5 * 1024 * 1024 {
        format!("data:image/gif;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    } else {
        let img = if img.width() > max_w || img.height() > max_h { img.resize(max_w, max_h, image::imageops::FilterType::Lanczos3) } else { img };
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)
            .encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
        format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out))
    };
    Ok((data, px))
}

pub fn on_picked(request: i32, files: Vec<(String, Vec<u8>)>) {
    if files.is_empty() { return; }
    match request {
        PICK_IMAGES => {
            let room = 4usize.saturating_sub(with(|a| a.compose_images.len()));
            for (mime, bytes) in files.into_iter().filter(|f| f.0.starts_with("image/") || f.0.is_empty()).take(room) {
                bg(move |_| encode_image(&bytes, &mime, 1600, 1600, None), |r| match r {
                    Ok((data, px)) => {
                        let model = with(|a| { a.compose_images.push(data); a.m.compose_images.clone() });
                        model.push(ComposeImage { image: slint::Image::from_rgba8(px) });
                    }
                    Err(e) => toast(e),
                });
            }
        }
        PICK_VIDEO => {
            let Some((mime, bytes)) = files.into_iter().next() else { return };
            let mime = if mime.is_empty() { "video/mp4".to_string() } else { mime };
            if !["video/mp4", "video/webm", "video/quicktime"].contains(&mime.as_str()) {
                return toast(i18n::t("Videos must be MP4, WebM or MOV."));
            }
            let gen = with(|a| { a.compose_upload_gen += 1; a.compose_video_id = None; a.compose_upload_gen });
            let s = st();
            s.set_compose_video("uploading".into());
            s.set_compose_video_note(format!("{} · {:.1} MB", i18n::t("Uploading video…"), bytes.len() as f64 / 1_048_576.0).into());
            let size = bytes.len();
            bg(move |api| api.upload("/media/video", &mime, &bytes), move |r| {
                if with(|a| a.compose_upload_gen) != gen { return; }
                let s = st();
                match r {
                    Ok(v) => {
                        with(|a| a.compose_video_id = Some(v["video"].s("id")));
                        s.set_compose_video("ready".into());
                        s.set_compose_video_note(format!("{:.1} MB", size as f64 / 1_048_576.0).into());
                    }
                    Err(e) => {
                        s.set_compose_video("error".into());
                        s.set_compose_video_note(e.message.into());
                    }
                }
            });
        }
        PICK_AVATAR | PICK_BANNER => {
            let Some((mime, bytes)) = files.into_iter().next() else { return };
            let avatar = request == PICK_AVATAR;
            st().set_busy(true);
            bg(move |api| {
                let (data, px) = if avatar { encode_image(&bytes, &mime, 512, 512, Some(1.0)) } else { encode_image(&bytes, &mime, 1500, 500, Some(3.0)) }
                    .map_err(|e| crate::api::ApiError { status: 0, message: e })?;
                let body = if avatar { json!({ "avatar": data }) } else { json!({ "banner": data }) };
                api.call("PATCH", "/me", Some(body)).map(|v| (v, px))
            }, move |r| {
                st().set_busy(false);
                match r {
                    Ok((v, px)) => {
                        let img = slint::Image::from_rgba8(px);
                        if avatar {
                            let mut me = st().get_me();
                            me.avatar = img;
                            st().set_me(me);
                        } else {
                            st().set_edit_banner(img);
                        }
                        with(|a| a.me = v["user"].clone());
                        toast(i18n::t("Profile updated"));
                    }
                    Err(e) => fail(e),
                }
            });
        }
        _ => {}
    }
}

fn compose_remove_image(i: i32) {
    let model = with(|a| {
        if (i as usize) < a.compose_images.len() { a.compose_images.remove(i as usize); }
        a.m.compose_images.clone()
    });
    if (i as usize) < model.row_count() { model.remove(i as usize); }
}

fn compose_remove_video() {
    with(|a| { a.compose_video_id = None; a.compose_upload_gen += 1; });
    st().set_compose_video(SharedString::new());
}

fn compose_policy_menu() {
    let set = |p: &'static str| Rc::new(move || st().set_compose_policy(p.into())) as Rc<dyn Fn()>;
    open_sheet("Who can reply", vec![
        ("public", "Everyone can reply", false, set("everyone")),
        ("group", "People you follow can reply", false, set("following")),
        ("alternate_email", "Only people you mention can reply", false, set("mentioned")),
    ]);
}

fn set_schedule(at: i64) {
    if at < timefmt::now_ms() + 60_000 {
        return toast(i18n::t("Pick a time at least a minute from now."));
    }
    with(|a| a.schedule_at = Some(at));
    st().set_compose_schedule(i18n::t1("Will post {when}", &timefmt::full(at)).into());
}

fn compose_schedule_menu() {
    let tonight = if timefmt::local_hour() < 19 { 0 } else { 1 };
    let at = |days: i64, h: i32| { let (y, m, d) = timefmt::local_date(days); timefmt::local_ms(y, m, d, h, 0) };
    let mut items: Vec<(&'static str, &'static str, bool, Rc<dyn Fn()>)> = vec![
        ("schedule", "In 1 hour", false, Rc::new(|| set_schedule(timefmt::now_ms() + 3_600_000))),
        ("dark_mode", if tonight == 0 { "Tonight at 20:00" } else { "Tomorrow at 20:00" }, false, Rc::new(move || set_schedule(at(tonight, 20)))),
        ("light_mode", "Tomorrow at 9:00", false, Rc::new(move || set_schedule(at(1, 9)))),
        ("event", "Pick a date and time", false, Rc::new(|| st().set_compose_want_date(true))),
    ];
    if st().get_compose_schedule() != "" {
        items.push(("close", "Don’t schedule", true, Rc::new(|| { with(|a| a.schedule_at = None); st().set_compose_schedule(SharedString::new()); })));
    }
    open_sheet("Schedule post", items);
}

fn apply_settings(user: &Value) {
    let s = st();
    let set = &user["settings"];
    s.set_dm_policy(if set.s("dmPolicy").is_empty() { "everyone".into() } else { set.s("dmPolicy").into() });
    s.set_discoverable(set.get("discoverable").and_then(Value::as_bool).unwrap_or(true));
    let prefs = &set["notifPrefs"];
    let p = |k: &str| prefs.get(k).and_then(Value::as_bool).unwrap_or(true);
    s.set_notif_like(p("like"));
    s.set_notif_repost(p("repost"));
    s.set_notif_follow(p("follow"));
    s.set_notif_reply(p("reply"));
    s.set_notif_mention(p("mention"));
    s.set_notif_quote(p("quote"));
    let words: Vec<SharedString> = set["mutedWords"].as_array().map(|a| a.iter().filter_map(|w| w.as_str().map(SharedString::from)).collect()).unwrap_or_default();
    let model = with(|a| a.m.muted_words.clone());
    model.set_vec(words);
}

/// PATCH /me with `body`; on success the fresh user replaces ours.
fn save_me(body: Value, ok: &'static str) {
    bg(move |api| api.call("PATCH", "/me", Some(body)), move |r| match r {
        Ok(v) => {
            with(|a| a.me = v["user"].clone());
            apply_settings(&v["user"]);
            if !ok.is_empty() { toast(i18n::t(ok)); }
        }
        Err(e) => {
            let me = with(|a| a.me.clone());
            apply_settings(&me);
            fail(e);
        }
    });
}

fn set_notif_pref(key: String, on: bool) {
    let mut prefs = with(|a| a.me["settings"]["notifPrefs"].clone());
    if !prefs.is_object() { prefs = json!({}); }
    prefs[key.as_str()] = json!(on);
    let s = st();
    match key.as_str() {
        "like" => s.set_notif_like(on), "repost" => s.set_notif_repost(on), "follow" => s.set_notif_follow(on),
        "reply" => s.set_notif_reply(on), "mention" => s.set_notif_mention(on), _ => s.set_notif_quote(on),
    }
    save_me(json!({ "notifPrefs": prefs }), "");
}

fn muted_word(word: String, add: bool) {
    let word = word.trim().to_lowercase();
    if word.is_empty() { return; }
    let mut words: Vec<String> = with(|a| a.m.muted_words.iter().map(|w| w.to_string()).collect());
    if add { if !words.contains(&word) { words.insert(0, word); } } else { words.retain(|w| *w != word); }
    save_me(json!({ "mutedWords": words }), "");
}

fn load_privacy_lists() {
    bg(|api| (api.call("GET", "/me/blocks", None), api.call("GET", "/me/mutes", None)), |(b, m)| {
        let (blocked, muted) = with(|a| (a.m.blocked.clone(), a.m.muted.clone()));
        if let Ok(v) = b { blocked.set_vec(v["users"].as_array().map(|a| a.iter().map(user_row).collect::<Vec<_>>()).unwrap_or_default()); }
        if let Ok(v) = m { muted.set_vec(v["users"].as_array().map(|a| a.iter().map(user_row).collect::<Vec<_>>()).unwrap_or_default()); }
    });
}

fn undo_relation(handle: String, what: &'static str) {
    bg(move |api| api.call("DELETE", &format!("/users/{}/{what}", enc(&handle)), None), move |r| match r {
        Ok(_) => { toast(i18n::t(if what == "block" { "Unblocked" } else { "Unmuted" })); load_privacy_lists(); }
        Err(e) => fail(e),
    });
}

fn fill_edit_profile() {
    let me = with(|a| a.me.clone());
    let s = st();
    s.set_edit_name(me.s("name").into());
    s.set_edit_bio(me.s("bio").into());
    s.set_edit_location(me.s("location").into());
    s.set_edit_website(me.s("website").into());
    s.set_edit_pronouns(me.s("pronouns").into());
    let banner = with(|a| a.api.abs(&me.s("banner")));
    s.set_edit_banner(images::get(&banner, 1280));
}

fn save_profile() {
    let s = st();
    let body = json!({
        "name": s.get_edit_name().to_string(), "bio": s.get_edit_bio().to_string(), "location": s.get_edit_location().to_string(),
        "website": s.get_edit_website().to_string(), "pronouns": s.get_edit_pronouns().to_string(),
    });
    s.set_busy(true);
    bg(move |api| api.call("PATCH", "/me", Some(body)), |r| {
        st().set_busy(false);
        match r {
            Ok(v) => {
                with(|a| a.me = v["user"].clone());
                st().set_me(author(&v["user"]));
                toast(i18n::t("Profile updated"));
                back();
            }
            Err(e) => fail(e),
        }
    });
}

fn change_password(current: String, next: String, confirm: String) {
    if next != confirm { return toast(i18n::t("The new passwords don’t match.")); }
    st().set_busy(true);
    bg(move |api| api.call("POST", "/me/password", Some(json!({ "current": current, "next": next }))), |r| {
        st().set_busy(false);
        match r {
            Ok(_) => { toast(i18n::t("Password updated. Other sessions were signed out.")); back(); }
            Err(e) => fail(e),
        }
    });
}

fn fill_about() {
    let inst = with(|a| a.instance.clone());
    let s = st();
    let rules: Vec<SharedString> = inst["rules"].as_array().map(|a| a.iter().filter_map(|r| r.as_str().map(SharedString::from)).collect()).unwrap_or_default();
    let model = with(|a| a.m.about_rules.clone());
    model.set_vec(rules);
    s.set_about_contact(inst.s("contactEmail").into());
    s.set_about_version(inst.s("version").into());
}

fn set_theme(mode: String) {
    with(|a| { a.store.theme = mode.clone(); a.store.save(); });
    ui().global::<Theme>().set_mode(mode.into());
}

fn wire_extras(s: &AppState) {
    s.on_compose_pick_images(|| later(|| crate::notify::pick_media("image/*", PICK_IMAGES, true)));
    s.on_compose_pick_video(|| later(|| crate::notify::pick_media("video/*", PICK_VIDEO, false)));
    s.on_compose_remove_image(|i| later(move || compose_remove_image(i)));
    s.on_compose_remove_video(|| later(compose_remove_video));
    s.on_compose_policy_menu(|| later(compose_policy_menu));
    s.on_compose_schedule_menu(|| later(compose_schedule_menu));
    s.on_compose_set_date(|y, m, d| later(move || with(|a| a.schedule_date = Some((y, m, d)))));
    s.on_compose_set_time(|h, mi| later(move || {
        if let Some((y, m, d)) = with(|a| a.schedule_date) { set_schedule(timefmt::local_ms(y, m, d, h, mi)); }
    }));
    s.on_set_theme(|m| { let m = m.to_string(); later(move || set_theme(m)) });
    s.on_set_dm_policy(|p| {
        let p = p.to_string();
        later(move || { st().set_dm_policy(p.clone().into()); save_me(json!({ "dmPolicy": p }), "Message settings saved"); })
    });
    s.on_set_discoverable(|on| later(move || { st().set_discoverable(on); save_me(json!({ "discoverable": on }), ""); }));
    s.on_add_muted_word(|w| { let w = w.to_string(); later(move || muted_word(w, true)) });
    s.on_remove_muted_word(|w| { let w = w.to_string(); later(move || muted_word(w, false)) });
    s.on_unblock(|h| { let h = h.to_string(); later(move || undo_relation(h, "block")) });
    s.on_unmute(|h| { let h = h.to_string(); later(move || undo_relation(h, "mute")) });
    s.on_set_notif_pref(|k, on| { let k = k.to_string(); later(move || set_notif_pref(k, on)) });
    s.on_save_profile(|| later(save_profile));
    s.on_change_avatar(|| later(|| crate::notify::pick_media("image/*", PICK_AVATAR, false)));
    s.on_change_banner(|| later(|| crate::notify::pick_media("image/*", PICK_BANNER, false)));
    s.on_change_password(|c, n, f| { let (c, n, f) = (c.to_string(), n.to_string(), f.to_string()); later(move || change_password(c, n, f)) });
    s.on_open_url(|u| { let u = u.to_string(); later(move || crate::notify::open_url(&u)) });
    s.on_open_link(|path| {
        let path = path.to_string();
        later(move || { let base = with(|a| a.api.base()); crate::notify::open_url(&format!("{base}{path}")); })
    });
}
