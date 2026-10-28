#!/bin/sh
# 容器入口：写权限预检 + HOME 准备，然后把控制权交给后端。
#
# 存在的理由：镜像以非 root（uid 1000）运行时，最常见的启动失败是宿主 ./pc-data
# 仍是旧版本 root 建的目录——后端只会抛一个难读的 EACCES，用户在日志里看不出
# "去 chown" 这个动作。这里先探一次可写性，失败时直接打印可以照抄的命令。
set -u

DATA_DIR="${RIKKAHUB_PC_DATA_DIR:-/app/pc-data}"

if ! { mkdir -p "$DATA_DIR" && : > "$DATA_DIR/.write-probe"; } 2>/dev/null; then
  printf 'rikkahub: 数据目录不可写：%s（容器内身份 uid=%s gid=%s）\n' \
    "$DATA_DIR" "$(id -u)" "$(id -g)" >&2
  printf 'rikkahub: 这是升级到非 root 镜像后的常见问题，在宿主上执行：\n' >&2
  printf 'rikkahub:   sudo chown -R %s:%s ./pc-data\n' "$(id -u)" "$(id -g)" >&2
  printf 'rikkahub: 然后 docker compose up -d（详见 docs/DOCKER.md §7）\n' >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-probe"

# HOME 指向数据卷内：agent 的 ~ 展开、各类工具缓存需要可写，且容器重启后仍然存在。
# 卷是 bind mount 时镜像里预建的目录会被宿主目录覆盖，所以这里补建一次。
if [ -n "${HOME:-}" ] && [ ! -d "$HOME" ]; then
  mkdir -p "$HOME" 2>/dev/null || true
fi

exec "$@"
