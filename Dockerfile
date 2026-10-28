# syntax=docker/dockerfile:1

#  — Stage 1: Build —
# --platform=$BUILDPLATFORM ensures Bun runs natively (no QEMU emulation).
# Cross-compilation to TARGETARCH is handled via Bun's --target flag below.
FROM --platform=$BUILDPLATFORM docker.io/oven/bun:1.4.2 AS builder
ARG TARGETARCH

WORKDIR /build

# Install web-ui dependencies (cache layer)
COPY web-ui/package.json web-ui/bun.lock ./
RUN bun install

# Build web-ui SPA
COPY web-ui/ ./

# react-dom 19.2.4 的 server.bun.js 缺 renderToPipeableStream,用 node 入口覆盖它。
RUN cd node_modules/react-dom && cp server.node.js server.bun.js

# web-ui 的 @server/* 路径别名解析到 ../pc-server(见 web-ui/tsconfig.json paths):
# tsc 用它做类型对齐,Rollup 经 vite-tsconfig-paths 也按它解析【值导入】(如
# @server/tools/ask-user)。web-ui 必须与 pc-server 源码平铺为兄弟目录才能构建——
# 此前 pc-server 只在下面才 COPY,vite 一遇到值导入就 Rollup failed to resolve。
# node_modules 排除:web-ui 的 bun install 装在 /build/node_modules,绝不能被这次
# COPY 覆盖成宿主目录里的 Windows 依赖(布局:/build/node_modules 在,COPY pc-server
# 只会新增 pc-server/ 子目录)。
COPY pc-server/ ../build/pc-server/
RUN bun run build

