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
import { getTopWindowRectAtDip } from './window-detect'
import {
  createOverlayWindow,
  createMainWindow,
  createScrollBarWindow,
  createPinWindow
} from './windows'
import { createTray, destroyTray } from './tray'
import { crashLog } from './crash-log'

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
let escapeHotkeyBound = false

const CAPTURE_DIR = 'E:\\截图文件'

function ensureCaptureDir(): void {
  mkdirSync(CAPTURE_DIR, { recursive: true })
}

function isDev(): boolean {
  return !app.isPackaged
}

function isPinWindow(win: BrowserWindow): boolean {
  try {
    return win.getTitle() === '贴图'
  } catch {
    return false
  }
}

function closeAllPinWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && isPinWindow(win)) {
      win.close()
    }
  }
}

function captureUiActive(): boolean {
  if (scrollSession) return true
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return true
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && isPinWindow(w))
}

function handleEscapeHotkey(): void {
  if (scrollSession) {
    cancelManualScroll()
    syncEscapeHotkey()
    return
  }
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
    syncEscapeHotkey()
    return
  }
  closeAllPinWindows()
  syncEscapeHotkey()
}

/** 仅在选区/长截图/贴图进行中占用 Esc，空闲时释放给系统 */
function syncEscapeHotkey(): void {
  const need = captureUiActive()
  if (need && !escapeHotkeyBound) {
    escapeHotkeyBound = globalShortcut.register('Escape', handleEscapeHotkey)
    if (!escapeHotkeyBound) {
      console.warn('[hotkey] Escape 注册失败')
    }
  } else if (!need && escapeHotkeyBound) {
    globalShortcut.unregister('Escape')
    escapeHotkeyBound = false
  }
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
  const cursor = screen.getCursorScreenPoint()
  overlayWindow.webContents.send('overlay:start', { mode, cursor })
  syncEscapeHotkey()
}

function finishWithPng(png: Buffer, mode: CaptureMode): void {
  ensureCaptureDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(CAPTURE_DIR, `snap-${stamp}.png`)
  writeFileSync(filePath, png)

  const image = nativeImage.createFromBuffer(png)
  clipboard.writeImage(image)
  crashLog('capture-done', `${mode} ${image.getSize().width}x${image.getSize().height} ${filePath}`)

  const size = image.getSize()
  const pin = createPinWindow(isDev(), {
    filePath,
    width: size.width,
    height: size.height
  })
  pin.on('closed', () => syncEscapeHotkey())
  syncEscapeHotkey()

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
    // 与 overlay 第一次操作栏完全同一套坐标（见 overlay.tsx barStyle）
    const barW = 88
    const barH = 42
    let anchor = {
      x: Math.round(rect.x + rect.width - 96),
      y: Math.round(rect.y + rect.height + 8)
    }
    // 若下方放不下，改到选区上方（仍右对齐）
    if (anchor.y + barH > display.y + display.height - 4) {
      anchor.y = Math.round(rect.y - barH - 8)
    }
    anchor = {
      x: Math.min(Math.max(display.x + 4, anchor.x), display.x + display.width - barW - 4),
      y: Math.min(Math.max(display.y + 4, anchor.y), display.y + display.height - barH - 4)
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
    syncEscapeHotkey()
  } catch (err) {
    scrollSession = null
    hideScrollBar()
    busy = false
    syncEscapeHotkey()
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
    syncEscapeHotkey()
  }
}

function cancelManualScroll(): void {
  if (scrollSession) {
    scrollSession.cancel()
    scrollSession = null
  }
  hideScrollBar()
  busy = false
  syncEscapeHotkey()
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
    syncEscapeHotkey()
  }
}

async function doFullscreenCapture(): Promise<void> {
  if (busy || scrollSession) return
  busy = true
  try {
    await sleep(80)
    const png = await captureFullScreen()
    finishWithPng(png, 'region')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:error', { message })
    }
  } finally {
    busy = false
    syncEscapeHotkey()
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

  // Esc 改为按需注册（见 syncEscapeHotkey），避免空闲时抢走系统 Esc
}

function registerIpc(): void {
  ipcMain.handle('overlay:cancel', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
    syncEscapeHotkey()
  })

  ipcMain.handle('overlay:confirm', async (_e, rect: Rect, mode?: CaptureMode) => {
    if (mode === 'region' || mode === 'scroll') {
      captureMode = mode
    }
    await handleRegionSelected(rect)
    syncEscapeHotkey()
  })

  ipcMain.handle('overlay:window-at', (_e, point: { x: number; y: number }) => {
    return getTopWindowRectAtDip(point.x, point.y)
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
    syncEscapeHotkey()
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

// 降低 GPU/合成器压力，规避部分驱动在截屏后的 TDR/蓝屏
try {
  app.disableHardwareAcceleration()
} catch {
  // ignore
}

// 单实例：重复启动会激活已有进程，避免多开互相抢快捷键后异常退出
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      showMainWindow()
    } catch (err) {
      crashLog('second-instance', err)
    }
  })

  process.on('uncaughtException', (err) => {
    crashLog('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    crashLog('unhandledRejection', reason)
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('截图助手')
    }

    try {
      ensureCaptureDir()
      crashLog('startup', `pid=${process.pid} silent=${isSilentLaunch()} hwAccel=off`)
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

      app.on('render-process-gone', (_e, _wc, details) => {
        crashLog('render-process-gone', details)
      })
      app.on('child-process-gone', (_e, details) => {
        crashLog('child-process-gone', details)
      })
    } catch (err) {
      crashLog('whenReady', err)
    }
  })

  app.on('before-quit', () => {
    quitting = true
    cancelManualScroll()
  })

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll()
      destroyTray()
    } catch (err) {
      crashLog('will-quit', err)
    }
  })

  app.on('window-all-closed', () => {
    // 托盘常驻，不退出
  })
}
