import screenshot from 'screenshot-desktop'
import { Jimp } from 'jimp'
import { screen } from 'electron'
import type { Rect } from './scroll-stitch'

function virtualBounds(): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays()
  return displays.reduce(
    (acc, d) => {
      const b = d.bounds
      const left = Math.min(acc.x, b.x)
      const top = Math.min(acc.y, b.y)
      const right = Math.max(acc.x + acc.width, b.x + b.width)
      const bottom = Math.max(acc.y + acc.height, b.y + b.height)
      return { x: left, y: top, width: right - left, height: bottom - top }
    },
    { ...displays[0].bounds }
  )
}

/** Map DIP screen rect → pixel rect inside a full desktop capture. */
export function mapRectToImage(rect: Rect, imageWidth: number, imageHeight: number): Rect {
  const vb = virtualBounds()
  const scaleX = imageWidth / vb.width
  const scaleY = imageHeight / vb.height
  const x = Math.round((rect.x - vb.x) * scaleX)
  const y = Math.round((rect.y - vb.y) * scaleY)
  const w = Math.round(rect.width * scaleX)
  const h = Math.round(rect.height * scaleY)
  return {
    x: Math.max(0, Math.min(x, imageWidth - 1)),
    y: Math.max(0, Math.min(y, imageHeight - 1)),
    width: Math.max(1, Math.min(w, imageWidth - Math.max(0, x))),
    height: Math.max(1, Math.min(h, imageHeight - Math.max(0, y)))
  }
}

export async function captureFullScreen(): Promise<Buffer> {
  return screenshot({ format: 'png' })
}

export async function captureRegion(rectDip: Rect): Promise<Buffer> {
  const full = await screenshot({ format: 'png' })
  const img = await Jimp.read(full)
  const r = mapRectToImage(rectDip, img.width, img.height)
  img.crop({ x: r.x, y: r.y, w: r.width, h: r.height })
  return img.getBuffer('image/png')
}

export async function captureRegionRaw(rectDip: Rect): Promise<{
  bitmap: Buffer
  width: number
  height: number
}> {
  const full = await screenshot({ format: 'png' })
  const img = await Jimp.read(full)
  const r = mapRectToImage(rectDip, img.width, img.height)
  img.crop({ x: r.x, y: r.y, w: r.width, h: r.height })
  return {
    bitmap: Buffer.from(img.bitmap.data),
    width: img.bitmap.width,
    height: img.bitmap.height
  }
}
