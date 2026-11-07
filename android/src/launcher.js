// 3itter instance picker. Checks that an address is a real 3itter server
// (GET /.well-known/3itter), remembers it, and opens it in this WebView.
// Opening adds ?client=android&launcher=<this page's origin> so the web app can offer
// "Switch instance", which comes back here with ?switch=1.

const KEY = 'itter-instances';      // [{ url, name, domain, last }]
const LAST = 'itter-last-instance';

const store = {
  list() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } },
  save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 10))); } catch { /* storage full */ } },
  last() { try { return localStorage.getItem(LAST); } catch { return null; } },
  setLast(url) { try { if (url) localStorage.setItem(LAST, url); else localStorage.removeItem(LAST); } catch { /* ignore */ } },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normalize(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter an instance address, like twitter.republican');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That doesn’t look like a web address.'); }
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '10.0.2.2'].includes(u.hostname)) throw new Error('Instances must use https.');
  return u.origin;
}

async function probe(origin) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let info;
  try {
    const res = await fetch(`${origin}/.well-known/3itter`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The instance took too long to answer.' : `Couldn’t reach ${new URL(origin).host}. Check the address and your connection.`);
  } finally { clearTimeout(timer); }
  if (info?.software !== '3itter') throw new Error('That server isn’t a 3itter instance.');
  return { url: origin, name: info.name || info.domain, domain: info.domain || new URL(origin).host, description: info.description || '' };
}

function open(origin) {
  store.setLast(origin);
  const q = new URLSearchParams({ client: 'android', launcher: location.origin });
  location.href = `${origin}/?${q}`;
}

function remember(inst) {
  const list = store.list().filter((x) => x.url !== inst.url);
  list.unshift({ ...inst, last: Date.now() });
  store.save(list);
}

function drawSaved() {
  const list = store.list();
  const sec = $('.saved');
  sec.hidden = !list.length;
  sec.querySelector('.list').innerHTML = list.map((x) => `<li>
    <button class="item" type="button" data-url="${esc(x.url)}">
      <span class="avatar">${esc((x.name || x.domain || '?')[0].toUpperCase())}</span>
      <span class="text"><b>${esc(x.name || x.domain)}</b><small>${esc(x.domain)}</small></span><span class="go">›</span>
    </button>
    <button class="remove" type="button" data-remove="${esc(x.url)}" aria-label="Forget ${esc(x.domain)}">×</button></li>`).join('');
  const known = new Set(list.map((x) => x.url));
  $('.suggested').hidden = known.has('https://twitter.republican');
}

async function connect(input, button) {
  const err = $('.error');
  err.hidden = true;
  const spinner = $('.spinner');
  button.disabled = true;
  spinner.hidden = false;
  try {
    const origin = normalize(input);
    const inst = await probe(origin);
    remember(inst);
    open(inst.url);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    button.disabled = false;
    spinner.hidden = true;
  }
}

const params = new URLSearchParams(location.search);
const last = store.last();
if (last && !params.has('switch')) {
  open(last); // go straight to the instance you used last time
} else {
  if (params.has('switch')) store.setLast(null);
  drawSaved();
  const form = $('.connect');
  form.addEventListener('submit', (e) => { e.preventDefault(); connect(form.url.value, form.querySelector('button')); });
  document.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { store.save(store.list().filter((x) => x.url !== rm.dataset.remove)); drawSaved(); return; }
    const item = e.target.closest('[data-url]');
    if (item) { form.url.value = new URL(item.dataset.url).host; connect(item.dataset.url, form.querySelector('button')); }
  });
}
