import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "dotenv";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

config();

const app = express();
const PORT = process.env.PORT || 3030;

let geminiApiKey = process.env.GEMINI_API_KEY;
let ai = new GoogleGenAI({ apiKey: geminiApiKey });

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "http://localhost:*"],
        imgSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
  })
);
app.disable("x-powered-by");
app.use(
  cors({
    origin: [/^http:\/\/localhost(:\d+)?$/],
    credentials: false,
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { detail: "Too many requests, please try again later." },
});
app.use(limiter);

// Create a temporary directory for uploads if it doesn't exist
const tempUploadDir = path.join(os.tmpdir(), "laugh-app-uploads");
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempUploadDir);
  },
  filename: (req, file, cb) => {
    const safeName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "audio/webm") {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only webm files are allowed."));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
});

app.post("/start-recording-session", (req, res) => {
  res.status(200).json({ message: "Backend ready for audio." });
});

app.post("/query-llm", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: "No audio file uploaded." });
  }

  const filePath = req.file.path;

  try {
    const audioBuffer = fs.readFileSync(filePath);
    const audioBase64 = audioBuffer.toString("base64");

    const systemPromptContent = `
  You are Laugh, my in-class assistant. I provide an audio file of my teacher's questions or statements *as they happen*.
  Your role is to help *me* quickly understand and formulate responses to the teacher.

  CRITICAL:
  1.  **LANGUAGE MATCH:** Respond *ONLY* in the same language as the audio input. If the audio is in German, your answer *MUST* be in German. If the audio is in English, your answer *MUST* be in English.
  2.  **DIRECT & FAST:** Provide the direct answer/information to the teacher's query from the audio. Make it detailed and clear, but avoid unnecessary elaboration or context while ensuring the answer is complete and quite detailed.
  3.  **NO CHAT:** Omit ALL greetings, sign-offs, apologies, or conversational filler (e.g., "Okay," "Sure," "Here's..."). Go straight to the answer.
  4.  **UTILITY MARKDOWN:** Always use markdown for clarity (bold, italics, lists, etc.) to enhance readability. Use bullet points or numbered lists where appropriate.

  Assume I will use your output to help form *my own* spoken answer to the teacher. Focus solely on providing the core information.
  `;

    let convHistory = [];
    if (req.body.conversationHistory) {
      try {
        convHistory = JSON.parse(req.body.conversationHistory);
      } catch (err) {
        console.error("Failed to parse conversationHistory:", err);
      }
    }

    const contents = [
      { role: "model", parts: [{ text: systemPromptContent }] },
    ];
    convHistory.forEach((msg) => {
      if (
        msg.role === "assistant" ? (msg.role = "model") : (msg.role = "user")
      );
      contents.push({ role: msg.role, parts: [{ text: msg.content }] });
    });
    contents.push({
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: req.file.mimetype,
            data: audioBase64,
          },
        },
      ],
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const config = {
        responseMimeType: "text/plain",
        thinkingConfig: {
          includeThoughts: false,
        },
      };
      const model = "gemini-2.5-flash-preview-04-17";

      const stream = await ai.models.generateContentStream({
        model,
        config,
        contents,
      });

      for await (const chunk of stream) {
        const content = chunk.text || "";
        if (content) {
          res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
          if (res.flush) res.flush();
        }
      }
      res.write(`data: ${JSON.stringify({ event: "done" })}\n\n`);
      if (res.flush) res.flush();
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({
          error: error.message || "LLM processing failed.",
        })}\n\n`
      );
      if (res.flush) res.flush();
    } finally {
      res.end();
    }
  } catch (error) {
    res.status(500).json({ detail: "Audio processing failed." });
  }
});

app.post("/update-api-keys", express.json(), (req, res) => {
  const { geminiKey } = req.body;
  if (!geminiKey) {
    return res.status(400).json({ detail: "Both API keys are required." });
  }
  geminiApiKey = geminiKey;
  ai = new GoogleGenAI({ apiKey: geminiApiKey });
  res.status(200).json({ detail: "API keys updated successfully." });
});

app
  .listen(PORT, () => {
    if (process.send) {
      process.send("server-ready");
    }
  })
  .on("error", (err) => {
    console.error(`Server failed to start on port ${PORT}:`, err);
    process.exit(1);
  });

function cleanUpTemp() {
  if (fs.existsSync(tempUploadDir)) {
    fs.rm(tempUploadDir, { recursive: true, force: true }, (err) => {});
  }
}
process.on("exit", cleanUpTemp);
process.on("SIGINT", () => {
  process.exit(0);
});

app.use((err, req, res, next) => {
  res.status(500).json({ detail: "Internal server error." });
});
