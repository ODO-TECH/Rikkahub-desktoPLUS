// api/handlers/errors.ts — 应用错误通道路由(P2-1 批2):errors/recent、errors/clear(推送走 /api/events)。
// 纪律:只做通道数据的出入口;错误的产生与合并语义在 observability/app-errors.ts。

import { clearAppErrors, recentAppErrors } from "../../observability/app-errors";
import { json } from "../request";

// 错误快照/增量已并入 /api/events 通道(app_errors_snapshot / app_error 事件)。
export async function handleErrorRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "errors/recent" && request.method === "GET") {
    return json({ errors: recentAppErrors() });
  }
  if (path === "errors/clear" && request.method === "POST") {
    clearAppErrors();
    return json({ status: "ok" });
  }
  return null;
}
