#!/usr/bin/env bash
# Deploy 3itter to a server running it as a systemd service (code in /opt/orbit, data in /var/lib/orbit).
#
#   ./deploy.sh              deploy the committed code (HEAD) — backs up code and database first
#   ./deploy.sh status       what's deployed vs. what you have locally, and service health
#   ./deploy.sh backups      list backups on the server
#   ./deploy.sh rollback     put back the code from the latest backup (or: ./deploy.sh rollback <file>)
#
# Options: --allow-dirty (deploy even with uncommitted changes; they are NOT included), -y (don't ask).
#
# Server settings come from .deploy.env (gitignored; copy .deploy.env.example). Keep the server's address out of the
# repo: behind Cloudflare, the origin IP is what lets people bypass it.
#
# The deploy never touches the data directory (database, uploads). It replaces the code, restarts the service, waits
# until it answers, and rolls the code back by itself if it doesn't come up.
set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------- settings
[ -f .deploy.env ] && . ./.deploy.env
DEPLOY_USER=${DEPLOY_USER:-opc}
DEPLOY_DIR=${DEPLOY_DIR:-/opt/orbit}
DEPLOY_DATA=${DEPLOY_DATA:-/var/lib/orbit}
DEPLOY_SERVICE=${DEPLOY_SERVICE:-orbit.service}
DEPLOY_BACKUPS=${DEPLOY_BACKUPS:-3itter-backups}   # relative to the remote user's home
DEPLOY_KEEP=${DEPLOY_KEEP:-10}                      # backups of each kind to keep
DEPLOY_URL=${DEPLOY_URL:-}                          # public address to check afterwards (optional)
if [ -z "${DEPLOY_HOST:-}" ]; then
  echo "Set DEPLOY_HOST in .deploy.env (see .deploy.env.example)." >&2
  exit 1
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)
[ -n "${DEPLOY_KEY:-}" ] && SSH_OPTS+=(-i "${DEPLOY_KEY/#\~/$HOME}")
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Run a script on the server with the settings exported to it.
remote() {
  ssh "${SSH_OPTS[@]}" "$TARGET" \
    "DEPLOY_DIR='$DEPLOY_DIR' DEPLOY_DATA='$DEPLOY_DATA' DEPLOY_SERVICE='$DEPLOY_SERVICE' DEPLOY_BACKUPS='$DEPLOY_BACKUPS' DEPLOY_KEEP='$DEPLOY_KEEP' $* bash -s"
}

# Shared remote helpers, prepended to every remote script.
REMOTE_LIB='
set -euo pipefail
B="$HOME/$DEPLOY_BACKUPS"
mkdir -p "$B" && chmod 700 "$B"   # backups hold password hashes
svc_env() { systemctl show -p Environment --value "$DEPLOY_SERVICE" | tr " " "\n" | sed -n "s/^$1=//p"; }
NODE=$(systemctl show -p ExecStart --value "$DEPLOY_SERVICE" | grep -o "path=[^ ;]*" | head -1 | cut -d= -f2)
NODE=${NODE:-node}
PORT=$(svc_env PORT); PORT=${PORT:-3000}
DBFILE="$DEPLOY_DATA/3itter.db"
deployed_rev() { sudo cat "$DEPLOY_DIR/REVISION" 2>/dev/null || echo unknown; }
# Wait until the service is running and answering on its port.
healthy() {
  for _ in $(seq 1 30); do
    if systemctl is-active --quiet "$DEPLOY_SERVICE" && curl -fs -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/instance"; then return 0; fi
    sleep 1
  done
  return 1
}
# A consistent copy of the live database (WAL mode: copying the file alone could miss recent writes).
backup_db() {
  # The data directory is private to the service user: check (and read) it with sudo.
  sudo test -f "$DBFILE" || { echo "  no database at $DBFILE, skipping" >&2; echo none; return 0; }
  local out="$B/db-$1.sqlite"
  sudo "$NODE" --no-warnings -e "new (require(\"node:sqlite\").DatabaseSync)(process.argv[1], { readOnly: true }).prepare(\"VACUUM INTO ?\").run(process.argv[2])" "$DBFILE" "$out"
  sudo gzip -f "$out"
  sudo chown "$(id -u):$(id -g)" "$out.gz" && chmod 600 "$out.gz"
  echo "$out.gz"
}
prune() { { ls -1t "$B"/$1 2>/dev/null || true; } | tail -n +$((DEPLOY_KEEP + 1)) | xargs -r sudo rm -f; }
'

