const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let relayProcess;
let scraperProcess;

function createWindow() {
  // 1. Start Relay Server in background
  const relayPath = path.join(__dirname, 'relay', 'server.js');
  relayProcess = spawn('node', [relayPath], {
    stdio: 'inherit',
    env: { ...process.env, PORT: 8790 }
  });

  // 2. Start Autonomous Lead Scraper Worker in background
  const scraperPath = path.join(__dirname, 'extension', 'web', 'scraper-worker.js');
  scraperProcess = spawn('node', [scraperPath], {
    stdio: 'inherit',
    env: process.env
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    title: 'VS Code Portal & Zion Luxe — Native Desktop App',
    backgroundColor: '#0B0B0E',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load the Zion Luxe Unified Dashboard from local relay server
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:8790/zion.html');
  }, 1000);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (relayProcess) relayProcess.kill();
    if (scraperProcess) scraperProcess.kill();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (relayProcess) relayProcess.kill();
  if (scraperProcess) scraperProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
