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

  const hdcScreen = GetDC(null)
  if (!hdcScreen) throw new Error('GetDC failed')

  const hdcMem = CreateCompatibleDC(hdcScreen)
  const hbm = CreateCompatibleBitmap(hdcScreen, width, height)
  const old = SelectObject(hdcMem, hbm)

  try {
    if (!BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY)) {
      throw new Error('BitBlt failed')
    }

    const header = {
      biSize: 40,
      biWidth: width,
      biHeight: -height, // top-down
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0
    }

    // BITMAPINFO = header + color table placeholder
    const bmi = Buffer.alloc(40 + 4)
    bmi.writeUInt32LE(header.biSize, 0)
    bmi.writeInt32LE(header.biWidth, 4)
    bmi.writeInt32LE(header.biHeight, 8)
    bmi.writeUInt16LE(header.biPlanes, 12)
    bmi.writeUInt16LE(header.biBitCount, 14)
    bmi.writeUInt32LE(header.biCompression, 16)

    const bgra = Buffer.alloc(width * height * 4)
    const ok = GetDIBits(hdcMem, hbm, 0, height, bgra, bmi, DIB_RGB_COLORS)
    if (!ok) throw new Error('GetDIBits failed')

    // BGRA → RGBA
    const rgba = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const o = i * 4
      rgba[o] = bgra[o + 2]!
      rgba[o + 1] = bgra[o + 1]!
      rgba[o + 2] = bgra[o]!
      rgba[o + 3] = 255
    }

    return { data: rgba, width, height }
  } finally {
    SelectObject(hdcMem, old)
    DeleteObject(hbm)
    DeleteDC(hdcMem)
    ReleaseDC(null, hdcScreen)
  }
}

void BITMAPINFOHEADER
