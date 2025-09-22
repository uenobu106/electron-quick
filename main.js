const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

// Provider settings (uses Node 18+ fetch / FormData / Blob)
// ENV configuration:
//   STT_PROVIDER=openai|gemini           (default: openai)
//   LLM_PROVIDER=openai|gemini           (default: openai)
//   OPENAI_API_KEY=...                   (required for OpenAI calls)
//   OPENAI_BASE_URL=...                  (optional)
//   OPENAI_STT_MODEL=gpt-4o-mini-transcribe | gpt-4o-transcribe
//   OPENAI_FORMAT_MODEL=gpt-4o-mini | gpt-4o | ...
//   GEMINI_API_KEY=... or GOOGLE_API_KEY (required for Gemini calls)
//   GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
//   GEMINI_STT_MODEL=models/gemini-2.5-flash
//   GEMINI_LLM_MODEL=models/gemini-2.5-flash | models/gemini-2.5-pro
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe"; // default STT
const OPENAI_FORMAT_MODEL = process.env.OPENAI_FORMAT_MODEL || "gpt-4o-mini"; // default LLM

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL || "models/gemini-2.5-flash"; // accepts audio inputs
const GEMINI_LLM_MODEL = process.env.GEMINI_LLM_MODEL || "models/gemini-2.5-flash";

// Provider selection (default to openai)
const STT_PROVIDER = (process.env.STT_PROVIDER || "openai").toLowerCase(); // openai | gemini
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase(); // openai | gemini

let win, tray;
app.whenReady().then(() => {
  // Resolve app icon path for Windows to avoid relative path issues and mojibake in console
  const resolveAssetPath = (...paths) => {
    return app.isPackaged
      ? path.join(process.resourcesPath, ...paths)
      : path.join(__dirname, ...paths);
  };
  const windowsIconPath = process.platform === "win32" ? resolveAssetPath("icon.ico") : undefined;

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
    icon: windowsIconPath,
  });
  // Debug logs (ASCII only to avoid mojibake on non-UTF8 consoles)
  console.log("Window created");

  win.loadFile(path.join(__dirname, "index.html"));

  console.log("Loaded index.html");

  // Error handling (ASCII-only console messages)
  win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    console.error("Failed to load page:", errorCode, String(errorDescription || ""));
  });

  win.webContents.on("did-finish-load", () => {
    console.log("Page load finished");
  });

  // Tray icon: use resolved absolute path on Windows, empty icon on macOS if not provided
  if (process.platform === "win32") {
    const trayIconPath = windowsIconPath;
    if (fs.existsSync(trayIconPath)) {
      tray = new Tray(trayIconPath);
    } else {
      console.warn("Tray icon not found:", trayIconPath);
      tray = new Tray(nativeImage.createEmpty());
    }
  } else {
    tray = new Tray(nativeImage.createEmpty());
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

// Global process-level error handlers: keep console output ASCII-only
process.on("uncaughtException", (error) => {
  try {
    console.error("uncaughtException:", String(error && error.message ? error.message : error));
  } catch {
    console.error("uncaughtException: <non-string error>");
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    console.error("unhandledRejection:", String(reason && reason.message ? reason.message : reason));
  } catch {
    console.error("unhandledRejection: <non-string reason>");
  }
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
    if (finalizedPath) {
      try {
        const transcription = STT_PROVIDER === "gemini"
          ? await transcribeWithGemini(finalizedPath, currentMimeType || "audio/webm")
          : await transcribeWithOpenAI(finalizedPath, currentMimeType || "audio/webm");

        const formatted = LLM_PROVIDER === "gemini"
          ? await formatWithGemini(transcription)
          : await formatWithOpenAI(transcription);
        if (win && !win.isDestroyed()) {
          win.webContents.send("recording:result", { filePath: finalizedPath, text: formatted, raw: transcription });
        }
      } catch (err) {
        console.error("Transcription/formatting failed", err);
        if (win && !win.isDestroyed()) {
          win.webContents.send("recording:result", { filePath: finalizedPath, error: String(err) });
        }
      }
    } else if (win && !win.isDestroyed()) {
      win.webContents.send("recording:result", { filePath: finalizedPath, info: "No file to transcribe." });
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
  form.append("model", OPENAI_STT_MODEL);
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

async function formatWithOpenAI(transcribedText) {
  const system = "あなたは有能な秘書です。ユーザーの口語の発話を書き言葉に整え、箇条書きや段落で読みやすく要点化します。不要なフィラー（えー、あのー等）は除去し、事実を変えない範囲で語尾と文法を整えます。日本語で出力してください。";
  const user = `元の文字起こし:\n${transcribedText}\n\n出力条件:\n- 誤認識は文脈で軽微に補正\n- 箇条書きが適切なら使う\n- 重要タスクはTODOとして明示`;

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_FORMAT_MODEL,
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

async function transcribeWithGemini(filePath, mimeType) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const buffer = fs.readFileSync(filePath);
  // Gemini 2.5 Flash: multimodal content API (JSON)
  const base64 = buffer.toString("base64");
  const url = `${GEMINI_BASE_URL}/${GEMINI_STT_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "次の音声を日本語で文字起こししてください。句読点を適切に付与してください。" },
          {
            inline_data: {
              mime_type: mimeType || "audio/webm",
              data: base64,
            },
          },
        ],
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini STT error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("")?.trim();
  return text || "";
}

async function formatWithGemini(transcribedText) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const url = `${GEMINI_BASE_URL}/${GEMINI_LLM_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const system = "あなたは有能な秘書です。口語の発話を日本語の書き言葉に整え、要点を箇条書きや段落で整理します。フィラーは除去し、事実を変えない範囲で文法と語尾を整えます。";
  const user = `元の文字起こし:\n${transcribedText}\n\n出力条件:\n- 誤認識は文脈で軽微に補正\n- 箇条書きが適切なら使う\n- 重要タスクはTODOとして明示`;
  const body = {
    contents: [
      { role: "user", parts: [{ text: system + "\n\n" + user }] },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini LLM error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("")?.trim();
  return text || transcribedText;
}
