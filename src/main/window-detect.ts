import koffi from 'koffi'
import { BrowserWindow, screen } from 'electron'
import type { Rect } from './scroll-stitch'

const user32 = koffi.load('user32.dll')
const dwmapi = koffi.load('dwmapi.dll')

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
const DwmGetWindowAttribute = dwmapi.func(
  'long __stdcall DwmGetWindowAttribute(void *hwnd, uint dwAttribute, _Out_ RECT *pvAttribute, uint cbAttribute)'
)

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_DISABLED = 0x08000000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const WS_EX_TRANSPARENT = 0x00000020
const WS_EX_LAYERED = 0x00080000
const GA_ROOT = 2
/** 可视窗口边框（不含 Win10/11 阴影那一圈） */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const SIZEOF_RECT = 16

type RawRect = { left: number; top: number; right: number; bottom: number }

type Candidate = {
  hwnd: unknown
  title: string
  cls: string
  raw: RawRect
  dip: Rect
  area: number
  zOrder: number
  wechat: boolean
}

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

function readWString(
  fn: (hwnd: unknown, buf: Uint16Array, n: number) => number,
  hwnd: unknown,
  size: number
): string {
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

function isWeChatLike(title: string, cls: string): boolean {
  const text = `${title} ${cls}`
  return /微信|Weixin|WeChat|ChatWnd|mmui|WeChatMain|Weixin\.exe|Qt\d+QWindowIcon/i.test(text)
}

function isDesktopOrShell(title: string, cls: string): boolean {
  return /^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd|XamlExplorerHostIslandWindow|Windows\.UI\.Core\.CoreWindow|ApplicationFrameWindow|EdgeUiInputTopWndClass|ForegroundStaging|Internet Explorer_Hidden|SysShadow)$/i.test(
    cls
  ) || /^Program Manager$/i.test(title)
}

function nearlyFullscreen(raw: RawRect): boolean {
  const display = screen.getDisplayNearestPoint(
    screen.screenToDipPoint({ x: raw.left + 10, y: raw.top + 10 })
  )
  const b = display.bounds
  const physTl = screen.dipToScreenPoint({ x: b.x, y: b.y })
  const physBr = screen.dipToScreenPoint({ x: b.x + b.width, y: b.y + b.height })
  const screenW = Math.abs(physBr.x - physTl.x)
  const screenH = Math.abs(physBr.y - physTl.y)
  const w = raw.right - raw.left
  const h = raw.bottom - raw.top
  return w >= screenW * 0.96 && h >= screenH * 0.96
}

/** 优先 DWM 可视框，去掉阴影；失败再回退 GetWindowRect */
function getVisibleRawRect(hwnd: unknown): RawRect | null {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  try {
    const hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, SIZEOF_RECT)
    if (hr === 0 && rect.right > rect.left && rect.bottom > rect.top) {
      return rect
    }
  } catch {
    // ignore
  }
  if (!GetWindowRect(hwnd, rect)) return null
  if (rect.right <= rect.left || rect.bottom <= rect.top) return null
  return rect
}

/**
 * 再收一圈：DWM 后仍可能剩淡阴影 / 圆角外透明边。
 * 微信多一些，其它窗口只微收。
 */
function tightenRawRect(raw: RawRect, wechat: boolean): RawRect {
  const display = screen.getDisplayNearestPoint(
    screen.screenToDipPoint({ x: raw.left + 4, y: raw.top + 4 })
  )
  const scale = display.scaleFactor || 1
  // 物理像素内缩：微信约 7dip，其它 1dip
  const inset = Math.max(1, Math.round((wechat ? 7 : 1) * scale))
  const left = raw.left + inset
  const top = raw.top + inset
  const right = raw.right - inset
  const bottom = raw.bottom - inset
  if (right - left < 60 || bottom - top < 60) return raw
  return { left, top, right, bottom }
}

function rectFromHwnd(hwnd: unknown, wechat: boolean): Rect | null {
  const raw0 = getVisibleRawRect(hwnd)
  if (!raw0) return null
  const raw = tightenRawRect(raw0, wechat)
  const w = raw.right - raw.left
  const h = raw.bottom - raw.top
  if (w < 80 || h < 80) return null
  return physicalToDipRect(raw.left, raw.top, raw.right, raw.bottom)
}

