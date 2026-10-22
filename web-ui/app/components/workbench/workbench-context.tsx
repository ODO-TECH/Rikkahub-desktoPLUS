import * as React from "react";

export interface WorkbenchPanel {
  type: string;
  title: string;
  payload: Record<string, unknown>;
}

interface WorkbenchContextValue {
  panel: WorkbenchPanel | null;
  openPanel: (panel: WorkbenchPanel) => void;
  /** force=true 跳过面板注册的关闭守卫(守卫自身确认后才该这么调)。 */
  closePanel: (force?: boolean) => void;
  /** 面板注册"能否关闭"守卫(有未保存草稿时返回 false 并自行弹确认)。
   *  传入 null 解除注册;面板卸载时自动清理。 */
  setCloseGuard: (guard: (() => boolean) | null) => void;
}

const WorkbenchContext = React.createContext<WorkbenchContextValue | null>(null);

export function useWorkbenchController(): WorkbenchContextValue {
  const [panel, setPanel] = React.useState<WorkbenchPanel | null>(null);
  const closeGuardRef = React.useRef<(() => boolean) | null>(null);

  const openPanel = React.useCallback((nextPanel: WorkbenchPanel) => {
    setPanel(nextPanel);
  }, []);

  const closePanel = React.useCallback((force = false) => {
    if (!force && closeGuardRef.current && !closeGuardRef.current()) return;
    closeGuardRef.current = null;
    setPanel(null);
  }, []);

  const setCloseGuard = React.useCallback((guard: (() => boolean) | null) => {
    closeGuardRef.current = guard;
  }, []);

  return React.useMemo(
    () => ({
      panel,
      openPanel,
      closePanel,
      setCloseGuard,
    }),
    [closePanel, openPanel, panel, setCloseGuard],
  );
}

export function WorkbenchProvider({
  value,
  children,
}: {
  value: WorkbenchContextValue;
  children: React.ReactNode;
}) {
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): WorkbenchContextValue {
  const context = React.useContext(WorkbenchContext);
  if (!context) {
    throw new Error("useWorkbench must be used inside WorkbenchProvider");
  }
  return context;
}

export function useOptionalWorkbench(): WorkbenchContextValue | null {
  return React.useContext(WorkbenchContext);
}
