-- 迁移 0003:分钟级使用时长(专题6)。hb 的 10 分钟格子对日均 ~10 分钟的真实用量
-- 量化误差可达 100%;新客户端按活跃秒数累计,上报当日活跃分钟数 am,dashboard
-- 优先采用、老客户端回退 hb×10。
-- 只对"已存在旧结构 pings 表"的线上库执行一次:
--   npx wrangler d1 execute <DB_NAME> --remote --file=functions/_sql/0003_active_minutes.sql
-- SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS,重复执行会报 duplicate column,属预期。
-- 部署顺序:先执行本迁移,再部署新版 functions(ping.ts 写新列,列不存在会 500)。
ALTER TABLE pings ADD COLUMN active_minutes INTEGER NOT NULL DEFAULT 0;
