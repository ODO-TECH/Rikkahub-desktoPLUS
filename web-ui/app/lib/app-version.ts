// app/lib/app-version.ts — 界面侧版本号（随 web-ui 一起构建）
//
// 与 pc-server/updates/index.ts 的 APP_VERSION 同值，但两者是**不同的进程/工件版本**：
// 前端静态文件每次请求从磁盘重读（改完 build 立即生效），后端进程却要重启才换代码。
// 后端比前端旧时，update/check 只按后端版本比较会把"工件已是新版"的用户反复提示更新。
// 因此界面把自己的版本带给后端，由后端取两者较高者作为「当前版本」。
// 唯一改写入口 pc-server/scripts/bump-version.ts；CI 的 check-version-sync.ts 校验同值。
export const APP_VERSION = "0.1.3";
