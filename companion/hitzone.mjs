/**
 * 卡片窗口的命中区判定（纯函数）。
 *
 * 从 `main.mjs` 抽出来的理由：这两条都是**实测踩过**的坑，而 `main.mjs` 一被 import
 * 就会起 HTTP 服务、开原生窗口、开始轮询鼠标——没法单测。抽成纯函数后可以钉住：
 *
 *  - **`WM_NCHITTEST` 返回 `HTCAPTION` 的区域永远收不到 `WM_LBUTTONDOWN`**（§6.7），
 *    所以按钮必须从标题栏区排除，否则点不动；
 *  - 卡片四周给阴影留了外扩，**那圈半透明像素会吞点击**（§6.9），
 *    所以卡片矩形之外必须返回 `transparent`，把点击交还给下面的应用。
 */
import { CARD, cardHitTest, cardLayout } from './card.mjs'

/** 拖宽热区的宽度（DIP）：贴着卡片左右内缘的一条。 */
export const RESIZE_EDGE = 7

/**
 * 窗口内某点该算什么命中区（DIP 坐标）。
 *  - 卡片外那圈阴影外扩 → 'transparent'，让点击穿透到下面的应用；
 *  - 头部/页脚的按钮 → 'hand'，光标变手型（仍是客户区，要能收到点击）；
 *  - **正文/页脚的左右内缘 → 'resize-left' / 'resize-right'**：按住可拖宽（见 §6 第 24 条）；
 *  - 头部空白 → 'caption'，即标题栏：可按住拖动，光标四向箭头；
 *  - 其余 → 'client'。
 * @param dipX/dipY - 窗口内 DIP 坐标（调用方已按显示器缩放除过）。
 * @param data - 卡片状态（要 `bodyHeight` / `cardW` / `status` / `langOpen` / `langW` / `copyW` / `retryW`）。
 */
export function hitZone(dipX, dipY, data) {
  const layout = cardLayout(data.bodyHeight, data)
  const box = layout.card
  const inCard = dipX >= box.x && dipY >= box.y && dipX <= box.x + box.w && dipY <= box.y + box.h
  if (!inCard) return 'transparent'
  if (data.langOpen === true) return 'client' // 菜单展开时整块要能点到菜单行
  if (cardHitTest(dipX, dipY, layout) !== null) return 'hand'
  // 左右内缘拖宽：**只在正文/页脚区**（头部有按钮，且头部本来就要拖动卡片）。
  // 流式生成中禁用 —— 那会和"两趟绘制 + 流式跟随"抢窗口尺寸，等翻译停下来再拖。
  if (dipY > box.y + CARD.headerH && data.status !== 'running') {
    if (dipX <= box.x + RESIZE_EDGE) return 'resize-left'
    if (dipX >= box.x + box.w - RESIZE_EDGE) return 'resize-right'
  }
  if (dipY <= box.y + CARD.headerH) return 'caption'
  return 'client'
}
