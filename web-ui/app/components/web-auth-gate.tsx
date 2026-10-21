import * as React from "react";
import { useTranslation } from "react-i18next";

import { extractErrorMessage } from "~/lib/error";
import { onWebAuthRequired, requestWebAuthToken } from "~/services/api";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";

export function WebAuthGate() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // R6-3:401 事件按请求数分发不去重。弹窗已开时(用户可能正在输密码),后台请求再触发
  // 的 401 只需保持弹窗,不得重置字段——否则正在输入的密码被当场清空。
  const openRef = React.useRef(false);
  openRef.current = open;
  React.useEffect(() => {
    return onWebAuthRequired(() => {
      if (openRef.current) return;
      setOpen(true);
      setSubmitting(false);
      setError(null);
      setPassword("");
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (password.length === 0) {
        setError(t("web_auth_gate.password_required"));
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await requestWebAuthToken(password);
        setOpen(false);
        window.location.reload();
      } catch (submitError) {
        setError(extractErrorMessage(submitError, t("web_auth_gate.unlock_failed")));
      } finally {
        setSubmitting(false);
      }
    },
    [password, t],
  );

  if (!open) return null;

  return (
    // 不透明背景(此前 bg-black/45 半透明):settings/会话列表本地镜像落地后,未认证
    // 首帧背后可能已画出上次会话标题/昵称,半透明遮罩会把它们透给未解锁的访客。
    // 登录墙用实心背景是标准做法,同时消除"内容隐约可见"的廉价感。
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("web_auth_gate.title")}</CardTitle>
          <CardDescription>{t("web_auth_gate.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onSubmit}>
            <Input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("web_auth_gate.password_placeholder")}
              autoComplete="current-password"
              disabled={submitting}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? t("web_auth_gate.unlocking") : t("web_auth_gate.unlock")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
