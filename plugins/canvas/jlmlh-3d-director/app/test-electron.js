// test-electron.js
// 测试Electron配置是否正确

const { app, BrowserWindow } = require('electron');
const path = require('path');

console.log('Electron版本:', process.versions.electron);
console.log('Chrome版本:', process.versions.chrome);
console.log('Node版本:', process.versions.node);
console.log('平台:', process.platform);

// 测试创建窗口
app.whenReady().then(() => {
  console.log('Electron已就绪');

  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
  });

  // 加载测试页面
  mainWindow.loadFile(path.join(__dirname, 'dist/index.html'))
    .then(() => {
      console.log('✓ 页面加载成功');
      app.quit();
    })
    .catch((err) => {
      console.error('✗ 页面加载失败:', err.message);
      app.quit();
    });
});

app.on('window-all-closed', () => {
  app.quit();
});