# pi/ 是 gitignore 的本地浅克隆(vendored 源码),不进构建上下文。pc-server 直接
# import 其 TS 源码,缺它 bun build --compile 第一步解析 import 即失败。
# 按 docs/BUILD.md「还原 pi vendor」重建:浅克隆上游基线 + 应用 pi-patches/*.patch。
# --no-install-recommends 防止 bookworm-slim 带 ca-certificates 缺失导致 https clone 失败。
# 装 pi 自己的依赖(proper-lockfile/typebox/openai 等,bun build 会把它们一并打包)。
#
# 模型数据走 pi-model-data/ 快照(host 仓库 tracked,与 Dockerfile 的 pi pin 配对),
# 不跑 generate-models:上游生成器是破坏性的(先删全部 *.models.ts 分片再按
# models.dev 【当天】状态重建)——第三方数据漂移(实测 2026-09:kimi-for-coding 被
# models.dev 摘除)会让 tracked 分片被删后无人重建,或聚合器引用的 data/*.json
# 缺失,bun build 解析 import 即失败:每次构建都在赌 models.dev 的实时状态。
# 快照 = 本地 pi/(pin 基线 + 补丁)生成的 data/ 原样拷贝,与 39 个 tracked 分片
# 严格配对,构建从此可复现。pi 升级换基线时:本地 pi 重跑 bun run generate-models
# (它产出与新版分片配对的 data/),再刷新本目录快照(升级流程第 2 步刷新 patches
# 的同款时机)。
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pi-patches/ ./pi-patches/
COPY pi-model-data/ ./pi-model-data/
RUN git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi && \
    cd pi && \
    git checkout d981de1229ef899957bbe968bc8dcda02a21f477 && \
    git reset --hard && \
    git apply ../pi-patches/*.patch && \
    bun install && \
    mkdir -p packages/ai/src/providers/data && \
    cp ../pi-model-data/*.json ../pi-model-data/.manifest.json packages/ai/src/providers/data/

# Compile server — cross-compile to match the runtime platform.
# Lay out a separate /build/pc-server subtree so we don't mix the pc-server lockfile
# with the web-ui one above. We need `bun install` here for one reason only: server.ts
# does `import wasm with { type: "file" }` from ./node_modules/mupdf/dist/mupdf-wasm.wasm,
# and the wasm asset has to actually exist on disk so bun --compile can bundle it into the
# final exe. After install the wasm is at /build/pc-server/node_modules/mupdf/dist/...
WORKDIR /build/pc-server
COPY pc-server/package.json pc-server/bun.lock ./
RUN bun install
# 重构后 server.ts 依赖 pc-server 下数十个本地模块(收官审查 P0-3:只 COPY server.ts
# 会让 bun build 解析 import 直接失败)。整目录复制;node_modules 由上面的 bun install
# 在镜像内重建(.dockerignore 排除宿主 node_modules,避免 Windows 依赖覆盖 Linux 依赖)。
COPY pc-server/ ./
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) BUN_TARGET=bun-linux-x64 ;; \
      arm64) BUN_TARGET=bun-linux-arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH"; exit 1 ;; \
    esac; \
    bun build --compile --target="$BUN_TARGET" server.ts --outfile rikkahub-pc

#  — Stage 2: Runtime —
# 为什么不再是 distroless(Docker 侧 Linux 适配的核心):
#   - agent 的 bash 工具在 Unix 上按 /bin/bash → PATH 上的 bash → sh 解析
#     (workspace/tools/shell.ts),全缺就整项停用;distroless 没有任何 shell。
#   - 备份导出与非 Windows 的 ZIP 导入必须 spawn `zip` / `unzip`(backup/zip.ts、
#     api/handlers/data.ts 的 unzip 分支)。旧写法把它们连同 ldd 依赖放到 /tools,
#     却既不设 PATH 也不设 LD_LIBRARY_PATH —— 效果等于没装。
#   - fc-list 是 assets/fonts.ts 在 Linux 上枚举系统字体的入口;缺失只会静默回退到
#     Windows 字体兜底清单(容器里根本不存在),PDF 导出可选项因此不对。
# bookworm-slim 与构建阶段同为 Debian 12,glibc 与编译目标一致。
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils grep sed gawk findutils procps passwd \
      zip unzip curl ca-certificates tzdata fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/pc-server/rikkahub-pc ./
COPY --from=builder /build/build/client/ ./web-ui/build/client/
# 8-5:品牌图标与内置字体随镜像分发(Tauri 形态经 bundle resources 携带,Docker 需显式拷)
COPY icons/ ./icons/
COPY fonts/ ./fonts/

# 把内置字体注册给 fontconfig:只加目录配置、不复制文件,字体仍留在 /app/fonts,
# 镜像不重复占空间。此后 fc-list 能看到 HarmonyOS Sans / Noto Serif SC 等内置字体。
RUN printf '%s\n' \
      '<?xml version="1.0"?>' \
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
      '<fontconfig><dir>/app/fonts</dir></fontconfig>' \
      > /etc/fonts/conf.d/99-rikkahub.conf \
    && fc-cache -f >/dev/null

# —— 运行身份：非 root ——
# 容器内的 root 并不会让 agent 看见更多宿主路径（可见范围完全由挂载表决定），但会放大
# 两件事：挂进来的宿主目录里它能把文件 chown 成 root（回到宿主你就改不回来了），以及
# 任何提权链路的起点都是 uid 0。这里固定 uid/gid 1000；需要别的 uid 时用 compose 的
# user: 覆盖，并同步 chown 宿主上的 ./pc-data。
RUN groupadd -g 1000 rikkahub \
    && useradd -u 1000 -g 1000 -M -d /app/pc-data/home -s /usr/sbin/nologin rikkahub \
    && mkdir -p /app/pc-data/home /app/pc-data/tmp \
    && chown -R 1000:1000 /app/pc-data

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

# HOME 落在数据卷内而非 /root：agent 的 ~ 展开与工具缓存需要可写目录。
# 数据卷是 bind mount 时镜像里的 home 目录会被宿主目录遮住，入口脚本会补建。
ENV HOME=/app/pc-data/home

USER 1000:1000

VOLUME ["/app/pc-data"]
# 容器内端口钉在 11451(镜像契约:EXPOSE / compose 的 11451:11451 映射 / 文档反代示例)。
# 需求里的 114514 超出 TCP 端口上限 65535,内核与 docker -p 都会拒绝,故取有效前缀 11451。
# Podman 放的是 /run/.containerenv 而非 /.dockerenv,服务端容器检测在 Podman 下不成立,
# 会把这类实例误判成桌面形态换用冷门默认端口——ENV PORT 与检测构成双保险。优先级:
# --port > -e PORT > 本值,用户显式覆盖仍然生效(改端口时 HEALTHCHECK 会跟着 PORT 走)。
#
# RIKKAHUB_ANALYTICS=0:镜像是本分支的编译产物,默认会向**上游**统计端点上报匿名
# 启动计数;分支不维护那个看板,也不该把本地部署记到上游账上。需要时显式设 1。
# RIKKAHUB_CONTAINER=1:除 /.dockerenv 外的容器检测兜底(Podman 放 /run/.containerenv),
# 保证监听 0.0.0.0、端口不受界面设置影响、原地更新与 origin 接力保持关闭。
# HOME 已固定为 /app/pc-data/home（见上方 USER 段）。用 compose 的 user: 覆盖成其他
# uid 时，需自行把 HOME 指到该用户可写的目录，否则 agent 的 ~ 展开会落到不可写处。
ENV PORT=11451 \
    RIKKAHUB_ANALYTICS=0 \
    RIKKAHUB_CONTAINER=1

EXPOSE 11451

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh", "./rikkahub-pc", "--no-open"]
