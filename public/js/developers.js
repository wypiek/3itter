// /developers: how to build bots and integrations for a 3itter instance. Readable without an account.
import { html, el } from './lib/html.js';
import { state } from './store.js';
import { icon, topBar } from './ui.js';

const code = (s) => html`<pre class="doc-code"><code>${s.trim()}</code></pre>`;
const section = (id, title, body) => html`<section class="doc-section" id="${id}"><h2 class="title-large emph">${title}</h2>${body}</section>`;

const ENDPOINTS = [
  ['GET', '/api/me', 'read', 'The account the token belongs to'],
  ['GET', '/api/timeline?feed=following', 'read', 'Home timeline ("following" or "foryou"); page with ?offset='],
  ['GET', '/api/notifications', 'read', 'Notifications (?filter=mentions for replies, mentions and quotes)'],
  ['GET', '/api/posts/:id', 'read', 'A post with its thread and replies'],
  ['GET', '/api/users/:handle', 'read', 'A profile (also handle@instance for federated accounts)'],
  ['GET', '/api/users/:handle/posts', 'read', 'Someone’s posts (?tab=replies|media|likes)'],
  ['GET', '/api/search?q=…&type=posts', 'read', 'Search posts or people (type=people), with operators like from: and has:media'],
  ['POST', '/api/posts', 'write', 'Post. Body: { text, replyTo?, quoteOf?, images?: [{ data, alt }], video?: { id }, poll?, cw?, replyPolicy? }'],
  ['DELETE', '/api/posts/:id', 'write', 'Delete one of your posts'],
  ['POST', '/api/posts/:id/like', 'write', 'Like (DELETE to undo). Also /repost and /bookmark'],
  ['POST', '/api/users/:handle/follow', 'write', 'Follow (DELETE to unfollow)'],
  ['POST', '/api/media/video', 'write', 'Upload a video: the raw file as the body, Content-Type video/mp4, webm or quicktime. Returns { video: { id } }'],
  ['POST', '/api/scheduled', 'write', 'Schedule a post: the same body as /api/posts plus publishAt (ms since 1970)'],
  ['GET', '/api/conversations', 'messages', 'Direct message conversations'],
  ['POST', '/api/conversations/:handle', 'messages', 'Send a direct message. Body: { text, images?: [{ data, alt }] } (up to 4 base64 data URLs; text can be empty when images are attached)'],
  ['GET', '/api/stream', 'read', 'Realtime events (Server-Sent Events): notification, message, badges'],
];

