const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

function getServerScript() {
  return path.join(__dirname, '..', 'server', 'index.js');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverScript = getServerScript();
    if (!fs.existsSync(serverScript)) {
      return reject(new Error(`Server script not found: ${serverScript}`));
    }

    const env = {
      ...process.env,
      ELECTRON_RUN: '1',
      ELECTRON_USER_DATA: app.getPath('userData'),
      ELECTRON_APP_ROOT: path.join(__dirname, '..'),
      ELECTRON_RESOURCES: process.resourcesPath,
      PORT: '0', // random available port
    };

    serverProcess = fork(serverScript, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--experimental-vm-modules'],
    });

    let portResolved = false;
    const timeout = setTimeout(() => {
      if (!portResolved) {
        portResolved = true;
        reject(new Error('Server failed to start within 10 seconds'));
      }
    }, 10000);

    serverProcess.on('message', (msg) => {
      if (msg?.type === 'server-ready' && msg.port && !portResolved) {
        portResolved = true;
        clearTimeout(timeout);
        resolve(msg.port);
      }
    });

    serverProcess.on('error', (err) => {
      if (!portResolved) {
        portResolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    serverProcess.on('exit', (code) => {
      if (!portResolved) {
        portResolved = true;
        clearTimeout(timeout);
        reject(new Error(`Server process exited with code ${code}`));
      }
    });

    // Log server stdout/stderr for debugging
    serverProcess.stdout?.on('data', (data) => {
      console.log('[server]', data.toString().trim());
    });
    serverProcess.stderr?.on('data', (data) => {
      console.error('[server]', data.toString().trim());
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'URGR - Ultimate Retro Game Room',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers for native dialogs
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [],
  });
  return result.canceled ? null : result.filePaths[0];
});

// App lifecycle
app.whenReady().then(async () => {
  try {
    console.log('[electron] Starting server...');
    serverPort = await startServer();
    console.log(`[electron] Server running on port ${serverPort}`);
    createWindow();
  } catch (err) {
    console.error('[electron] Failed to start server:', err);
    dialog.showErrorBox('Server Error', `Failed to start the server:\n${err.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // macOS: keep app running in dock until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