function containsPoint(raw: RawRect, px: number, py: number): boolean {
  return px >= raw.left && px < raw.right && py >= raw.top && py < raw.bottom
}

function collectCandidates(px: number, py: number): Candidate[] {
  const list: Candidate[] = []
  let z = 0

  const cb = koffi.register((hwnd: unknown) => {
    z += 1
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true
    if (isOwnProcess(hwnd)) return true

    const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE))
    if (style & WS_DISABLED) return true

    const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    const title = readWString(GetWindowTextW, hwnd, 256)
    const cls = readWString(GetClassNameW, hwnd, 256)
    const wechat = isWeChatLike(title, cls)

    if (isDesktopOrShell(title, cls)) return true
    if ((ex & WS_EX_TRANSPARENT) && !wechat) return true
    if ((ex & WS_EX_TOOLWINDOW) && !wechat && !title) return true
    if ((ex & WS_EX_NOACTIVATE) && !wechat && (ex & WS_EX_TOOLWINDOW)) return true

    const raw0 = getVisibleRawRect(hwnd)
    if (!raw0) return true
    // 命中测试仍用未内缩框，避免边缘点选失败；展示/截取用收紧后的框
    if (!containsPoint(raw0, px, py)) return true
    const raw = tightenRawRect(raw0, wechat)
    const w = raw.right - raw.left
    const h = raw.bottom - raw.top
    if (w < 80 || h < 80) return true
    if (!wechat && nearlyFullscreen(raw0)) return true

    list.push({
      hwnd,
      title,
      cls,
      raw,
      dip: physicalToDipRect(raw.left, raw.top, raw.right, raw.bottom),
      area: w * h,
      zOrder: z,
      wechat
    })
    return true
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }

  return list
}

function pickBest(cands: Candidate[]): Candidate | null {
  if (cands.length === 0) return null

  const wechat = cands.filter((c) => c.wechat).sort((a, b) => a.zOrder - b.zOrder)
  if (wechat.length > 0) return wechat[0]

  const normal = [...cands].sort((a, b) => {
    if (a.zOrder !== b.zOrder) return a.zOrder - b.zOrder
    return a.area - b.area
  })
  return normal[0] ?? null
}

function fromWindowFromPoint(px: number, py: number): Rect | null {
  const ours = BrowserWindow.getAllWindows()
  for (const w of ours) {
    try {
      w.setIgnoreMouseEvents(true, { forward: true })
    } catch {
      // ignore
    }
  }
  try {
    const hwnd = WindowFromPoint({ x: px, y: py })
    if (!hwnd || isOwnProcess(hwnd)) return null
    const root = GetAncestor(hwnd, GA_ROOT) || hwnd
    if (isOwnProcess(root)) return null

    const title = readWString(GetWindowTextW, root, 256)
    const cls = readWString(GetClassNameW, root, 256)
    if (isDesktopOrShell(title, cls)) return null

    const raw0 = getVisibleRawRect(root)
    if (!raw0) return null
    const wechat = isWeChatLike(title, cls)
    if (!wechat && nearlyFullscreen(raw0)) return null
    return rectFromHwnd(root, wechat)
  } finally {
    for (const w of ours) {
      try {
        w.setIgnoreMouseEvents(false)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 在物理屏幕坐标处解析“当前窗口”边框（DIP，不含阴影）。
 */
export function getTopWindowRectAtPhysical(px: number, py: number): Rect | null {
  const cands = collectCandidates(px, py)
  const best = pickBest(cands)
  if (best) return best.dip

  return fromWindowFromPoint(px, py)
}

/** DIP 屏幕坐标 → 窗口矩形（DIP） */
export function getTopWindowRectAtDip(dipX: number, dipY: number): Rect | null {
  const phys = screen.dipToScreenPoint({ x: Math.round(dipX), y: Math.round(dipY) })
  return getTopWindowRectAtPhysical(phys.x, phys.y)
}

void WS_EX_LAYERED
void RECT