# ---------------------------------------------------------------- commands

cmd_status() {
  bold "3itter on $DEPLOY_HOST"
  echo "  local:     $(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-70)"
  remote <<EOF
$REMOTE_LIB
echo "  deployed:  \$(deployed_rev | cut -c1-80)"
echo "  service:   \$(systemctl is-active "\$DEPLOY_SERVICE") since \$(systemctl show -p ActiveEnterTimestamp --value "\$DEPLOY_SERVICE")"
curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:\$PORT/api/instance" && echo "  answering: yes (port \$PORT)" || echo "  answering: NO (port \$PORT)"
echo "  data:      \$(sudo du -sh "\$DEPLOY_DATA" | cut -f1) in \$DEPLOY_DATA"
EOF
}

cmd_backups() {
  bold "Backups on $DEPLOY_HOST (~/$DEPLOY_BACKUPS)"
  remote <<EOF
$REMOTE_LIB
ls -lht "\$B" | sed 1d | awk '{print "  " \$5 "\t" \$6 " " \$7 " " \$8 "\t" \$9}'
EOF
}

cmd_rollback() {
  local file=${1:-}
  bold "Rolling back the code on $DEPLOY_HOST"
  confirm "Replace the running code with ${file:-the latest backup}? The database is left as it is."
  remote "ROLLBACK_FILE='$file'" <<EOF
$REMOTE_LIB
F=\${ROLLBACK_FILE:-\$(ls -1t "\$B"/code-*.tgz 2>/dev/null | head -1 || true)}
[ -n "\$F" ] && [ ! -f "\$F" ] && F="\$B/\$F"
[ -n "\$F" ] && [ -f "\$F" ] || { echo "  no code backup found"; exit 1; }
echo "  restoring \$F"
TMP=\$(mktemp -d); trap 'sudo rm -rf "\$TMP"' EXIT
sudo tar -xzf "\$F" -C "\$TMP"
sudo rsync -a --delete "\$TMP/\$(basename "\$DEPLOY_DIR")/" "\$DEPLOY_DIR/"
sudo systemctl restart "\$DEPLOY_SERVICE"
healthy && echo "  ✓ running \$(deployed_rev)" || { echo "  ✗ the service isn't answering: sudo journalctl -u \$DEPLOY_SERVICE -n 50"; exit 1; }
echo "  To also restore the database from before that deploy (loses everything written since):"
echo "    sudo systemctl stop \$DEPLOY_SERVICE && gunzip -c \$B/db-<stamp>.sqlite.gz | sudo tee \$DBFILE >/dev/null && sudo rm -f \$DBFILE-wal \$DBFILE-shm && sudo chown \\\$(stat -c %U:%G \$DEPLOY_DATA) \$DBFILE && sudo systemctl start \$DEPLOY_SERVICE"
EOF
}

confirm() {
  [ "$YES" = 1 ] && return 0
  read -r -p "  $1 [y/N] " a
  [[ "$a" =~ ^[Yy] ]] || die "Cancelled."
}

