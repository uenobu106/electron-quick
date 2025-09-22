const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// OpenAI settings (uses Node 18+ fetch / FormData / Blob)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

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

// Recording IPC: receive chunks from renderer and write to file
let currentWriteStream = null;
let currentFilePath = null;
let currentMimeType = null;

function getOutputDir() {
  const base = app.getPath("music");
  const dir = path.join(base, "Recordings");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFilePath(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(getOutputDir(), `rec_${ts}${ext}`);
}

ipcMain.handle("recording:start", (_e, { mimeType }) => {
  try {
    currentMimeType = mimeType || "audio/webm";
    const ext = currentMimeType.includes("webm") ? ".webm" : currentMimeType.includes("wav") ? ".wav" : ".dat";
    currentFilePath = makeFilePath(ext);
    currentWriteStream = fs.createWriteStream(currentFilePath);
    return { ok: true, filePath: currentFilePath };
  } catch (err) {
    console.error("recording:start error", err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.on("recording:data", (_e, chunk) => {
  if (currentWriteStream && chunk) {
    try {
      currentWriteStream.write(Buffer.from(chunk));
    } catch (err) {
      console.error("recording:data write error", err);
    }
  }
});

ipcMain.handle("recording:stop", async () => {
  try {
    if (currentWriteStream) {
      await new Promise((resolve) => currentWriteStream.end(resolve));
    }
    const finalizedPath = currentFilePath;
    currentWriteStream = null;
    currentFilePath = null;

    // If API key is set, run STT + LLM formatting
    if (OPENAI_API_KEY && finalizedPath) {
      try {
        const transcription = await transcribeWithOpenAI(finalizedPath, currentMimeType || "audio/webm");
        const formatted = await formatWithLLM(transcription);
        if (win && !win.isDestroyed()) {
          win.webContents.send("recording:result", { filePath: finalizedPath, text: formatted, raw: transcription });
        }
      } catch (err) {
        console.error("Transcription/formatting failed", err);
        if (win && !win.isDestroyed()) {
          win.webContents.send("recording:result", { filePath: finalizedPath, error: String(err) });
        }
      }
    } else if (win && !win.isDestroyed() && finalizedPath) {
      win.webContents.send("recording:result", { filePath: finalizedPath, info: "OPENAI_API_KEY not set. Skipped transcription." });
    }

    return { ok: true, filePath: finalizedPath };
  } catch (err) {
    console.error("recording:stop error", err);
    return { ok: false, error: String(err) };
  }
});

async function transcribeWithOpenAI(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: mimeType || "audio/webm" });
  const form = new FormData();
  form.append("file", blob, filePath.split(path.sep).pop());
  form.append("model", "whisper-1");
  // You can set language hints if needed: form.append("language", "ja");

  const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.text || "";
}

async function formatWithLLM(transcribedText) {
  const system = "あなたは有能な秘書です。ユーザーの口語の発話を書き言葉に整え、箇条書きや段落で読みやすく要点化します。不要なフィラー（えー、あのー等）は除去し、事実を変えない範囲で語尾と文法を整えます。日本語で出力してください。";
  const user = `元の文字起こし:\n${transcribedText}\n\n出力条件:\n- 誤認識は文脈で軽微に補正\n- 箇条書きが適切なら使う\n- 重要タスクはTODOとして明示`;

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_FORMAT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Chat API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || transcribedText;
}
