import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pinApi', {
  close: () => ipcRenderer.invoke('pin:close'),
  saveAs: (filePath: string) => ipcRenderer.invoke('pin:save-as', filePath),
  copy: (filePath: string) => ipcRenderer.invoke('pin:copy', filePath)
})
