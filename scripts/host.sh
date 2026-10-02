#!/usr/bin/env bash
# host.sh
# Permanent shell entrypoint for crucible.
#
# Starts the control dashboard in the background, or manages individual hosts
# through its API. Safe to re-run: starting twice restarts rather than stacking
# duplicate servers.
#
# Usage:
#   host                     Start the dashboard on :5050
#   host 8080                Start the dashboard on another port
#   host --list              List discovered projects and their ports
#   host <dir>               Host one directory directly (single-project mode)
#   host --stop              Stop the dashboard
#   host --stop-all          Stop the dashboard and every hosted project
#   host --status            Report what is running
#   host --foreground        Run in the foreground with request logs

set -euo pipefail

# Settings live in ~/.crucible/config.json so the same tree is scanned every
# session. A dashboard started with ad-hoc --roots used to show a different set
# of projects each time, which undermined the deterministic ports.
DEFAULT_PORT="${SIM_HOST_PORT:-}"
PORT=""
ROOTS="${SIM_HOST_ROOTS:-}"
ACTION="dashboard"
TARGET_DIR=""
BACKGROUND=1
QUIET=0
SCAN_ROOT=""

if [ -t 1 ]; then
  DIM=$'\033[2m'; BOLD=$'\033[1m'; GREEN=$'\033[32m'
  RED=$'\033[31m'; CYAN=$'\033[36m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  DIM=""; BOLD=""; GREEN=""; RED=""; CYAN=""; YELLOW=""; RESET=""
fi

ok()   { printf '%sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '%sinfo%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$RESET" "$1"; }
err()  { printf '%serr%s  %s\n' "$RED" "$RESET" "$1" >&2; }

die() {
  err "$1"
  exit "${2:-1}"
}

usage() {
  cat <<'USAGE'
host - serve HTML/JS simulations locally with live reload

Dashboard (default):
  host                 Start the dashboard on :5050 in the background
  host 8080            ...on port 8080
  host --roots a,b     Scan specific storage roots (default: your home dir)

Single project:
  host <dir>           Serve one directory directly on its own derived port
  host <dir> 8080      ...on a specific port

Settings (remembered in ~/.crucible/config.json):
  host --set-roots <a,b>   Persist which directories to scan
  host --show-settings     Show the saved configuration

Management:
  host --list          List discovered projects with their ports
  host --status        Show what is running
  host --stop          Stop the dashboard
  host --stop-all      Stop the dashboard and every hosted project

Other:
  host --foreground    Run in the foreground with request logs
  host --help          This message
USAGE
}

# ---------------------------------------------------------------- args

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)        usage; exit 0 ;;
    --stop)           ACTION="stop"; shift ;;
    --stop-all)       ACTION="stop-all"; shift ;;
    --status)         ACTION="status"; shift ;;
    --list)           ACTION="list"; shift ;;
    --roots)          ROOTS="${2:?--roots needs a value}"; shift 2 ;;
    --set-roots)      ACTION="set-roots"; ROOTS="${2:?--set-roots needs a value}"; shift 2 ;;
    --show-settings)  ACTION="show-settings"; shift ;;
    -f|--foreground)  BACKGROUND=0; shift ;;
    -q|--quiet)       QUIET=1; shift ;;
    -p|--port)        PORT="${2:?--port needs a value}"; shift 2 ;;
    -*)               die "unknown option: $1" 2 ;;
    *)
      if [ -d "$1" ]; then
        TARGET_DIR="$1"
        ACTION="single"
      elif case "$1" in *[!0-9]*) false ;; *) true ;; esac; then
        PORT="$1"
      else
        die "not a directory or port: $1" 2
      fi
      shift
      ;;
  esac
done

# ---------------------------------------------------------------- locate

# Resolve the repo before anything else needs SIM_DIR.
if [ -z "${SIM_HOST_DIR:-}" ]; then
  for candidate in "$HOME/crucible" "$PWD" "$HOME/.local/share/crucible"; do
    if [ -f "$candidate/server.mjs" ]; then SIM_HOST_DIR="$candidate"; break; fi
  done
fi
SIM_DIR="${SIM_HOST_DIR:-$HOME/crucible}"
SERVER="$SIM_DIR/server.mjs"
KILL_PORT="$SIM_DIR/scripts/kill-port.mjs"

[ -f "$SERVER" ] || die "cannot locate server.mjs (set SIM_HOST_DIR or run from the repo)" 1
[ -f "$KILL_PORT" ] || KILL_PORT=""

# ---------------------------------------------------------------- settings

read_setting() {
  SIM_HOST_LIB="$SIM_DIR/lib" node -e '
    const [key] = process.argv.slice(1);
    import(process.env.SIM_HOST_LIB + "/settings.mjs")
      .then(async (m) => {
        const s = await m.readSettings();
        const v = s[key];
        if (Array.isArray(v)) process.stdout.write(v.join(","));
        else if (v != null) process.stdout.write(String(v));
      })
      .catch(() => {});
  ' "$1" 2>/dev/null
}

if [ -z "$ROOTS" ]; then
  ROOTS="$(read_setting roots)"
  [ -n "$ROOTS" ] || ROOTS="$HOME"
fi
if [ -z "$PORT" ]; then
  PORT="$(read_setting port)"
  [ -n "$PORT" ] || PORT="5050"
fi

