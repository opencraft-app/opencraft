// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 企业微信（WeCom）官方品牌图标
 *
 * 按官方 logo 结构手工描摹（迁移前 SDK 用 @tencent/tea-icons-react 的
 * LogoWecomIcon，mono2 未引入该图标包）：
 *   1. 空心描边蓝色对话气泡（stroke 而非 fill），尾巴在左下
 *   2. 右下角四个梨形色块，尖端朝同一中心汇聚成风车状：
 *      绿（上）/ 黄（左）/ 橙（下）/ 蓝（右）
 *   3. 每个梨形带白色 halo（paintOrder=stroke 让描边绘制在填充下方，
 *      只在外缘露出白边）—— 对应官方视觉里色块与气泡描边、色块之间的白色间隙
 *
 * 梨形路径按圆的外切线几何计算：设球部圆心 B、半径 r、尖端 T，
 * 由 α=acos(r/|BT|) 得两切点，切点间以大弧（large-arc=1, sweep=1）闭合，
 * 得到尖端细长的标准梨形。四瓣统一取 |BT|/r ≈ 2.0 保证粗细一致。
 *
 * 官方配色：蓝 #1485EE / 绿 #21B411 / 黄 #FFC90C / 橙 #FF6B00
 */

/** 梨形色块公共属性：白色 halo 绘制于填充下方，只在外缘可见 */
const PETAL_HALO = {
  stroke: '#fff',
  strokeWidth: 18,
  paintOrder: 'stroke' as const,
};

export function WecomIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      {/* 空心对话气泡（含左下尾巴） */}
      <path
        d="M225 78C120 78 32 150 32 238c0 54 33 102 83 131-3 16-12 31-23 41-10 9-4 22 8 18 28-10 52-24 68-36 18 4 37 6 57 6 105 0 193-72 193-160S330 78 225 78Z"
        stroke="#1485EE"
        strokeWidth="34"
        strokeLinejoin="round"
      />

      {/* 绿（上）：球部 (412,276) r38 */}
      <path d="M400 352 L376 289 A38 38 0 1 1 442 300 Z" fill="#21B411" {...PETAL_HALO} />

      {/* 蓝（右）：球部 (462,332) r30 */}
      <path d="M408 352 L438 313 A30 30 0 1 1 456 361 Z" fill="#1485EE" {...PETAL_HALO} />

      {/* 黄（左）：球部 (336,347) r34 */}
      <path d="M404 354 L350 378 A34 34 0 1 1 356 319 Z" fill="#FFC90C" {...PETAL_HALO} />

      {/* 橙（下）：球部 (384,418) r33 */}
      <path d="M406 354 L417 412 A33 33 0 1 1 362 393 Z" fill="#FF6B00" {...PETAL_HALO} />
    </svg>
  );
}