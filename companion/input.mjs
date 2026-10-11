/**
 * 输入原语（纯函数）。抽出来是因为这两个判定各有一条踩过的坑，且 `main.mjs` 一 import
 * 就会起服务/开窗口，没法单测。
 */

/**
 * 屏幕物理坐标是否落在**卡片本体**矩形内（不含四周给阴影留的外扩那圈）。
 *
 * 卡片窗口比卡片本体大 `CARD.shadow` 一圈，那圈是半透明阴影、命中测试返回 `HTTRANSPARENT`
 * （点击穿透到下面的应用）。所以"点在卡片上"必须按**本体**判，不能用窗口矩形：
 * 用窗口矩形的话，点在阴影圈上会被当成"点在卡片上"，卡片就关不掉了。
 *
 * @param x/y - 屏幕物理坐标（鼠标按下点）。
 * @param origin - 窗口左上角（屏幕物理坐标）。
 * @param scale - 该屏缩放。
 * @param layout - `cardLayout(...)` 的结果（坐标是 DIP、含阴影外扩）。
 */
export function pointInCardRect(x, y, origin, scale, layout) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const localX = (x - origin.x) / s
  const localY = (y - origin.y) / s
  const box = layout.card
  return localX >= box.x && localY >= box.y && localX <= box.x + box.w && localY <= box.y + box.h
}

/**
 * 按键**按下边沿**检测：一次按住只算一次触发。
 *
 * 全局按键只能靠 40ms 轮询 `GetAsyncKeyState`，它返回的是"此刻按着没有"。
 * 不做边沿的话，按住 Esc 会按 25 次/秒去关卡片。
 * @returns `(isDown: boolean) => boolean` —— 本次是否为"刚按下"。
 */
export function createEdgeDetector() {
  let down = false
  return function isEdge(isDown) {
    const next = isDown === true
    const fired = next && !down
    down = next
    return fired
  }
}
