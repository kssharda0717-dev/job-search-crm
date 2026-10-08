#!/bin/bash
#
# Run the proxy as a background macOS service, so it starts at login and needs
# no terminal window left open.
#
# Why launchd and not pm2/forever/nohup: launchd is already running on every
# Mac, survives reboots without a login item, and restarts the process if it
# crashes. The alternatives all need something *else* to be running first,
# which just moves the problem.
#
# Why this generates the plist instead of committing one: a .plist needs
# absolute paths, and the repo path differs on every machine that clones it.
#
#   ./scripts/macos-service.sh install     start now and at every login
#   ./scripts/macos-service.sh status      is it running, and on which port
#   ./scripts/macos-service.sh logs        follow the log
#   ./scripts/macos-service.sh restart     after changing .env or server code
#   ./scripts/macos-service.sh uninstall   stop and remove
#
set -euo pipefail

LABEL="com.jobsearchcrm.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/jobsearchcrm"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="gui/$(id -u)/$LABEL"

die() { printf '\nerror: %s\n\n' "$1" >&2; exit 1; }

port() {
  # The port the proxy will actually bind, honouring PORT in .env.
  local p
  p=$(grep -E '^[[:space:]]*PORT=' "$REPO/server/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' \r')
  echo "${p:-8787}"
}

cmd_install() {
  [ -f "$REPO/server/.env" ] || die "server/.env not found.
Copy the example and fill it in first:
    cp server/.env.example server/.env"

  [ -d "$REPO/node_modules" ] || die "dependencies not installed. Run: pnpm install"

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  # launchd starts processes with a near-empty PATH and no shell profile, so
  # `pnpm` and `node` are both invisible to it. Re-create just enough
  # environment: nvm if it is there, Homebrew and /usr/local either way.
  local launch_cmd
  launch_cmd='export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
command -v pnpm >/dev/null || { echo "pnpm not found on PATH"; exit 127; }
cd '"$(printf '%q' "$REPO")"'
exec pnpm --filter @crm/server start'

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>$(printf '%s' "$launch_cmd" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')</string>
  </array>

  <!-- Start at login. -->
  <key>RunAtLoad</key><true/>

  <!-- Restart if it exits for any reason. A drafting run that dies mid-sweep
       should not leave the extension talking to nothing until the next login. -->
  <key>KeepAlive</key><true/>

  <!-- Back off instead of hot-looping when the cause is permanent, e.g. a bad
       key in .env. Without this a config error spins the CPU forever. -->
  <key>ThrottleInterval</key><integer>10</integer>

  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl bootout "$TARGET" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"

  printf '\ninstalled %s\n  logs   %s/server.log\n\n' "$LABEL" "$LOG_DIR"
  sleep 3
  cmd_status
}

cmd_status() {
  local p; p=$(port)
  if launchctl print "$TARGET" >/dev/null 2>&1; then
    local pid; pid=$(launchctl print "$TARGET" 2>/dev/null | awk '/^[[:space:]]*pid =/{print $3; exit}')
    printf 'service   registered (pid %s)\n' "${pid:-none — see logs}"
  else
    printf 'service   not installed\n'
  fi

  # The service being registered is not the same as the port answering, which
  # is the thing the extension actually depends on.
  if curl -fsS --max-time 3 "http://127.0.0.1:$p/health" >/dev/null 2>&1; then
    printf 'health    ok on http://localhost:%s\n\n' "$p"
  else
    printf 'health    NOT responding on port %s\n          check: %s logs\n\n' "$p" "$0"
  fi
}

cmd_logs()    { mkdir -p "$LOG_DIR"; touch "$LOG_DIR/server.log"; tail -n 50 -f "$LOG_DIR/server.log"; }
cmd_restart() { launchctl kickstart -k "$TARGET" && sleep 3 && cmd_status; }

cmd_uninstall() {
  launchctl bootout "$TARGET" 2>/dev/null || true
  rm -f "$PLIST"
  printf '\nremoved %s (logs kept in %s)\n\n' "$LABEL" "$LOG_DIR"
}

case "${1:-}" in
  install)   cmd_install ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  restart)   cmd_restart ;;
  uninstall) cmd_uninstall ;;
  *) printf 'usage: %s {install|status|logs|restart|uninstall}\n' "$0" >&2; exit 2 ;;
esac
