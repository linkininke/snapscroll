import koffi from 'koffi'
import { screen } from 'electron'
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

const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
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

function isOwnProcess(hwnd: unknown): boolean {
  const pidBuf = [0]
  GetWindowThreadProcessId(hwnd, pidBuf)
  return pidBuf[0] === process.pid
}

function isSkippableWindow(hwnd: unknown): boolean {
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true
  if (isOwnProcess(hwnd)) return true
  const ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  if (ex & WS_EX_TOOLWINDOW) return true
  // 只要顶层根窗口，避免点到按钮等子控件
  const root = GetAncestor(hwnd, GA_ROOT)
  if (root && root !== hwnd) return true
  return false
}

/**
 * 在屏幕坐标（物理像素）处查找最上层可见顶层窗口边框。
 * 优先按 Z 序扫描（边缘/窗口命中），跳过本进程与工具窗。
 */
export function getTopWindowRectAtPhysical(px: number, py: number): Rect | null {
  let found: Rect | null = null

  const cb = koffi.register((hwnd: unknown) => {
    if (found) return false
    if (isSkippableWindow(hwnd)) return true

    const rect = {}
    if (!GetWindowRect(hwnd, rect)) return true
    const r = rect as { left: number; top: number; right: number; bottom: number }
    const w = r.right - r.left
    const h = r.bottom - r.top
    if (w < 32 || h < 32) return true
    if (px < r.left || px >= r.right || py < r.top || py >= r.bottom) return true

    found = physicalToDipRect(r.left, r.top, r.right, r.bottom)
    return false
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }

  return found
}

/** DIP 屏幕坐标 → 窗口矩形（DIP） */
export function getTopWindowRectAtDip(dipX: number, dipY: number): Rect | null {
  const phys = screen.dipToScreenPoint({ x: dipX, y: dipY })
  return getTopWindowRectAtPhysical(phys.x, phys.y)
}

/**
 * 备用：先穿透再 WindowFromPoint，取根窗口。
 * 调用方需保证本程序遮罩层暂时忽略鼠标。
 */
export function getRootWindowRectFromPointPhysical(px: number, py: number): Rect | null {
  const hwnd = WindowFromPoint({ x: px, y: py })
  if (!hwnd || isOwnProcess(hwnd)) return null
  const root = GetAncestor(hwnd, GA_ROOT) || hwnd
  if (isSkippableWindow(root) && isOwnProcess(root)) return null

  const rect = {}
  if (!GetWindowRect(root, rect)) return null
  const r = rect as { left: number; top: number; right: number; bottom: number }
  const w = r.right - r.left
  const h = r.bottom - r.top
  if (w < 32 || h < 32) return null
  return physicalToDipRect(r.left, r.top, r.right, r.bottom)
}

void WS_EX_NOACTIVATE
