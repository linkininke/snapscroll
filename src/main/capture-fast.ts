import koffi from 'koffi'
import { screen } from 'electron'
import type { Rect } from './scroll-stitch'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

const GetDC = user32.func('void * __stdcall GetDC(void *hWnd)')
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hWnd, void *hDC)')
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)')
const CreateCompatibleBitmap = gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)')
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *h)')
const BitBlt = gdi32.func(
  'bool __stdcall BitBlt(void *hdcDest, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)'
)
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *ho)')
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *hdc)')
const GetDIBits = gdi32.func(
  'int __stdcall GetDIBits(void *hdc, void *hbm, uint start, uint cLines, _Out_ void *lpvBits, void *lpbi, uint usage)'
)

const SRCCOPY = 0x00cc0020
const BI_RGB = 0
const DIB_RGB_COLORS = 0

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32'
})

export type RawFrame = {
  /** RGBA buffer, top-down */
  data: Buffer
  width: number
  height: number
}

/**
 * 快速区域截屏（BitBlt），供长截图连续采样。坐标为 DIP。
 */
export function captureRegionFast(rectDip: Rect): RawFrame {
  const tl = screen.dipToScreenPoint({ x: rectDip.x, y: rectDip.y })
  const br = screen.dipToScreenPoint({
    x: rectDip.x + rectDip.width,
    y: rectDip.y + rectDip.height
  })
  const x = Math.round(tl.x)
  const y = Math.round(tl.y)
  const width = Math.max(1, Math.round(br.x - tl.x))
  const height = Math.max(1, Math.round(br.y - tl.y))

  // 防止异常尺寸撑爆内存 / 打崩原生调用
  if (width > 8192 || height > 8192 || width * height > 25_000_000) {
    throw new Error(`截取区域过大: ${width}x${height}`)
  }

  const hdcScreen = GetDC(null)
  if (!hdcScreen) throw new Error('GetDC failed')

  const hdcMem = CreateCompatibleDC(hdcScreen)
  if (!hdcMem) {
    ReleaseDC(null, hdcScreen)
    throw new Error('CreateCompatibleDC failed')
  }
  const hbm = CreateCompatibleBitmap(hdcScreen, width, height)
  if (!hbm) {
    DeleteDC(hdcMem)
    ReleaseDC(null, hdcScreen)
    throw new Error('CreateCompatibleBitmap failed')
  }
  const old = SelectObject(hdcMem, hbm)

  try {
    if (!BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY)) {
      throw new Error('BitBlt failed')
    }

    const bmi = Buffer.alloc(40 + 4)
    bmi.writeUInt32LE(40, 0)
    bmi.writeInt32LE(width, 4)
    bmi.writeInt32LE(-height, 8) // top-down
    bmi.writeUInt16LE(1, 12)
    bmi.writeUInt16LE(32, 14)
    bmi.writeUInt32LE(BI_RGB, 16)

    const bgra = Buffer.alloc(width * height * 4)
    const ok = GetDIBits(hdcMem, hbm, 0, height, bgra, bmi, DIB_RGB_COLORS)
    if (!ok) throw new Error('GetDIBits failed')

    // BGRA → RGBA（就地转换，少占一份大缓冲）
    for (let i = 0; i < width * height; i++) {
      const o = i * 4
      const b = bgra[o]!
      bgra[o] = bgra[o + 2]!
      bgra[o + 2] = b
      bgra[o + 3] = 255
    }

    return { data: bgra, width, height }
  } finally {
    try {
      SelectObject(hdcMem, old)
      DeleteObject(hbm)
      DeleteDC(hdcMem)
      ReleaseDC(null, hdcScreen)
    } catch {
      // ignore cleanup errors
    }
  }
}

void BITMAPINFOHEADER
