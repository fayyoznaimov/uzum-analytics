#!/usr/bin/env bash
# Ставит self-hosted runner GitHub Actions для мгновенного деплоя
# (.github/workflows/deploy.yml). Без root: всё в ~/actions-runner, автозапуск
# через systemd --user (linger у пользователя включён).
#
# Токен регистрации: GitHub → репозиторий → Settings → Actions → Runners →
# New self-hosted runner → Linux, строка ./config.sh ... --token <ТОКЕН>.
# Токен одноразовый и живёт час.
#
#   bash ~/uzum/scripts/install-github-runner.sh <ТОКЕН>
#
# Повторный запуск с новым токеном перерегистрирует runner.

set -euo pipefail

TOKEN="${1:?Передайте токен регистрации runner первым аргументом}"
REPO_URL="https://github.com/fayyoznaimov/uzum-analytics"
DIR="$HOME/actions-runner"
APP="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -x ./config.sh ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | python3 -c 'import sys, json; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"
  echo "Скачиваю runner $VERSION"
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz"
  tar xzf runner.tar.gz
  rm runner.tar.gz
fi

systemctl --user stop github-runner.service 2>/dev/null || true
if [ -f .runner ]; then ./config.sh remove --token "$TOKEN" || true; fi

./config.sh --unattended --replace \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "ParisaUbuntu" \
  --labels "uzum-server" \
  --work "_work"

mkdir -p "$HOME/.config/systemd/user"
cp "$APP/deploy/systemd/github-runner.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now github-runner.service

sleep 5
systemctl --user is-active github-runner.service
echo "Готово: runner ParisaUbuntu (метка uzum-server) подключён к $REPO_URL"
