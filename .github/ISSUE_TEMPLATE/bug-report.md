---
name: Bug Report
about: 报告 RikkaHub PC 的 bug 或异常
title: ''
labels: bug
assignees: ''

---

## 问题描述 | Problem Description

在这里描述你的问题。
Describe your issue here.

## 复现步骤 | Steps to Reproduce

1.
2.
3.

## 截图 | Screenshot

在这里放置相关截图或录屏。
Attach relevant screenshots or screen recordings.

## 版本信息 | Version Information

- RikkaHub PC 版本 / Version: (例如 1.0.0)
- Windows 版本 / Windows Version: (例如 Windows 11 24H2)
- 模型供应商 / Provider: (OpenAI / Claude / Google / 其他兼容)
- 模型 / Model: (例如 gpt-5, claude-opus-4-6)

## 日志 | Logs

如果可能，打开 设置 → 请求日志，把相关错误条目贴在这里。
If possible, paste relevant entries from 设置 → 请求日志.

> 贴之前请自行脱敏：日志里的 `Authorization` 头已经过服务端脱敏，但请求体、截图和你的
> 自定义模型配置里可能仍有 API Key、WebDAV/S3 凭据或 SSH 主机信息。
> Please redact before posting — request bodies, screenshots and custom provider configs
> can still contain API keys, WebDAV/S3 credentials or SSH host details.

## 平台 | Platform

本分支只在 **Windows** 上开发与实测，Linux 走上游打包 / Docker。
**macOS 不在支持范围**（维护者没有 Mac 设备，无法编译、签名与验证）——mac 相关的问题
请当作「需社区共同验证」来看，见 README 与 docs/BUILD.md 的说明。
