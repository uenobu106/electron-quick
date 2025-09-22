const { app, BrowserWindow, Tray, Menu, globalShortcut } = require("electron");
const path = require("path");

let win, tray;
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 400,
    height: 200,
    x: 100,
    y: 100,
    frame: true, // フレームを表示
    alwaysOnTop: true,
    transparent: false, // 透明を無効
    resizable: true,
    show: true, // 最初から表示
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  // デバッグ用
  console.log("ウィンドウが作成されました");

  win.loadFile(path.join(__dirname, "index.html"));

  console.log("URLを読み込みました");

  // エラーハンドリング
  win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error(
      "ページの読み込みに失敗しました:",
      errorCode,
      errorDescription
    );
  });

  win.webContents.on("did-finish-load", () => {
    console.log("ページの読み込みが完了しました");
  });

  // macOSの場合はデフォルトのアイコンを使用、Windowsの場合はicon.icoファイルを使用
  const iconPath = process.platform === "darwin" ? undefined : "./icon.ico";
  if (iconPath) {
    tray = new Tray(iconPath);
  } else {
    // macOSの場合は空のNativeImageを作成
    const { nativeImage } = require("electron");
    const emptyIcon = nativeImage.createEmpty();
    tray = new Tray(emptyIcon);
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "録音 (Ctrl+Space)",
        click: () => win.webContents.send("toggle-record"),
      },
      { type: "separator" },
      { label: "終了", click: () => app.quit() },
    ])
  );

  globalShortcut.register("Control+Space", () => {
    win.webContents.send("toggle-record");
  });
});
