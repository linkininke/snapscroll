import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell
} from 'electron'
import { join } from 'path'
import { copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { captureRegion, captureFullScreen } from './capture'
import type { Rect } from './scroll-stitch'
import { ManualScrollSession } from './manual-scroll'
import {
  createOverlayWindow,
  createMainWindow,
  createScrollBarWindow
} from './windows'
import { createTray, destroyTray } from './tray'

export type CaptureMode = 'region' | 'scroll'

const HOTKEY_CANDIDATES = {
  capture: ['F1', 'Alt+1', 'CommandOrControl+Alt+1'],
  fullscreen: ['F2', 'Alt+2', 'CommandOrControl+Alt+2']
} as const

const HOTKEYS = {
  capture: 'F1',
  fullscreen: 'F2'
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let scrollBarWindow: BrowserWindow | null = null
let captureMode: CaptureMode = 'region'
let busy = false
let quitting = false
let scrollSession: ManualScrollSession | null = null

const CAPTURE_DIR = 'E:\\截图文件'

function ensureCaptureDir(): void {
  mkdirSync(CAPTURE_DIR, { recursive: true })
}

function isDev(): boolean {
  return !app.isPackaged
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow(isDev())
    bindMainWindowClose(mainWindow)
  }
  mainWindow.show()
  mainWindow.focus()
}

function bindMainWindowClose(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function showOverlay(mode: CaptureMode): Promise<void> {
  if (busy || scrollSession) return
  captureMode = mode

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = createOverlayWindow(isDev())
  }

  const displays = screen.getAllDisplays()
  const bounds = displays.reduce(
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

  overlayWindow.setBounds(bounds)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.show()
  overlayWindow.focus()
  overlayWindow.webContents.send('overlay:start', { mode })
}

function finishWithPng(png: Buffer, mode: CaptureMode): void {
  ensureCaptureDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(CAPTURE_DIR, `snap-${stamp}.png`)
  writeFileSync(filePath, png)

  const image = nativeImage.createFromBuffer(png)
  clipboard.writeImage(image)

  // 只复制到剪贴板并静默存盘，不弹贴图窗口
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:done', { filePath, mode })
  }
}

function hideScrollBar(): void {
  if (scrollBarWindow && !scrollBarWindow.isDestroyed()) {
    scrollBarWindow.hide()
  }
}

async function startManualScroll(rect: Rect): Promise<void> {
  if (busy) return
  busy = true

  try {
    // 彻底收起选区层，把鼠标还给桌面，用户可自由滚当前焦点/鼠标下的窗口
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide()
    }
    await sleep(150)

    const display = screen.getPrimaryDisplay().workArea
    const barW = 360
    const barH = 52
    const anchor = {
      x: Math.min(rect.x + rect.width - barW, display.x + display.width - barW - 8),
      y: Math.min(rect.y + rect.height + 10, display.y + display.height - barH - 8)
    }

    if (scrollBarWindow && !scrollBarWindow.isDestroyed()) {
      scrollBarWindow.close()
      scrollBarWindow = null
    }
    scrollBarWindow = createScrollBarWindow(isDev(), anchor)
    scrollBarWindow.setAlwaysOnTop(true, 'screen-saver')
    scrollBarWindow.showInactive()

    scrollSession = new ManualScrollSession(rect, {
      onFrameCount: (count) => {
        if (scrollBarWindow && !scrollBarWindow.isDestroyed()) {
          scrollBarWindow.webContents.send('scroll-bar:frames', count)
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('capture:status', {
            status: 'scrolling',
            frames: count
          })
        }
      }
    })
    await scrollSession.start()
  } catch (err) {
    scrollSession = null
    hideScrollBar()
    busy = false
    const message = err instanceof Error ? err.message : String(err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:error', { message })
    }
  }
}

async function finishManualScroll(): Promise<void> {
  if (!scrollSession) return
  const session = scrollSession
  scrollSession = null
  hideScrollBar()

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:status', { status: 'stitching' })
    }
    const png = await session.stop()
    finishWithPng(png, 'scroll')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:error', { message })
    }
    console.error('[scroll]', message)
  } finally {
    busy = false
  }
}

function cancelManualScroll(): void {
  if (scrollSession) {
    scrollSession.cancel()
    scrollSession = null
  }
  hideScrollBar()
  busy = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:status', { status: 'cancelled' })
  }
}

async function handleRegionSelected(rect: Rect): Promise<void> {
  if (captureMode === 'scroll') {
    await startManualScroll(rect)
    return
  }

  if (busy) return
  busy = true

  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
    await sleep(120)
    const png = await captureRegion(rect)
    finishWithPng(png, 'region')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:error', { message })
    }
    console.error('[capture]', message)
  } finally {
    busy = false
  }
}

