// Realtime events over Server-Sent Events: GET /api/stream keeps a connection open per signed-in tab
// (or app) and receives `badges`, `notification` and `message` events as they happen.
// Works through Caddy and Cloudflare (SSE is plain HTTP; a comment line every 25 s keeps it alive).
import { get } from './db.js';

const clients = new Map(); // userId -> Set<res>
const MAX_PER_USER = 12;

export function badgesFor(userId) {
  return get(`SELECT
    (SELECT COUNT(*) FROM notifications n JOIN users a ON a.id = n.actor_id WHERE n.user_id = :me AND n.read = 0 AND a.suspended = 0) AS notifications,
    (SELECT COUNT(*) FROM messages m JOIN users a ON a.id = m.sender_id WHERE m.recipient_id = :me AND m.read = 0 AND a.suspended = 0
       AND m.sender_id NOT IN (SELECT target_id FROM blocks WHERE user_id = :me)) AS messages`, { me: userId });
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function openStream(req, res, userId, { messages = true } = {}) {
  res.withMessages = messages;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  res.write(frame('badges', badgesFor(userId)));
  let set = clients.get(userId);
  if (!set) clients.set(userId, (set = new Set()));
  if (set.size >= MAX_PER_USER) { const oldest = set.values().next().value; oldest.end(); set.delete(oldest); }
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  const close = () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) clients.delete(userId);
  };
  req.on('close', close);
  res.on('error', close);
}

export const isOnline = (userId) => clients.has(userId);

// Send an event to every open stream of a user. Runs after the current transaction has committed.
export function publish(userId, event, data) {
  if (!clients.has(userId)) return;
  setImmediate(() => {
    const set = clients.get(userId);
    if (!set) return;
    const payload = frame(event, typeof data === 'function' ? data() : data);
    const badges = frame('badges', badgesFor(userId));
    for (const res of set) {
      // a stream opened with an API token lacking the "messages" scope gets no message text
      if (event !== 'message' || res.withMessages) res.write(payload);
      res.write(badges);
    }
  });
}

// A post's link preview finished loading: tell its author's open tabs so the card appears.
export function publishCardReady(userId, postId) {
  if (userId) publish(userId, 'card', { postId });
}
