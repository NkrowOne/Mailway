#!/bin/bash
set -euo pipefail

# Installs the agent skills this project uses, and registers impeccable's
# design hook globally so it runs on every edit in every project.
#
# Only runs in Claude Code on the web: those containers are ephemeral, so
# $HOME is wiped between sessions and globally installed skills do not
# survive. Local machines keep their own installs and are left alone.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SKILLS_DIR="${HOME}/.agents/skills"
IMPECCABLE_DIR="${SKILLS_DIR}/impeccable"

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

# impeccable's detector reaches for these parsers via bare dynamic imports and
# silently degrades to regex matching without them — no contrast checks, no
# custom properties, undercounted findings. The skill ships no package.json, so
# install them where Node's resolver will find them: inside the skill itself.
if [ -d "${IMPECCABLE_DIR}" ] && [ ! -d "${IMPECCABLE_DIR}/node_modules/htmlparser2" ]; then
  echo "[skills] impeccable: installing detector parsers"
  if npm install --prefix "${IMPECCABLE_DIR}" --no-audit --no-fund --silent \
      htmlparser2 css-select css-tree domutils; then
    echo "[skills] impeccable: parsers ok"
  else
    echo "[skills] impeccable: parser install failed, detector runs degraded" >&2
  fi
fi

# Register the design hook in ~/.claude/settings.json so it applies to every
# project, not just this one. The skill's own installer only writes
# project-scoped settings and hardcodes a project-relative skill path, which
# does not exist for a -g install — hence registering it here instead.
# Merged rather than overwritten so unrelated global settings survive.
if [ -d "${IMPECCABLE_DIR}" ]; then
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.env.HOME, '.claude', 'settings.json');
const command = 'node "$HOME/.agents/skills/impeccable/scripts/hook.mjs"';

let settings = {};
if (fs.existsSync(file)) {
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    console.error('[skills] ~/.claude/settings.json is malformed, leaving it alone');
    process.exit(0);
  }
}

settings.hooks ??= {};
const already = (event) =>
  (settings.hooks[event] ?? []).some((entry) =>
    (entry.hooks ?? []).some((h) => (h.command ?? '').includes('impeccable')));

if (!already('PostToolUse')) {
  (settings.hooks.PostToolUse ??= []).push({
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command, timeout: 5, statusMessage: 'Checking UI changes' }],
  });
}
if (!already('Stop')) {
  (settings.hooks.Stop ??= []).push({
    hooks: [{ type: 'command', command, timeout: 30, statusMessage: 'Design deep pass' }],
  });
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log('[skills] impeccable: design hook registered globally');
NODE
fi
