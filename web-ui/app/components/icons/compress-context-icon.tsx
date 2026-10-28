// 上下文压缩图标:圆角方框 + 中缝拉链。拉链一眼读作「打包 / 压缩」,比剪刀更贴语义
// (用户对照参考图反馈)。
//
// 几何取舍:参考图的中缝是"两组斜齿交错"(振幅约等于方框内宽的 1/3)。照抄细密齿在
// 14-16px 会糊成横条(读成 E / 列表),所以齿数减到 4 段、振幅 ±2.4 单位、线宽 1.6
// ——16px 与 20px 下都还能看出斜齿交错。纯描边,颜色随 currentColor。
export function CompressContextIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <rect height="16" rx="2.5" width="16" x="4" y="4" />
      <path d="M9.6 6.8 14.4 9.2 9.6 11.6 14.4 14 9.6 16.4" />
    </svg>
  );
}