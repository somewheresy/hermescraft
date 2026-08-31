#!/bin/sh
set -eu

actual_dir="${ACTUAL_SPARK_DIR:-$HOME/.actual}"

systemctl --user is-active --quiet actual-spark-cluster.service
status=$("$actual_dir/bin/actual" status --format json)
printf '%s\n' "$status" | grep -q '"daemon":{"state":"running"'
printf '%s\n' "$status"
