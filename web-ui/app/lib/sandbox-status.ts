// app/lib/sandbox-status.ts — 系统沙盒状态（声明档位 + 实测结论）
//
// 数据来自后端 GET /api/app/sandbox（pc-server/workspace/sandbox.ts）。
// 用途：把"操作系统层面的边界到底有没有生效"摆到界面上——权限档位是应用层的
// 审批策略，边界生效时越界写入会被内核/挂载表直接拒绝，两者不是一回事。

import api from "~/services/api";

export interface SandboxStatusDto {
  /** 部署声明的档位 */
  tier: "off" | "restricted" | "full";
  /** 实测结论 */
  measured: "enforced" | "not_enforced" | "unknown";
  /** 实测边界是否生效 */
  boundaryActive: boolean;
  /** 区内（数据目录）是否可写 */
  insideWritable: boolean;
  probePath: string;
  probeError: string;
  mechanism: "windows_integrity" | "container_mounts" | "none";
  rwMounts: string[];
  notes: string[];
  checkedAt: number;
}

let cached: SandboxStatusDto | null = null;
let inFlight: Promise<SandboxStatusDto | null> | null = null;

/** 拉取沙盒状态（进程内缓存，避免每次展开下拉都打一次后端）。
 *  拉取失败返回 null——界面退回"未知"，不阻塞权限档位本身的切换；失败不写缓存，
 *  下次展开会重试。 */
export function loadSandboxStatus(force = false): Promise<SandboxStatusDto | null> {
  if (force) cached = null;
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = api
    .get<SandboxStatusDto>("app/sandbox")
    .then((value) => {
      cached = value;
      return value;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
