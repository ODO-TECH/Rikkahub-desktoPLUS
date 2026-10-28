// im/qr.ts — 把绑定要扫的那串 URL 现场译成二维码图片(data URL)。
//
// 两个平台都只给"要编码的字符串"(QQ 的验证链接、微信 iLink 的 qrcode_img_content),图片得自己画。
// 放在服务端画:前端只 `<img src>`,不必为这一页往打包产物里塞一个二维码编码器;画失败的兜底也只有一处。

import { toDataURL } from "qrcode";

/** 220px 是手机扫码在 1 米距离下的下限再往上留一点;再大只是让设置页的图占满屏幕。 */
const QR_WIDTH = 220;

/** 失败返回 null 而不是抛出:链接照样给到界面(可复制),绑定流程不该被图片渲染掐断。 */
export async function renderQrDataUrl(text: string): Promise<string | null> {
  if (!text) return null;
  try {
    return await toDataURL(text, { margin: 1, width: QR_WIDTH });
  } catch (err) {
    console.warn("[im] 二维码生成失败:", err);
    return null;
  }
}