# ---------------------------------------------------------------- helpers

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&-; exec 3>&-; return 0; }
  return 1
}

wait_for_port() {
  # The first scan of a large home directory takes several seconds, so allow a
  # generous budget before declaring failure.
  local port="$1" tries="${2:-200}"
  while [ "$tries" -gt 0 ]; do
    port_in_use "$port" && return 0
    sleep 0.1
    tries=$((tries - 1))
  done
  return 1
}

free_port() {
  if [ -n "$KILL_PORT" ]; then
    node "$KILL_PORT" --port "$1" >/dev/null 2>&1 || true
  fi
  sleep 0.2
}

api() {
  local endpoint="$1" payload="${2:-}"
  if [ -n "$payload" ]; then
    curl -s -m 60 -X POST -H 'content-type: application/json' \
      -d "$payload" "http://127.0.0.1:${PORT}/__simhost/api/${endpoint}" 2>/dev/null
  else
    curl -s -m 30 "http://127.0.0.1:${PORT}/__simhost/api/${endpoint}" 2>/dev/null
  fi
}

open_url() {
  local url="$1"
  for opener in xdg-open open sensible-browser wslview termux-open; do
    if command -v "$opener" >/dev/null 2>&1; then
      "$opener" "$url" >/dev/null 2>&1 &
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------- actions

save_settings() {
  SIM_HOST_LIB="$SIM_DIR/lib" node -e '
    import(process.env.SIM_HOST_LIB + "/settings.mjs").then(async (m) => {
      const [roots, port] = process.argv.slice(1);
      await m.writeSettings({
        roots: roots ? roots.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        port: port ? Number(port) : undefined,
      });
    }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "${1:-}" "${2:-}"
}

case "$ACTION" in
  set-roots)
    if [ -z "$ROOTS" ]; then
      die "--set-roots needs a value, for example: host --set-roots ~/projects,~/work" 2
    fi
    save_settings "$ROOTS" "$PORT"
    ok "saved roots to ~/.crucible/config.json"
    info "${ROOTS}"
    exit 0
    ;;

  show-settings)
    printf '%s
' "$HOME/.crucible/config.json"
    [ -f "$HOME/.crucible/config.json" ] && cat "$HOME/.crucible/config.json" || echo "(none yet)"
    exit 0
    ;;

  list)
    exec node "$SERVER" --roots "$ROOTS" --list
    ;;

  status)
    if port_in_use "$PORT"; then
      ok "dashboard on http://localhost:$PORT/"
      instances="$(api state)"
      if [ -n "$instances" ]; then
        printf '%s' "$instances" | node -e '
          let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
            try {
              const s=JSON.parse(d);
              const rows=Object.entries(s.instances||{});
              if(!rows.length){console.log("  no hosted projects");return;}
              for(const [dir,v] of rows) console.log(`  :${v.port} ${v.alive?"alive":"dead "} ${dir}`);
            } catch { console.log("  (could not read dashboard state)"); }
          });'
      fi
      exit 0
    fi
    info "no dashboard on port $PORT"
    exit 1
    ;;

  stop|stop-all)
    if port_in_use "$PORT"; then
      if [ "$ACTION" = "stop-all" ]; then
        api state >/dev/null
        for dir in $(api state | node -e '
          let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
            try { const s=JSON.parse(d);
              for(const k of Object.keys(s.instances||{})) process.stdout.write(JSON.stringify(k)+"\n");
            } catch {}
          });'); do
          api stop "$(printf '{"dir":%s}' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$dir")")" >/dev/null
          info "stopped ${dir}"
        done
      fi
      free_port "$PORT"
      if port_in_use "$PORT"; then
        die "port $PORT still in use", 1
      fi
      ok "port $PORT is free"
    else
      info "nothing listening on $PORT"
    fi
    exit 0
    ;;

  single)
    exec bash "$SIM_DIR/scripts/host-single.sh" "$TARGET_DIR" "$PORT"
    ;;
esac

# ---------------------------------------------------------------- dashboard start

if port_in_use "$PORT"; then
  warn "port $PORT already in use, restarting the dashboard"
  free_port "$PORT"
  port_in_use "$PORT" && die "could not free port $PORT", 1
fi

if [ "$BACKGROUND" -eq 1 ]; then
  LOG="/tmp/crucible-${PORT}.log"
  # run-background.mjs performs a true detach (new session, stdio to the log,
  # unref'd handle) so this shell does not block on the child's pipes.
  node "$SIM_DIR/scripts/run-background.mjs" "$LOG" \
    node "$SERVER" --roots "$ROOTS" --port "$PORT" ${QUIET:+--quiet} >/dev/null

  if ! wait_for_port "$PORT"; then
    err "dashboard failed to start; last lines of $LOG:"
    tail -n 20 "$LOG" >&2 || true
    exit 1
  fi

  URL="http://localhost:${PORT}/"
  ok "crucible dashboard running"
  info "url      ${CYAN}${URL}${RESET}"
  info "roots    ${ROOTS}"
  info "log      ${DIM}${LOG}${RESET}"
  printf '  %sproject%s   host --list\n  %sstatus%s   host --status\n  %sstop%s     host --stop-all\n\n' \
    "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET"
  [ "$QUIET" -eq 0 ] && open_url "$URL"
  exit 0
else
  exec node "$SERVER" --roots "$ROOTS" --port "$PORT"
fi