async function doFullscreenCapture(): Promise<void> {
  if (busy || scrollSession) return
  busy = true
  try {
    await sleep(80)
    const png = await captureFullScreen()
    ensureCaptureDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = join(CAPTURE_DIR, `full-${stamp}.png`)
    writeFileSync(filePath, png)
    const image = nativeImage.createFromBuffer(png)
    clipboard.writeImage(image)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:done', { filePath, mode: 'region' })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:error', { message })
    }
  } finally {
    busy = false
  }
}

function registerHotkeys(): void {
  const displayAccel = (accel: string): string =>
    accel.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')

  const bind = (key: keyof typeof HOTKEY_CANDIDATES, action: () => void): void => {
    for (const accel of HOTKEY_CANDIDATES[key]) {
      if (globalShortcut.register(accel, action)) {
        HOTKEYS[key] = displayAccel(accel)
        return
      }
    }
    console.warn(`[hotkey] ${key} 注册失败，可能被其他程序占用`)
  }

  bind('capture', () => {
    // F1：长截图进行中再按一次 = 完成；否则打开选区（可选区域/长截图）
    if (scrollSession) {
      void finishManualScroll()
      return
    }
    void showOverlay('region')
  })
  bind('fullscreen', () => void doFullscreenCapture())

  // 长截图进行中：Enter 完成
  globalShortcut.register('Return', () => {
    if (scrollSession) void finishManualScroll()
  })

  // Esc：取消选区 / 取消长截图
  globalShortcut.register('Escape', () => {
    if (scrollSession) {
      cancelManualScroll()
      return
    }
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide()
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('overlay:cancel', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
  })

  ipcMain.handle('overlay:confirm', async (_e, rect: Rect, mode?: CaptureMode) => {
    if (mode === 'region' || mode === 'scroll') {
      captureMode = mode
    }
    await handleRegionSelected(rect)
  })

  ipcMain.handle('scroll-bar:finish', async () => {
    await finishManualScroll()
  })

  ipcMain.handle('scroll-bar:cancel', () => {
    cancelManualScroll()
  })

  ipcMain.handle('app:get-hotkeys', () => ({
    capture: HOTKEYS.capture,
    fullscreen: HOTKEYS.fullscreen
  }))

  ipcMain.handle('app:open-capture-dir', async () => {
    ensureCaptureDir()
    await shell.openPath(CAPTURE_DIR)
    return CAPTURE_DIR
  })

  ipcMain.handle('app:start-region', () => showOverlay('region'))
  ipcMain.handle('app:start-scroll', () => showOverlay('scroll'))
  ipcMain.handle('app:start-fullscreen', () => doFullscreenCapture())

  ipcMain.handle('pin:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.close()
  })

  ipcMain.handle('pin:save-as', async (e, filePath: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const wasTop = win?.isAlwaysOnTop() ?? false

    // alwaysOnTop 会导致 Windows 上保存对话框被挡住/不显示
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false)
      win.setEnabled(false)
    }

    try {
      const result = await dialog.showSaveDialog({
        title: '保存截图',
        defaultPath: filePath,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      if (!result.canceled && result.filePath) {
        copyFileSync(filePath, result.filePath)
        return result.filePath
      }
      return null
    } finally {
      if (win && !win.isDestroyed()) {
        win.setEnabled(true)
        if (wasTop) win.setAlwaysOnTop(true, 'floating')
        win.focus()
      }
    }
  })

  ipcMain.handle('pin:copy', async (_e, filePath: string) => {
    const image = nativeImage.createFromPath(filePath)
    clipboard.writeImage(image)
    return true
  })
}

function isSilentLaunch(): boolean {
  return process.argv.some((a) => a === '--silent' || a === '--hidden' || a === '/silent')
}

app.setName('截图助手')

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('截图助手')
  }

  ensureCaptureDir()
  registerIpc()
  registerHotkeys()

  const silent = isSilentLaunch()
  mainWindow = createMainWindow(isDev(), { silent })
  bindMainWindowClose(mainWindow)

  createTray({
    capture: () => void showOverlay('region'),
    fullscreen: () => void doFullscreenCapture(),
    showMain: () => showMainWindow(),
    openDir: () => {
      ensureCaptureDir()
      void shell.openPath(CAPTURE_DIR)
    },
    quit: () => {
      quitting = true
      cancelManualScroll()
      destroyTray()
      app.quit()
    }
  })

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  cancelManualScroll()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  destroyTray()
})

app.on('window-all-closed', () => {
  // 托盘常驻
})
