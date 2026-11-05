#!/bin/sh
# Links this repo's Claude Code skills into ~/.claude/skills (or $CLAUDE_SKILLS_DIR), so Claude Code finds them from
# any project. A link, not a copy: editing a skill here changes it everywhere. Run it again after adding a skill.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest=${CLAUDE_SKILLS_DIR:-"$HOME/.claude/skills"}
mkdir -p "$dest"

for file in "$repo"/skills/*/SKILL.md; do
  [ -e "$file" ] || continue
  skill=$(dirname "$file")
  name=$(basename "$skill")
  ln -sfn "$skill" "$dest/$name"
  printf 'linked %s -> %s/%s\n' "$skill" "$dest" "$name"
done
