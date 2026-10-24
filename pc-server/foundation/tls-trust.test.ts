// foundation/tls-trust.test.ts — 只测分类器与重试决策:哪些失败值得用系统证书库重试。
// 真实的证书链问题在实机上验证(本机有 Steam++ 代签 github.com,见 0.0.5 的更新检查故障)。
import { describe, expect, test } from "bun:test";
import { fetchWithSystemRoots, isCertificateError } from "./tls-trust";

describe("isCertificateError", () => {
  test("Bun 的证书链错误(Steam++ / 企业代理代签的典型形态)", () => {
    expect(
      isCertificateError(
        Object.assign(new Error("unable to verify the first certificate"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        }),
      ),
    ).toBe(true);
  });

  test("自签证书 / 缺签发者", () => {
    expect(isCertificateError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "self-signed certificate" })).toBe(true);
    expect(isCertificateError(new Error("self-signed certificate in certificate chain"))).toBe(true);
    expect(isCertificateError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
    expect(isCertificateError({ code: "CERT_HAS_EXPIRED" })).toBe(true);
  });

  test("网络不可达 / 超时 / HTTP 状态不算证书问题", () => {
    expect(isCertificateError({ code: "ECONNREFUSED", message: "Unable to connect" })).toBe(false);
    expect(isCertificateError(new Error("The operation was aborted due to timeout"))).toBe(false);
    expect(isCertificateError(new Error("GitHub 403: API rate limit exceeded"))).toBe(false);
    expect(isCertificateError(new Error("No redirect from https://github.com/x (status 404)"))).toBe(false);
    expect(isCertificateError(undefined)).toBe(false);
    expect(isCertificateError("boom")).toBe(false);
  });
});

describe("fetchWithSystemRoots", () => {
  const certErr = () =>
    Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });

  test("请求成功时不重试、不附加 tls 选项", async () => {
    const seen: unknown[] = [];
    const res = await fetchWithSystemRoots(async (tls) => {
      seen.push(tls);
      return new Response("ok");
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([undefined]);
  });

  test("非证书错误原样抛出，不消耗一次重试", async () => {
    const seen: unknown[] = [];
    const boom = new Error("ECONNREFUSED");
    await expect(
      fetchWithSystemRoots(async (tls) => {
        seen.push(tls);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(seen.length).toBe(1);
  });

  test("证书错误时带系统根证书重试(Windows;其他平台拿不到系统库则原样抛出)", async () => {
    const seen: (unknown)[] = [];
    const attempt = async (tls?: { ca: string }) => {
      seen.push(tls);
      if (!tls) throw certErr();
      return new Response("ok");
    };
    if (process.platform === "win32") {
      const res = await fetchWithSystemRoots(attempt);
      expect(res.ok).toBe(true);
      expect(seen.length).toBe(2);
      expect(seen[1]).toMatchObject({ ca: expect.stringContaining("BEGIN CERTIFICATE") });
    } else {
      await expect(fetchWithSystemRoots(attempt)).rejects.toMatchObject({
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      expect(seen.length).toBe(1);
    }
  });
});
