import { Menu, Tray } from 'electron'
import { loadTrayIcon } from './icons'

let tray: Tray | null = null

export type TrayActions = {
  capture: () => void
  fullscreen: () => void
  showMain: () => void
  openDir: () => void
  quit: () => void
}

export function createTray(actions: TrayActions): Tray {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }

  tray = new Tray(loadTrayIcon())
  tray.setToolTip('截图助手')

  const menu = Menu.buildFromTemplate([
    {
      label: '截图（区域 / 长截图）',
      accelerator: 'F1',
      click: () => actions.capture()
    },
    {
      label: '全屏截图',
      accelerator: 'F2',
      click: () => actions.fullscreen()
    },
    { type: 'separator' },
    {
      label: '显示主窗口',
      click: () => actions.showMain()
    },
    {
      label: '打开保存目录',
      click: () => actions.openDir()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => actions.quit()
    }
  ])

  tray.setContextMenu(menu)
  tray.on('double-click', () => actions.showMain())
  tray.on('click', () => {
    if (process.platform === 'win32') {
      tray?.popUpContextMenu()
    }
  })

  return tray
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
}