cmd_deploy() {
  local rev subject
  rev=$(git rev-parse --short HEAD)
  subject=$(git log -1 --format=%s)
  bold "Deploying $rev to $DEPLOY_HOST: $subject"

  # 1. Local checks.
  if ! git diff --quiet HEAD -- server public examples package.json; then
    [ "$ALLOW_DIRTY" = 1 ] || die "You have uncommitted changes in server/, public/ or examples/. Commit them (only HEAD is deployed) or pass --allow-dirty."
    warn "uncommitted changes are NOT included (deploying HEAD)"
  fi
  git fetch -q origin 2>/dev/null && [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] || warn "$rev isn't pushed to GitHub yet"
  if command -v node >/dev/null; then
    for f in server/*.js; do node --check "$f" 2>/dev/null || die "syntax error in $f"; done
    ok "server code parses"
  fi

  # 2. Package exactly what's committed, plus a REVISION file.
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  mkdir "$tmp/app"
  git archive HEAD server public examples README.md package.json .gitignore | tar -x -C "$tmp/app"
  echo "$rev $(git log -1 --format=%cI) $subject" > "$tmp/app/REVISION"
  tar -czf "$tmp/3itter.tgz" -C "$tmp/app" .
  ok "packaged $(du -h "$tmp/3itter.tgz" | cut -f1)"

  confirm "Deploy $rev to $DEPLOY_HOST now? (backs up first; the site restarts for a few seconds)"
  scp -q "${SSH_OPTS[@]}" "$tmp/3itter.tgz" "$TARGET:/tmp/3itter-$rev.tgz"
  ok "uploaded"

  # 3. On the server: back up, swap the code, restart, check, roll back on failure.
  remote "REV='$rev'" <<EOF
$REMOTE_LIB
STAMP=\$(date +%Y%m%d-%H%M%S)
OLD=\$(deployed_rev | cut -d" " -f1)
echo "  ✓ was running: \$OLD"

sudo tar -czf "\$B/code-\$STAMP-\$OLD.tgz" -C "\$(dirname "\$DEPLOY_DIR")" "\$(basename "\$DEPLOY_DIR")"
sudo chown "\$(id -u):\$(id -g)" "\$B/code-\$STAMP-\$OLD.tgz" && chmod 600 "\$B/code-\$STAMP-\$OLD.tgz"
echo "  ✓ code backup:     \$B/code-\$STAMP-\$OLD.tgz"
DBB=\$(backup_db "\$STAMP")
echo "  ✓ database backup: \$DBB"

NEW=\$(mktemp -d); trap 'sudo rm -rf "\$NEW" /tmp/3itter-\$REV.tgz' EXIT
tar -xzf "/tmp/3itter-\$REV.tgz" -C "\$NEW"
# --delete drops files removed from the repo; files that only exist on the server (package-lock.json, .env) stay.
sudo rsync -a --delete --exclude package-lock.json --exclude .env --exclude node_modules/ "\$NEW/" "\$DEPLOY_DIR/"
sudo chown -R root:root "\$DEPLOY_DIR"
echo "  ✓ code replaced in \$DEPLOY_DIR"

sudo systemctl restart "\$DEPLOY_SERVICE"
if healthy; then
  echo "  ✓ service is up and answering on port \$PORT"
else
  echo "  ✗ the new version didn't come up. Last log lines:"
  sudo journalctl -u "\$DEPLOY_SERVICE" -n 25 --no-pager | sed 's/^/      /'
  echo "  ↺ rolling the code back to \$OLD"
  ROLL=\$(mktemp -d)
  sudo tar -xzf "\$B/code-\$STAMP-\$OLD.tgz" -C "\$ROLL"
  sudo rsync -a --delete "\$ROLL/\$(basename "\$DEPLOY_DIR")/" "\$DEPLOY_DIR/"
  sudo rm -rf "\$ROLL"
  sudo systemctl restart "\$DEPLOY_SERVICE"
  healthy && echo "  ✓ back on \$OLD" || echo "  ✗ the old version isn't answering either: check sudo journalctl -u \$DEPLOY_SERVICE"
  exit 1
fi
prune "code-*.tgz"; prune "db-*.sqlite.gz"
EOF

  # 4. From outside: the public site serves the new code.
  if [ -n "$DEPLOY_URL" ]; then
    local html asset want got
    html=$(curl -fsS --max-time 15 "$DEPLOY_URL/") || die "$DEPLOY_URL doesn't answer"
    asset=$(printf '%s' "$html" | grep -o '/v/[A-Za-z0-9]*/js/app.js' | head -1 || true)
    want=$(git show HEAD:public/js/app.js | shasum -a 256 | cut -c1-16)
    got=$(curl -fsS --max-time 15 "$DEPLOY_URL${asset:-/js/app.js}" | shasum -a 256 | cut -c1-16)
    [ "$want" = "$got" ] && ok "$DEPLOY_URL serves the new version" || die "$DEPLOY_URL still serves different code (cache?)"
  fi
  bold "Deployed $rev."
}

# ---------------------------------------------------------------- main
ALLOW_DIRTY=0; YES=0; ARGS=()
for a in "$@"; do
  case "$a" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
case "${ARGS[0]:-deploy}" in
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  backups) cmd_backups ;;
  rollback) cmd_rollback "${ARGS[1]:-}" ;;
  *) die "Unknown command: ${ARGS[0]}. Try ./deploy.sh --help" ;;
esac
