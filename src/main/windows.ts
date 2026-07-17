import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { appIconPath } from './icons'

function preloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`)
}

function rendererPage(isDev: boolean, page: string): string {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/${page}.html`
  }
  return join(__dirname, `../renderer/${page}.html`)
}

export function createMainWindow(
  isDev: boolean,
  opts: { silent?: boolean } = {}
): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 540,
    show: false,
    resizable: false,
    title: '截图助手',
    icon: appIconPath(),
    backgroundColor: '#1a1512',
    webPreferences: {
      preload: preloadPath('index'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)
  // 开机静默启动：只挂托盘，不弹出主窗口
  if (!opts.silent) {
    win.on('ready-to-show', () => win.show())
  }
  void win.loadURL(rendererPage(isDev, 'index'))
  return win
}

export function createOverlayWindow(isDev: boolean): BrowserWindow {
  const primary = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow({
    x: primary.x,
    y: primary.y,
    width: primary.width,
    height: primary.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('overlay'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setIgnoreMouseEvents(false)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void win.loadURL(rendererPage(isDev, 'overlay'))
  return win
}

export function createScrollBarWindow(
  isDev: boolean,
  anchor?: { x: number; y: number }
): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea
  const width = 360
  const height = 52
  // 默认贴在选区附近；没有锚点则靠屏幕底部
  let x = display.x + Math.floor((display.width - width) / 2)
  let y = display.y + display.height - height - 24
  if (anchor) {
    x = Math.min(Math.max(display.x, Math.round(anchor.x)), display.x + display.width - width)
    y = Math.min(Math.max(display.y, Math.round(anchor.y)), display.y + display.height - height)
  }

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // 不抢焦点，方便用户立刻用滚轮滚下面的窗口
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('scroll-bar'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void win.loadURL(rendererPage(isDev, 'scroll-bar'))
  return win
}

export function createPinWindow(
  isDev: boolean,
  opts: { filePath: string; width: number; height: number }
): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1
  // 截图像素 → DIP，保证贴图与屏幕上观感 1:1
  const dipW = Math.round(opts.width / scaleFactor)
  const dipH = Math.round(opts.height / scaleFactor)
  const width = Math.max(120, Math.min(dipW, display.width))
  const height = Math.max(120, Math.min(dipH, display.height))

  const win = new BrowserWindow({
    width,
    height,
    x: display.x + Math.max(0, Math.floor((display.width - width) / 2)),
    y: display.y + Math.max(0, Math.floor((display.height - height) / 2)),
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: '贴图',
    backgroundColor: '#1e1e1e',
    useContentSize: true,
    webPreferences: {
      preload: preloadPath('pin'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)
  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  const page = rendererPage(isDev, 'pin')
  const url = `${page}?src=${encodeURIComponent(opts.filePath)}&w=${opts.width}&h=${opts.height}`
  void win.loadURL(url)
  return win
}