function body() {
  const i = state.instance || {};
  const base = location.origin;
  return [
    section('intro', 'Build for 3itter', html`
      <p>Everything the 3itter apps do goes through a small JSON API, and bots and scripts can use it too.
      You need an account on <b>${i.name || '3itter'}</b> and a <b>personal API token</b>. There’s no app registration and no OAuth dance.</p>
      <ol>
        <li>Create an account for your bot (or use your own).</li>
        <li>In <b>Settings → Bots &amp; API</b>, turn on <b>This is an automated account</b>, so people see an “Automated” label, and say who runs it.</li>
        <li>Create a token with the scopes you need and keep it secret.</li>
      </ol>`),
    section('auth', 'Authentication', html`
      <p>Send the token in the <code>Authorization</code> header. Every request and response is JSON (UTF-8).</p>
      ${code(`curl ${base}/api/me \\\n  -H "Authorization: Bearer 3tt_your_token"`)}
      <ul>
        <li><b>read</b>: timelines, notifications, profiles, search and the realtime stream.</li>
        <li><b>write</b>: posting, deleting, likes, reposts, bookmarks, follows and uploads.</li>
        <li><b>messages</b>: reading and sending direct messages.</li>
      </ul>
      <p>Tokens can’t change passwords, sessions, tokens or account settings, and can’t use the admin API. That needs a real sign-in.
      Errors come back as <code>{ "error": "…" }</code> with a 4xx status.</p>`),
    section('post', 'Your first post', html`
      ${code(`curl ${base}/api/posts \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text": "Hello from my bot 🤖"}'`)}
      <p>Images go inline as data URLs (<code>{ "images": [{ "data": "data:image/png;base64,…", "alt": "…" }] }</code>, up to 4).
      Videos are uploaded first with <code>POST /api/media/video</code>, then attached with <code>{ "video": { "id": "…" } }</code>.
      Posts made with a token show “3itter for API” as their device.</p>`),
    section('endpoints', 'Endpoints', html`
      <div class="doc-table-wrap"><table class="doc-table">
        <thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>What it does</th></tr></thead>
        <tbody>${ENDPOINTS.map(([m, p, s, d]) => html`<tr><td><span class="tag">${m}</span></td><td><code>${p}</code></td><td>${s}</td><td>${d}</td></tr>`)}</tbody>
      </table></div>`),
    section('realtime', 'Realtime events', html`
      <p><code>GET /api/stream</code> is a <a class="link" href="https://developer.mozilla.org/docs/Web/API/Server-sent_events" target="_blank" rel="noopener">Server-Sent Events</a> stream.
      It sends a <code>notification</code> event for every like, repost, follow, reply, mention or quote, a <code>message</code> event for direct messages and
      <code>badges</code> with unread counts. It sends a comment line every 25 seconds; reconnect if the connection drops.</p>
      ${code(`event: notification
data: {"type":"mention","actor":{"handle":"ana","name":"Ana"},"post":{"id":123,"text":"@mybot hi!"}}`)}`),
    section('example', 'Example: a bot that answers mentions', html`
      <p>Node 18 or newer, no packages. A copy lives in the 3itter repository as <code>examples/bots/echo-bot.mjs</code>.</p>
      ${code(`// Run with: INSTANCE=${base} TOKEN=3tt_… node echo-bot.mjs
const { INSTANCE, TOKEN } = process.env;
const headers = { Authorization: \`Bearer \${TOKEN}\`, 'Content-Type': 'application/json' };

async function reply(post) {
  const text = \`@\${post.author} you said: \${post.text.replace(/@\\w+/g, '').trim()}\`;
  await fetch(\`\${INSTANCE}/api/posts\`, { method: 'POST', headers, body: JSON.stringify({ text, replyTo: post.id }) });
}

for (;;) {
  const res = await fetch(\`\${INSTANCE}/api/stream\`, { headers });
  let buffer = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\\n\\n')) >= 0) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event !== 'notification' || !data) continue;
      const n = JSON.parse(data);
      if (n.type === 'mention' && n.post) await reply({ id: n.post.id, text: n.post.text, author: n.actor.handle });
    }
  }
  await new Promise((r) => setTimeout(r, 5000)); // reconnect
}`)}
      <p>The same in Python, using only <code>requests</code>:</p>
      ${code(`import json, os, requests
base, token = os.environ["INSTANCE"], os.environ["TOKEN"]
h = {"Authorization": f"Bearer {token}"}
with requests.get(f"{base}/api/stream", headers=h, stream=True) as r:
    event = None
    for line in r.iter_lines(decode_unicode=True):
        if line.startswith("event: "): event = line[7:]
        elif line.startswith("data: ") and event == "notification":
            n = json.loads(line[6:])
            if n["type"] == "mention" and n.get("post"):
                requests.post(f"{base}/api/posts", headers=h,
                              json={"text": f"@{n['actor']['handle']} hello!", "replyTo": n["post"]["id"]})`)}`),
    section('rules', 'Rules for bots', html`
      <ul>
        <li>Turn on the <b>Automated</b> label, and say who runs the bot.</li>
        <li>Only reply or message people who asked for it (mentioned the bot, followed it, or messaged it first). Don’t send unsolicited mentions or DMs.</li>
        <li>Keep it calm: each token can make about 600 requests per 10 minutes, and posting has its own limits.</li>
        <li>Follow the instance’s <a class="link" href="/terms">Terms</a> and rules. Moderators can suspend bots like any account.</li>
      </ul>`),
  ];
}

export function developersView({ standalone = false } = {}) {
  const name = state.instance?.name || '3itter';
  const root = el(html`<div class="view doc-view${standalone ? ' standalone' : ''}">
    ${standalone
    ? html`<header class="doc-top"><a class="brand" href="/"><span class="brand-mark"></span><span class="brand-name">${name}</span></a>
        <a class="btn tonal" href="/">${icon('arrow_back', 'sm')}Back</a></header>`
    : topBar({ back: true, title: 'Developers', sub: name })}
    <article class="doc card">
      <div class="doc-hero">
        <span class="doc-art shape-flower">${icon('smart_toy')}</span>
        <div><h1 class="headline-large emph">Bots &amp; API</h1><p class="doc-updated">Build bots, scripts and integrations for ${name}</p></div>
      </div>
      ${body()}
    </article>
  </div>`);
  return { el: root, title: 'Developers' };
}
