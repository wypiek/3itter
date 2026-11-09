// Video uploads. Videos are sent as the raw request body (no base64) to POST /api/media/video,
// streamed to disk with a size cap, checked by their magic bytes and recorded in `media` so a post
// can only attach a video its author uploaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, UPLOAD_DIR } from './db.js';
import { fail } from './http.js';
import { saveImage, rateLimit, str } from './core.js';

export const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 50) * 1024 * 1024;

const VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

function sniff(head) {
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  return null;
}

// Streams the request body into the uploads folder. Resolves with the stored file's info.
export async function receiveVideo(req, me) {
  rateLimit(`video:${me.id}`, 20, 3600_000);
  const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!VIDEO_TYPES[declared]) fail(415, 'Videos must be MP4, WebM or MOV.');
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_VIDEO_BYTES) fail(413, `Videos can be up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  const id = crypto.randomUUID();
  const tmp = path.join(UPLOAD_DIR, `${id}.part`);
  const out = fs.createWriteStream(tmp);
  // Without a listener, a write that finishes after the stream was destroyed (an interrupted upload)
  // emits an unhandled 'error' and takes the whole server down. Failures are handled below instead.
  let writeError = null;
  out.on('error', (e) => { writeError ||= e; });
  let size = 0;
  let head = Buffer.alloc(0);
  let failed = false;
  try {
    await new Promise((resolve, reject) => {
      const stop = (e) => { if (failed) return; failed = true; req.removeListener('data', onData); reject(e); };
      const onData = (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > MAX_VIDEO_BYTES) {
          stop(Object.assign(new Error('too large'), { tooLarge: true }));
          req.destroy();
          return;
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      };
      req.on('data', onData);
      req.on('end', () => (failed ? null : resolve()));
      req.on('error', stop);
      req.on('aborted', () => stop(new Error('aborted')));
      req.on('close', () => { if (!req.complete) stop(new Error('aborted')); });
      out.on('error', stop);
    });
    await new Promise((resolve, reject) => out.end((e) => (e || writeError ? reject(e || writeError) : resolve())));
  } catch (e) {
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (e.tooLarge) fail(413, `Videos can be up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
    fail(400, 'The upload was interrupted.');
  }
  const ext = sniff(head);
  if (!size || !ext) {
    fs.rm(tmp, { force: true }, () => {});
    fail(400, 'That file isn’t a video 3itter can play (MP4, WebM or MOV).');
  }
  const name = `${id}.${ext}`;
  fs.renameSync(tmp, path.join(UPLOAD_DIR, name));
  const src = `/uploads/${name}`;
  run('INSERT INTO media (id, user_id, kind, src, size, created_at) VALUES (:id, :u, :k, :src, :size, :t)',
    { id, u: me.id, k: 'video', src, size, t: Date.now() });
  return { video: { id, src, size } };
}

// Validates a post's `video` field ({ id, poster: dataURL?, alt }) and returns what to store.
// `saved` (scheduled posts) is an already-validated { src, poster, alt }.
export function prepareVideo(me, input, saved = null) {
  if (saved) return { src: String(saved.src), poster: saved.poster ? String(saved.poster) : null, alt: String(saved.alt || '') };
  if (!input) return null;
  const row = get('SELECT * FROM media WHERE id = :id AND user_id = :u AND kind = \'video\'', { id: String(input.id || ''), u: me.id });
  if (!row) fail(400, 'That video upload wasn’t found. Please upload it again.');
  if (row.post_id) fail(400, 'That video is already attached to a post.');
  return {
    src: row.src,
    poster: input.poster ? saveImage(input.poster) : null,
    alt: str(input.alt, { name: 'Video description', max: 1000 }),
    mediaId: row.id,
  };
}

export function markVideoUsed(mediaId, postId) {
  if (mediaId) run('UPDATE media SET post_id = :p WHERE id = :id', { p: postId, id: mediaId });
}

// Unattached uploads older than a day are removed.
export function cleanUnusedMedia() {
  for (const m of all('SELECT id, src FROM media WHERE post_id IS NULL AND created_at < :t', { t: Date.now() - 24 * 3600_000 })) {
    fs.rm(path.join(UPLOAD_DIR, path.basename(m.src)), { force: true }, () => {});
    run('DELETE FROM media WHERE id = :id', { id: m.id });
  }
}
