import { mouse, Button, straightTo, Point } from '@nut-tree-fork/nut-js'
import { Jimp } from 'jimp'
import { captureRegionRaw } from './capture'

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type ScrollOptions = {
  maxFrames: number
  settleMs: number
  scrollAmount: number
  /** DIP coordinates for mouse click (OS cursor space) */
  clickPoint?: { x: number; y: number }
}

type Frame = {
  data: Buffer
  width: number
  height: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function frameSimilarity(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return 0
  const len = a.data.length
  let same = 0
  // Sample every 16th byte (RGBA) for speed
  for (let i = 0; i < len; i += 64) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) {
      same++
    }
  }
  const total = Math.floor(len / 64)
  return total === 0 ? 0 : same / total
}

/**
 * Find vertical overlap: how many rows at the bottom of `prev` match
 * the top of `next`. Returns overlap height in pixels (0 if none).
 */
function findVerticalOverlap(prev: Frame, next: Frame, searchMin = 24): number {
  const w = Math.min(prev.width, next.width)
  const maxOverlap = Math.min(prev.height, next.height) - 8
  if (maxOverlap < searchMin) return 0

  let bestScore = Number.POSITIVE_INFINITY
  let bestOverlap = 0

  // Prefer larger overlaps; scan from large to small with step
  const step = Math.max(1, Math.floor(maxOverlap / 80))
  for (let overlap = maxOverlap; overlap >= searchMin; overlap -= step) {
    const score = stripDiff(prev, next, overlap, w)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
    // Good enough early exit
    if (score < 6) break
  }

  // Refine around best
  const refineFrom = Math.max(searchMin, bestOverlap - step * 2)
  const refineTo = Math.min(maxOverlap, bestOverlap + step * 2)
  for (let overlap = refineFrom; overlap <= refineTo; overlap++) {
    const score = stripDiff(prev, next, overlap, w)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
  }

  // Reject weak matches (different content)
  if (bestScore > 45) return 0
  return bestOverlap
}

function stripDiff(prev: Frame, next: Frame, overlap: number, width: number): number {
  // Compare prev's bottom `overlap` rows with next's top `overlap` rows
  // Sample every N pixels for speed
  const sampleX = Math.max(1, Math.floor(width / 120))
  const sampleY = Math.max(1, Math.floor(overlap / 40))
  let err = 0
  let count = 0

  for (let y = 0; y < overlap; y += sampleY) {
    const prevY = prev.height - overlap + y
    const nextY = y
    for (let x = 0; x < width; x += sampleX) {
      const pi = (prevY * prev.width + x) * 4
      const ni = (nextY * next.width + x) * 4
      const dr = prev.data[pi]! - next.data[ni]!
      const dg = prev.data[pi + 1]! - next.data[ni + 1]!
      const db = prev.data[pi + 2]! - next.data[ni + 2]!
      err += Math.abs(dr) + Math.abs(dg) + Math.abs(db)
      count++
    }
  }

  return count === 0 ? 999 : err / count
}

async function stitchFrames(frames: Frame[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error('没有捕获到画面')
  if (frames.length === 1) {
    const img = new Jimp({
      width: frames[0].width,
      height: frames[0].height,
      data: frames[0].data
    })
    return img.getBuffer('image/png')
  }

  const overlaps: number[] = [0]
  for (let i = 1; i < frames.length; i++) {
    const ov = findVerticalOverlap(frames[i - 1], frames[i])
    // Fallback: assume ~45% scroll if match failed
    overlaps.push(ov > 0 ? ov : Math.floor(frames[i].height * 0.45))
  }

  let totalHeight = frames[0].height
  for (let i = 1; i < frames.length; i++) {
    totalHeight += frames[i].height - overlaps[i]!
  }

  const width = frames[0].width
  const out = new Jimp({ width, height: totalHeight, color: 0xffffffff })

  let cursorY = 0
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!
    const skip = i === 0 ? 0 : overlaps[i]!
    const src = new Jimp({
      width: frame.width,
      height: frame.height,
      data: Buffer.from(frame.data)
    })

    if (skip > 0) {
      src.crop({ x: 0, y: skip, w: frame.width, h: frame.height - skip })
    }

    out.composite(src, 0, cursorY)
    cursorY += src.height
  }

  return out.getBuffer('image/png')
}

async function scrollDown(amount: number): Promise<void> {
  // nut-js scroll: positive Y typically scrolls down content (wheel down)
  await mouse.scrollDown(Math.max(1, Math.round(amount / 40)))
}

/**
 * Arbitrary-window scrolling long screenshot.
 * Clicks into the selected region, scrolls, captures frames, and stitches by overlap matching.
 */
export async function scrollLongCapture(rect: Rect, options: ScrollOptions): Promise<Buffer> {
  const { maxFrames, settleMs, scrollAmount, clickPoint } = options

  mouse.config.autoDelayMs = 0
  mouse.config.mouseSpeed = 2000

  const center = new Point(
    Math.floor(clickPoint?.x ?? rect.x + rect.width / 2),
    Math.floor(clickPoint?.y ?? rect.y + rect.height / 2)
  )

  await mouse.move(straightTo(center))
  await mouse.click(Button.LEFT)
  await sleep(80)

  const frames: Frame[] = []
  let prev: Frame | null = null

  for (let i = 0; i < maxFrames; i++) {
    const raw = await captureRegionRaw(rect)
    const frame: Frame = {
      data: raw.bitmap,
      width: raw.width,
      height: raw.height
    }

    if (prev) {
      const sim = frameSimilarity(prev, frame)
      if (sim > 0.985) {
        // Reached bottom / no movement
        break
      }
    }

    frames.push(frame)
    prev = frame

    if (i < maxFrames - 1) {
      await scrollDown(scrollAmount)
      await sleep(settleMs)
    }
  }

  if (frames.length === 0) {
    throw new Error('长截图失败：未能捕获画面')
  }

  return stitchFrames(frames)
}
