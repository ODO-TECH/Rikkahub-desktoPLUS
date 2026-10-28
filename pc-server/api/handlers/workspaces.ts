// api/handlers/workspaces.ts — 工作区路由(agent 模式,§5.4)
// CRUD + 信任门确认。工具执行/文件面板路由随 M1-4/M3 加入。
//
// ssh 型工作区在本路由组里只做"绑定"(建/改/删/列),文件面一律走 ssh/files*:它的 root
// 是远端 POSIX 路径,本机 stat 不到,让它进 workspaces/:id/files* 只会得到"目录不存在"
// 这种把两台机器混为一谈的误导报错。两处路由都以 errorCode 明确拒绝,界面按码给文案。

import type { Workspace } from "../../foundation/types";
import type { WorkspaceDto } from "../../foundation/types/dto";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, trustWorkspace, updateWorkspace, workspaceStatus } from "../../workspace";
import { deleteWorkspaceEntry, listWorkspaceDir, previewWorkspaceFile, readWorkspaceAgentsFile, readWorkspaceFileForEdit, renameWorkspaceEntry, resolveWorkspacePdf, revealWorkspaceEntry, WorkspaceFileConflictError, writeWorkspaceAgentsFile, writeWorkspaceTextFile } from "../../workspace/files";
import { mountedWorkspaceToolNames, refreshShellAvailability, shellAvailability } from "../../workspace/runtime";
import { resolveSshBinding } from "../../ssh/workspace-binding";
import { SshInputError } from "../../ssh/errors";
import { error, json, readJson } from "../request";

export function shellStatusPayload(): { available: boolean; error: string | null; mountedTools: string[] } {
  const shell = shellAvailability();
  return { available: shell.available, error: shell.error ?? null, mountedTools: [...mountedWorkspaceToolNames()] };
}

function toDto(workspace: Workspace): WorkspaceDto {
  // 绑定解析是纯配置层(无网络),列表页每行都算得起;sshTarget/unavailableReason 让界面
  // 能解释"状态看着正常却一个工具都没有"——工作区可用性与远端连通性是两件事。
  const binding = workspace.type === "ssh" ? resolveSshBinding(workspace.sshDeviceId, workspace.sshDirId) : null;
  return {
    ...workspace,
    status: workspaceStatus(workspace),
    sshTarget: binding?.target?.label ?? null,
    unavailableReason: binding?.reason ?? null,
    unavailableErrorCode: binding?.errorCode ?? null,
  };
}

/** 领域层错误 → HTTP:带码的输入错误(SshInputError)把 errorCode 一并回给界面按
 *  errors.<code> 查文案,message 是英文兜底——与 ssh/* 路由同一套分工(ssh/errors.ts 头注)。 */
function workspaceError(err: unknown, fallback: string): Response {
  if (err instanceof SshInputError) return error(err.message, 400, err.errorCode);
  return error(err instanceof Error ? err.message : fallback, 400);
}

