// 设置模态打开时的「顶带替身」:一条常驻挂载的 fixed 层。设置模态的本体遮罩
// (Radix Overlay,z-50)覆盖整屏,真实顶带 chrome 由 app.css 的
// body:has([data-settings-overlay]) 规则隐去;本替身在更高层复刻一遍
// [-口×](走共享的 WindowControlsBar,与真实顶带逐字同源),保持清晰、可点。
// 品牌行不复刻:设置模态左上角不显示 Logo/品牌名。
//
// 替身要自带高 z-index(z-[90]),否则窗控会被模态遮罩盖住而不可点。
//
// 为什么替身自身要 invisible(而非靠 pointer-events 剪裁到子元素):模态打开时 Radix
// 给 body 挂 pointer-events:none(连同后代继承)。替身壳自身保持 pointer-events:none
// (命中对整层透明、不挡视口点击),只把「拖拽区 + 按钮」点亮可见——拖拽区是 div
// (非交互选择器覆盖对象),它的拖拽靠 mousedown 自己收,借替身壳豁免遮罩即可。
// 见 app.css 的 [data-titlebar-overlay] 规则组。
import { WindowControlsBar, titlebarOverlayDragRegionProps } from "~/components/window-controls";
import { useSettingsDialogStore } from "~/stores/settings-dialog-store";

export function TitleBarOverlay() {
  const open = useSettingsDialogStore((state) => state.open);
  if (!open) return null;

  return (
    <div
      data-titlebar-overlay=""
      className="pointer-events-none invisible fixed inset-x-0 top-0 h-[var(--app-band-h)] z-[90]"
    >
      {/* 两页同源坐标与主界面顶带逐字对齐(conversations.tsx):外层 items-start,
          窗控 ml-auto mt-1.5 mr-2(右 8px)。替身与真实顶带共用 WindowControlsBar,
          坐标也复刻同一组工具类——主界面顶带坐标若调,这里跟着改,不出现第二份魔法数。
          品牌行不复刻:设置模态左上角不显示 Logo。 */}
      <div
        className="pointer-events-auto flex h-full items-start"
        {...titlebarOverlayDragRegionProps()}
      >
        <WindowControlsBar className="ml-auto mt-1.5 mr-2" alwaysVisible />
      </div>
    </div>
  );
}
