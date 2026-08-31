#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
    printf '%s\n' 'run this installer as the Spark login user, not root' >&2
    exit 1
fi

if [ "$(loginctl show-user "$USER" -p Linger --value)" != yes ]; then
    printf '%s\n' 'systemd user lingering must be enabled for boot supervision' >&2
    exit 1
fi

source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
actual_dir="$HOME/.actual"
unit_dir="$HOME/.config/systemd/user"
backup_dir="$actual_dir/service-backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0755 "$backup_dir" "$unit_dir"

for existing in \
    "$unit_dir/actual-daemon.service" \
    "$unit_dir/actual-spark-cluster.service" \
    "$actual_dir/bin/start-spark-cluster" \
    "$actual_dir/bin/run-actual-spark-cluster"
do
    if [ -e "$existing" ]; then
        cp -p "$existing" "$backup_dir/"
    fi
done

install -m 0755 "$source_dir/run-actual-spark-cluster" \
    "$actual_dir/bin/run-actual-spark-cluster"
install -m 0644 "$source_dir/actual-spark-cluster.service" \
    "$unit_dir/actual-spark-cluster.service"

systemctl --user disable --now actual-daemon.service >/dev/null 2>&1 || true
"$actual_dir/bin/actual" stop >/dev/null 2>&1 || true

cron_file=$(mktemp)
trap 'unlink "$cron_file" 2>/dev/null || true' EXIT
crontab -l 2>/dev/null | sed '\|/\.actual/bin/start-spark-cluster|d' > "$cron_file"
crontab "$cron_file"

systemctl --user daemon-reload
systemctl --user enable --now actual-spark-cluster.service