export async function handleWorkspaceRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "workspaces" && request.method === "GET") {
    return json({ workspaces: listWorkspaces().map(toDto) });
  }

  if (path === "workspaces" && request.method === "POST") {
    const body = await readJson<{ type?: string; name?: string; root?: string; sshDeviceId?: string; sshDirId?: string }>(request);
    const type = String(body.type ?? "");
    if (type !== "managed" && type !== "folder" && type !== "ssh") return error("type must be managed, folder or ssh", 400);
    try {
      return json({
        workspace: toDto(createWorkspace({
          type,
          name: body.name,
          root: body.root,
          sshDeviceId: body.sshDeviceId,
          sshDirId: body.sshDirId,
        })),
      });
    } catch (err) {
      return workspaceError(err, "创建工作区失败");
    }
  }

  // ---- shell 探测状态(K3):bash 不可用时前端引导安装 Git;装完后可触发重探 ----
  // 注意置于 :id 正则之前,否则 shell-status 会被吞成工作区 id。
  if (path === "workspaces/shell-status" && request.method === "GET") {
    return json({ shell: shellStatusPayload() });
  }
  if (path === "workspaces/shell-status/refresh" && request.method === "POST") {
    refreshShellAvailability();
    return json({ shell: shellStatusPayload() });
  }

  const workspaceRoute = path.match(/^workspaces\/([^/]+)(?:\/(.*))?$/);
  if (!workspaceRoute) return null;
  const workspaceId = decodeURIComponent(workspaceRoute[1]);
  const sub = workspaceRoute[2] ?? "";

  if (!sub && request.method === "GET") {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    return json({ workspace: toDto(workspace) });
  }

  if (!sub && request.method === "PATCH") {
    // B6-①b:root 仅 folder 型可重绑(校验+信任门重置在领域层),managed 型传 root 会抛错。
    // ssh 型换绑走 sshDeviceId/sshDirId(1:1 与可用性校验在领域层),信任门不重置——理由见
    // workspace/index.ts 的 updateWorkspace。
    const body = await readJson<{ name?: string; permissionPreset?: string; root?: string; sshDeviceId?: string; sshDirId?: string }>(request);
    try {
      const updated = updateWorkspace(workspaceId, body);
      if (!updated) return error("Workspace not found", 404);
      return json({ workspace: toDto(updated) });
    } catch (err) {
      return workspaceError(err, "更新工作区失败");
    }
  }

  // ---- 文件面板路由(M3-5,§4.4):path 参数为相对 root 的路径,边界断言在领域层 ----
  if (sub === "files" || sub.startsWith("files/")) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    // ssh 型的 root 在远端,本机 fs 一律不可达(见文件头):按码拒绝,界面引到 SSH 文件面板。
    if (workspace.type === "ssh") {
      return error("Remote workspaces are browsed through the SSH file routes", 400, "ssh.use_remote_file_routes");
    }
    const relPath = _url.searchParams.get("path") ?? "";
    try {
      if (sub === "files" && request.method === "GET") {
        return json({ entries: listWorkspaceDir(workspace, relPath) });
      }
      if (sub === "files/content" && request.method === "GET") {
        // mode=edit(0.0.3 侧边栏):2MB 内整读 + etag/EOL/BOM,供编辑器保存时比对。
        if (_url.searchParams.get("mode") === "edit") {
          return json(await readWorkspaceFileForEdit(workspace, relPath));
        }
        return json({ preview: await previewWorkspaceFile(workspace, relPath) });
      }
      if (sub === "files/raw" && request.method === "GET") {
        // 仅 PDF(领域层拒绝其它类型):iframe 内嵌需要 inline 的 application/pdf。
        const fsPath = resolveWorkspacePdf(workspace, relPath);
        return new Response(Bun.file(fsPath), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "inline",
            "Cache-Control": "no-store",
          },
        });
      }
      if (sub === "files/content" && request.method === "PUT") {
        const body = await readJson<{ content?: string; baseEtag?: string | null; eol?: string | null }>(request);
        if (typeof body.content !== "string") return error("content is required", 400);
        try {
          return json(writeWorkspaceTextFile(workspace, relPath, {
            content: body.content,
            baseEtag: typeof body.baseEtag === "string" ? body.baseEtag : null,
            eol: body.eol === "\r\n" ? "\r\n" : body.eol === "\n" ? "\n" : null,
          }));
        } catch (err) {
          if (err instanceof WorkspaceFileConflictError) {
            return json({ error: "conflict", code: 409, etag: err.etag, modifiedAt: err.modifiedAt }, { status: 409 });
          }
          throw err;
        }
      }
      if (sub === "files/rename" && request.method === "POST") {
        const body = await readJson<{ path?: string; newName?: string }>(request);
        renameWorkspaceEntry(workspace, String(body.path ?? ""), String(body.newName ?? ""));
        return new Response(null, { status: 204 });
      }
      if (sub === "files" && request.method === "DELETE") {
        deleteWorkspaceEntry(workspace, relPath);
        return new Response(null, { status: 204 });
      }
      if (sub === "files/reveal" && request.method === "POST") {
        const body = await readJson<{ path?: string }>(request);
        revealWorkspaceEntry(workspace, String(body.path ?? ""));
        return new Response(null, { status: 204 });
      }
      return null;
    } catch (err) {
      return error(err instanceof Error ? err.message : "文件操作失败", 400);
    }
  }

  // ---- AGENTS.md 编辑入口(P4,§3.3):读写 pi 实际加载的项目上下文文件 ----
  if (sub === "agents-file") {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    // 与安卓一致:远程工作区不加载项目 AGENTS.md(引擎侧 includeProjectAgentsFiles=false),
    // 所以这里不是"写到远端"而是"这个概念在 ssh 工作区不存在"——写一份模型永远不读的文件
    // 只会让用户以为改了远端的行为。
    if (workspace.type === "ssh") {
      return error("SSH workspaces do not load a project AGENTS.md", 400, "ssh.agents_file_unsupported");
    }
    try {
      if (request.method === "GET") {
        return json({ agentsFile: readWorkspaceAgentsFile(workspace) });
      }
      if (request.method === "PUT") {
        const body = await readJson<{ content?: string }>(request);
        return json({ agentsFile: writeWorkspaceAgentsFile(workspace, String(body.content ?? "")) });
      }
      return null;
    } catch (err) {
      return error(err instanceof Error ? err.message : "AGENTS.md 操作失败", 400);
    }
  }

  if (sub === "trust" && request.method === "POST") {
    const trusted = trustWorkspace(workspaceId);
    if (!trusted) return error("Workspace not found", 404);
    return json({ workspace: toDto(trusted) });
  }

  if (!sub && request.method === "DELETE") {
    if (!deleteWorkspace(workspaceId)) return error("Workspace not found", 404);
    return new Response(null, { status: 204 });
  }

  return null;
}
