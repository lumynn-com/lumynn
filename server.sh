#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${ROOT_DIR}/data/server.pid"
LOG_FILE="${ROOT_DIR}/data/server.log"
MODE="${MODE:-prod}"

mkdir -p "${ROOT_DIR}/data"

# Prefer Apple Silicon Homebrew Node when available. This avoids macOS bash
# login shells resolving older /usr/local/bin/node versions.
if [[ -d "/opt/homebrew/bin" ]]; then
  export PATH="/opt/homebrew/bin:${PATH}"
fi

NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"

usage() {
  cat <<USAGE
Usage: ./server.sh <start|stop|restart|status|logs|reset-password> [--dev|--prod]

Commands:
  start                                 Start the web app in the background
  stop                                  Stop the running app
  restart                               Stop and start the app
  status                                Show whether the app is running
  logs                                  Follow the app log
  reset-password <username> <password>  Reset a user's password (out-of-band)

Modes:
  --prod    Run npm run server (default, serves dist/client after npm run build)
  --dev     Run npm run dev (backend + Vite dev server)

Examples:
  ./server.sh start
  ./server.sh start --dev
  ./server.sh restart
  ./server.sh logs
  ./server.sh reset-password admin "new-strong-password"
USAGE
}

parse_mode() {
  for arg in "$@"; do
    case "${arg}" in
      --dev) MODE="dev" ;;
      --prod) MODE="prod" ;;
    esac
  done
}

is_running() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${PID_FILE}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

project_pids() {
  ps -axo pid=,pgid=,command= | awk -v root="${ROOT_DIR}" -v ppid="$$" '
    # Match only processes that are actually started by this script.
    # The repo path can also appear in editor helper commands such as
    # tsserver / typingsInstaller; do not block start/stop on those.
    index($0, root) > 0 &&
      $0 !~ /(ps |grep |awk |typescript\/lib\/tsserver|typingsInstaller)/ &&
      ($0 ~ /npm run (server|dev)/ ||
       $0 ~ /tsx( watch)? src\/server\/server\.ts/ ||
       $0 ~ /src\/server\/server\.ts/ ||
       $0 ~ /vite( |$)/ ||
       $0 ~ /concurrently/) {
      print $1
    }
  '
}

has_project_processes() {
  [[ -n "$(project_pids)" ]]
}

process_pgid() {
  local pid="$1"
  ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' '
}

terminate_pid() {
  local pid="$1"
  local pgid
  pgid="$(process_pgid "${pid}")"

  if [[ -n "${pgid}" && "${pgid}" != "$$" ]]; then
    kill -"${pgid}" 2>/dev/null || true
  fi

  kill "${pid}" 2>/dev/null || true
}

force_kill_project_processes() {
  local pids
  pids="$(project_pids)"
  [[ -n "${pids}" ]] || return 0

  echo "Cleaning up remaining project server processes:"
  echo "${pids}" | tr '\n' ' '
  echo

  while read -r pid; do
    [[ -n "${pid}" ]] || continue
    terminate_pid "${pid}"
  done <<<"${pids}"

  sleep 1

  pids="$(project_pids)"
  [[ -n "${pids}" ]] || return 0
  while read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -9 "${pid}" 2>/dev/null || true
  done <<<"${pids}"
}

start_server() {
  if is_running; then
    echo "Already running with PID $(cat "${PID_FILE}")."
    return 0
  fi

  if has_project_processes; then
    echo "Related project server processes are already running:"
    project_pids | tr '\n' ' '
    echo
    echo "Run ./server.sh stop first to clean them up."
    return 1
  fi

  cd "${ROOT_DIR}"

  # Load environment variables from ~/.bashrc
  if [[ -f ~/.bashrc ]]; then
    # Extract only export lines for our variables (avoids executing interactive shell stuff)
    source <(grep -E 'export (ALLOWED_VAULT_ROOTS|SESSION_SECRET|APP_ENCRYPTION_KEY)=' ~/.bashrc)
  fi

  local npm_script
  if [[ "${MODE}" == "dev" ]]; then
    npm_script="dev"
  else
    npm_script="server"
  fi

  echo "Starting Lumynn (${MODE})..."
  echo "Node: $("${NODE_BIN}" -v) (${NODE_BIN})"
  echo "npm: ${NPM_BIN}"
  echo "Logs: ${LOG_FILE}"
  echo "Allowed library roots: ${ALLOWED_VAULT_ROOTS:-not set}"
  {
    echo "=== $(date) starting ${MODE} ==="
    echo "Node: $("${NODE_BIN}" -v) (${NODE_BIN})"
    echo "npm: ${NPM_BIN}"
    echo "Allowed library roots: ${ALLOWED_VAULT_ROOTS:-not set}"
  } >>"${LOG_FILE}"
  nohup env PATH="${PATH}" ALLOWED_VAULT_ROOTS="${ALLOWED_VAULT_ROOTS}" SESSION_SECRET="${SESSION_SECRET}" APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY}" "${NPM_BIN}" run "${npm_script}" >>"${LOG_FILE}" 2>&1 &
  echo "$!" >"${PID_FILE}"
  sleep 1

  if is_running; then
    echo "Started with PID $(cat "${PID_FILE}")."
  else
    echo "Failed to start. Last log lines:"
    tail -n 40 "${LOG_FILE}" || true
    rm -f "${PID_FILE}"
    exit 1
  fi
}

stop_server() {
  if ! is_running; then
    echo "No managed PID is running."
    rm -f "${PID_FILE}"
    force_kill_project_processes
    echo "Stopped."
    return 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  echo "Stopping PID ${pid}..."
  terminate_pid "${pid}"

  for _ in {1..20}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      force_kill_project_processes
      echo "Stopped."
      return 0
    fi
    sleep 0.25
  done

  echo "Process did not stop gracefully; forcing..."
  kill -9 "${pid}" 2>/dev/null || true
  force_kill_project_processes
  rm -f "${PID_FILE}"
  echo "Stopped."
}

status_server() {
  if is_running; then
    echo "Running with PID $(cat "${PID_FILE}")."
  else
    echo "Not running."
  fi

  local pids
  pids="$(project_pids)"
  if [[ -n "${pids}" ]]; then
    echo "Related project server processes:"
    while read -r pid; do
      [[ -n "${pid}" ]] || continue
      ps -o pid,ppid,pgid,command -p "${pid}" 2>/dev/null || true
    done <<<"${pids}"
  fi
}

follow_logs() {
  touch "${LOG_FILE}"
  tail -f "${LOG_FILE}"
}

command="${1:-}"
shift || true
parse_mode "$@"

reset_password() {
  local username="${1:-}"
  local password="${2:-}"
  if [[ -z "${username}" || -z "${password}" ]]; then
    echo "Usage: ./server.sh reset-password <username> <new-password>" >&2
    exit 2
  fi
  cd "${ROOT_DIR}"
  # Run the script directly through tsx; no need for the long-running
  # server, and no need for ALLOWED_VAULT_ROOTS / network secrets.
  exec "${NPM_BIN}" exec --silent -- tsx src/server/cli/resetPassword.ts "${username}" "${password}"
}

case "${command}" in
  start) start_server ;;
  stop) stop_server ;;
  restart)
    stop_server
    start_server
    ;;
  status) status_server ;;
  logs) follow_logs ;;
  reset-password) reset_password "$@" ;;
  -h|--help|help|"") usage ;;
  *)
    echo "Unknown command: ${command}" >&2
    usage
    exit 1
    ;;
esac
