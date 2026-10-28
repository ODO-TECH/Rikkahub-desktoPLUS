import { describe, expect, test } from "bun:test";

import {
  isRemotePathWithinRoot,
  lexicalNormalize,
  relativeToRemoteRoot,
  resolveInsideRoot,
  resolveRemoteWorkspaceCwd,
} from "./remote-path";

describe("远程授权根边界", () => {
  test("根为 / 时所有绝对路径都在边界内", () => {
    expect(isRemotePathWithinRoot("/", "/tmp")).toBe(true);
    expect(isRemotePathWithinRoot("/", "/home/user/file.txt")).toBe(true);
    expect(isRemotePathWithinRoot("/", "/")).toBe(true);
  });

  test("普通根只接受根自身与子树,不接受同前缀兄弟目录", () => {
    expect(isRemotePathWithinRoot("/srv/app", "/srv/app")).toBe(true);
    expect(isRemotePathWithinRoot("/srv/app", "/srv/app/file.txt")).toBe(true);
    expect(isRemotePathWithinRoot("/srv/app", "/srv/application/file.txt")).toBe(false);
    expect(isRemotePathWithinRoot("/srv/app", "/tmp/file.txt")).toBe(false);
  });

  test("根为 / 的相对路径切片不再多切一个字符", () => {
    expect(relativeToRemoteRoot("/", "/tmp/file.txt")).toBe("tmp/file.txt");
    expect(relativeToRemoteRoot("/", "/")).toBe("");
    expect(relativeToRemoteRoot("/srv/app", "/srv/app/file.txt")).toBe("file.txt");
    expect(relativeToRemoteRoot("/srv/app", "/srv/app")).toBe("");
  });
});

describe("远程 cwd 自愈", () => {
  test("根为 / 时绝对 cwd 与相对 cwd 都保留", () => {
    expect(resolveRemoteWorkspaceCwd("/", "/tmp")).toBe("/tmp");
    expect(resolveRemoteWorkspaceCwd("/", "tmp/work")).toBe("/tmp/work");
    expect(resolveRemoteWorkspaceCwd("/", "../etc")).toBe("/etc");
  });

  test("普通根内保留,越界与 Windows 残留 cwd 自愈回根", () => {
    expect(resolveRemoteWorkspaceCwd("/srv/app", "/srv/app/sub")).toBe("/srv/app/sub");
    expect(resolveRemoteWorkspaceCwd("/srv/app", "sub")).toBe("/srv/app/sub");
    expect(resolveRemoteWorkspaceCwd("/srv/app", "/tmp")).toBe("/srv/app");
    expect(resolveRemoteWorkspaceCwd("/srv/app", "C:\\Users\\me")).toBe("/srv/app");
  });
});

describe("resolveInsideRoot", () => {
  test("根为 / 时子路径可解析,.. 仍按词法夹取", () => {
    expect(resolveInsideRoot("/", "/tmp/file.txt")).toBe("/tmp/file.txt");
    expect(resolveInsideRoot("/", "../etc/hosts")).toBe("/etc/hosts");
    expect(resolveInsideRoot("/", "tmp/../etc/hosts")).toBe("/etc/hosts");
  });

  test("普通根拒绝越界并保留根内路径", () => {
    expect(resolveInsideRoot("/srv/app", "sub/file.txt")).toBe("/srv/app/sub/file.txt");
    expect(() => resolveInsideRoot("/srv/app", "../etc/passwd")).toThrow(/escapes workspace root/);
    // resolveInsideRoot 的参数语义是"根内相对子路径",前导 / 不表示绝对路径。
    expect(resolveInsideRoot("/srv/app", "/tmp/file.txt")).toBe("/srv/app/tmp/file.txt");
  });

  test("词法归一不改变原有远端路径语义", () => {
    expect(lexicalNormalize("/srv//app/./sub/../file")).toBe("/srv/app/file");
  });
});
