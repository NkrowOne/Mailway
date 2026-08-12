#!/bin/bash
set -euo pipefail

# Installs the agent skills this project uses.
#
# Only runs in Claude Code on the web: those containers are ephemeral, so
# $HOME is wiped between sessions and globally installed skills do not
# survive. Local machines keep their own installs and are left alone.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SKILLS_DIR="${HOME}/.agents/skills"

# A failed install should never block the session — warn and carry on.
install_skill() {
  name="$1"
  shift
  if [ -d "${SKILLS_DIR}/${name}" ]; then
    echo "[skills] ${name}: already installed"
    return 0
  fi
  echo "[skills] ${name}: installing"
  if npx --yes skills add "$@" -g; then
    echo "[skills] ${name}: ok"
  else
    echo "[skills] ${name}: install failed, continuing without it" >&2
  fi
}

install_skill interface-design \
  https://github.com/dammyjay93/interface-design --skill interface-design
install_skill impeccable pbakaus/impeccable
