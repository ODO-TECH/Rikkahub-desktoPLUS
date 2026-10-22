// 深链路径换算的纯函数测试(0.0.3 Feature A)。
// 工具卡里是模型给出的原始 path(相对会话 cwd),侧栏文件树用工作区相对路径;
// 这段换算错了就会 404 或打开工作区外的文件,因此单独盯住边界与盘符大小写。
import { describe, expect, test } from "bun:test";

import {
  fileIdFromUrl,
  normalizeAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRawFileUrl,
} from "./conversation-files-types";

describe("normalizeAbsolutePath", () => {
  test("折叠 . / .. 与重复斜杠,反斜杠转正斜杠", () => {
    expect(normalizeAbsolutePath("C:\\ws\\sub\\..\\a\\..\\b.ts")).toBe("C:/ws/b.ts");
    expect(normalizeAbsolutePath("C:/ws//sub/./x.ts")).toBe("C:/ws/sub/x.ts");
  });

  test("盘符统一大写,内容大小写保留", () => {
    expect(normalizeAbsolutePath("d:/Work/A.ts")).toBe("D:/Work/A.ts");
  });

  test("UNC 与根路径不丢前导斜杠", () => {
    expect(normalizeAbsolutePath("/root/a/../b")).toBe("/root/b");
  });
});

describe("resolveWorkspaceFilePath", () => {
  test("相对路径按会话 cwd 折算(与 changes.path 同口径)", () => {
    expect(resolveWorkspaceFilePath("a.ts", "/ws/sub", "/ws")).toBe("sub/a.ts");
  });

  test("cwd 为空时按工作区根解析", () => {
    expect(resolveWorkspaceFilePath("src/a.ts", "", "/ws")).toBe("src/a.ts");
    expect(resolveWorkspaceFilePath("src/a.ts", null, "/ws")).toBe("src/a.ts");
  });

  test("绝对路径在工作区内也能折算,盘符/前缀大小写不敏感", () => {
    expect(resolveWorkspaceFilePath("D:\\WS\\src\\a.ts", "C:\\elsewhere", "d:\\ws")).toBe("src/a.ts");
  });

  test("工作区根自身返回空串(打开根目录无意义,但不算越界)", () => {
    expect(resolveWorkspaceFilePath("..", "/ws/sub", "/ws")).toBe("");
  });

  test("越界与缺工作区返回 null", () => {
    expect(resolveWorkspaceFilePath("../../outside.ts", "/ws/sub", "/ws")).toBeNull();
    expect(resolveWorkspaceFilePath("C:\\other\\a.ts", "/ws/sub", "/ws")).toBeNull();
    expect(resolveWorkspaceFilePath("a.ts", "/ws/sub", null)).toBeNull();
    expect(resolveWorkspaceFilePath("a.ts", "/ws/sub", "")).toBeNull();
    expect(resolveWorkspaceFilePath("   ", "/ws/sub", "/ws")).toBeNull();
  });

  test("导入数据里的相对 cwd 按工作区根补全", () => {
    expect(resolveWorkspaceFilePath("a.ts", "sub", "C:\\ws")).toBe("sub/a.ts");
  });
});

describe("fileIdFromUrl", () => {
  test("识别 /api/files/<id>/content", () => {
    expect(fileIdFromUrl("/api/files/42/content")).toBe(42);
    expect(fileIdFromUrl("/api/files/42/content?x=1#frag")).toBe(42);
  });

  test("非库内文件 URL 返回 null", () => {
    expect(fileIdFromUrl("https://example.com/a.png")).toBeNull();
    expect(fileIdFromUrl("/api/workspaces/w1/files/raw?path=a.pdf")).toBeNull();
  });
});

describe("workspaceRawFileUrl", () => {
  test("路径与 id 都做 URL 编码", () => {
    expect(workspaceRawFileUrl("w 1", "docs/a b.pdf")).toBe(
      "/api/workspaces/w%201/files/raw?path=docs%2Fa%20b.pdf",
    );
  });
});
