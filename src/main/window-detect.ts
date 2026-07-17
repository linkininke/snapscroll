import koffi from 'koffi'
import { BrowserWindow, screen } from 'electron'
import type { Rect } from './scroll-stitch'

const user32 = koffi.load('user32.dll')

const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long'
})

const POINT = koffi.struct('POINT', {
  x: 'long',
  y: 'long'
})

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)')

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)')
const IsIconic = user32.func('bool __stdcall IsIconic(void *hWnd)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)')
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'
)
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)')
const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint gaFlags)')
const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT Point)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, _Out_ uint16 *lpClassName, int nMaxCount)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16 *lpString, int nMaxCount)')

const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const GA_ROOT = 2

function physicalToDipRect(left: number, top: number, right: number, bottom: number): Rect {
  const tl = screen.screenToDipPoint({ x: left, y: top })
  const br = screen.screenToDipPoint({ x: right, y: bottom })
  return {
    x: Math.round(tl.x),
    y: Math.round(tl.y),
    width: Math.max(1, Math.round(br.x - tl.x)),
    height: Math.max(1, Math.round(br.y - tl.y))
  }
}

function readWString(fn: (hwnd: unknown, buf: Uint16Array, n: number) => number, hwnd: unknown, size: number): string {
  const buf = new Uint16Array(size)
  const n = fn(hwnd, buf, size)
  if (n <= 0) return ''
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

function isOwnProcess(hwnd: unknown): boolean {
  const pidBuf = [0]
  GetWindowThreadProcessId(hwnd, pidBuf)
  return pidBuf[0] === process.pid
}

function isWeChatLike(hwnd: unknown): boolean {
  const title = readWString(GetWindowTextW, hwnd, 256)
  const cls = readWString(GetClassNameW, hwnd, 256)
  const text = `${title} ${cls}`
  return /微信|Weixin|WeChat|ChatWnd|mmui|WeChatMain|Qt\d+QWindow/i.test(text)
}

function isSkippableWindow(hwnd: unknown): boolean {
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true
  if (isOwnProcess(hwnd)) return true

  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  // 工具窗默认跳过，但微信/Qt 主窗有时带 TOOLWINDOW，需放行
  if (ex & WS_EX_TOOLWINDOW && !isWeChatLike(hwnd)) return true

  return false
}

function rectFromHwnd(hwnd: unknown): Rect | null {
  const root = GetAncestor(hwnd, GA_ROOT) || hwnd
  if (isOwnProcess(root)) return null

  const rect = {}
  if (!GetWindowRect(root, rect)) return null
  const r = rect as { left: number; top: number; right: number; bottom: number }
  const w = r.right - r.left
  const h = r.bottom - r.top
  // 微信主窗通常较大；过小的气泡/菜单忽略
  if (w < 120 || h < 120) return null
  // 几乎全屏的壳层也接受（微信最大化）
  return physicalToDipRect(r.left, r.top, r.right, r.bottom)
}

/**
 * Z 序扫描：找到覆盖该点的最上层可见窗口。
 * 对微信白底主窗做了 TOOLWINDOW / Qt 特例放行。
 */
export function getTopWindowRectAtPhysical(px: number, py: number): Rect | null {
  let found: Rect | null = null
  let wechatCandidate: Rect | null = null

  const cb = koffi.register((hwnd: unknown) => {
    if (found) return false
    if (isSkippableWindow(hwnd)) return true

    const rect = {}
    if (!GetWindowRect(hwnd, rect)) return true
    const r = rect as { left: number; top: number; right: number; bottom: number }
    const w = r.right - r.left
    const h = r.bottom - r.top
    if (w < 120 || h < 120) return true
    if (px < r.left || px >= r.right || py < r.top || py >= r.bottom) return true

    const dip = physicalToDipRect(r.left, r.top, r.right, r.bottom)
    if (isWeChatLike(hwnd)) {
      // 优先记住微信主窗，避免被上层透明壳抢走
      wechatCandidate = dip
    }
    found = dip
    return false
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }

  // 若命中点在微信窗内，优先返回微信边框（更适合白底聊天窗截图）
  if (wechatCandidate) return wechatCandidate
  return found
}

/** DIP 屏幕坐标 → 窗口矩形（DIP） */
export function getTopWindowRectAtDip(dipX: number, dipY: number): Rect | null {
  const phys = screen.dipToScreenPoint({ x: dipX, y: dipY })
  let rect = getTopWindowRectAtPhysical(phys.x, phys.y)
  if (rect) return rect

  // 兜底：临时让所有本进程窗口穿透，再用 WindowFromPoint
  const ours = BrowserWindow.getAllWindows()
  for (const w of ours) {
    try {
      w.setIgnoreMouseEvents(true, { forward: true })
    } catch {
      // ignore
    }
  }
  try {
    const hwnd = WindowFromPoint({ x: phys.x, y: phys.y })
    if (hwnd) rect = rectFromHwnd(hwnd)
  } finally {
    for (const w of ours) {
      try {
        w.setIgnoreMouseEvents(false)
      } catch {
        // ignore
      }
    }
  }
  return rect
}
