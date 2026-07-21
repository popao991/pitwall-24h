const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pitwallApi', {
  startServer: () => ipcRenderer.invoke('start-server'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkUpdates: () => ipcRenderer.invoke('check-updates')
});
