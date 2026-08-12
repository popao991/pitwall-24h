const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pitwallApi', {
  startServer: () => ipcRenderer.invoke('start-server'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  backupNow: () => ipcRenderer.invoke('backup-now'),
  restoreBackup: name => ipcRenderer.invoke('restore-backup', name)
});
