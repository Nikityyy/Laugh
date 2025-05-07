import express from "express";
import cors from "cors";
import helmet from "helmet";
import Groq from "groq-sdk";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "dotenv";
import rateLimit from "express-rate-limit";
// --- Gemini import ---
import { GoogleGenAI } from "@google/genai";

config();

const app = express();
const PORT = process.env.PORT || 3030;

// Replace constants with variables for API keys and reinitialize objects
let geminiApiKey = process.env.GEMINI_API_KEY;
let ai = new GoogleGenAI({ apiKey: geminiApiKey });

let groqApiKey = process.env.GROQ_API_KEY;
let groq = new Groq({ apiKey: groqApiKey });

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
    if (
      file.mimetype === "audio/webm" ||
      file.mimetype === "audio/ogg" ||
      file.mimetype === "audio/wav" ||
      file.mimetype === "audio/mpeg"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only audio files are allowed."));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
});

app.post("/start-recording-session", (req, res) => {
  res.status(200).json({ message: "Backend ready for audio." });
});

// --- Replace /transcribe endpoint with Gemini transcription ---
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ detail: "No audio file uploaded." });
  }

  const filePath = req.file.path;

  try {
    const audioBuffer = fs.readFileSync(filePath);

    const audioBase64 = audioBuffer.toString("base64");

    const config = {
      responseMimeType: "text/plain",
      systemInstruction: [
        {
          text: `You are an advanced transcription assistant designed to accurately and efficiently convert audio recordings into text. Focus on precision and clarity, ensuring that every detail is captured faithfully without adding extraneous commentary.`,
        },
      ],
    };

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-lite",
      config,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: req.file.mimetype,
                data: audioBase64,
              },
            },
          ],
        },
      ],
    });

    let transcriptText = "";
    if (response && response.text) {
      transcriptText = response.text;
    } else if (
      response &&
      response.candidates &&
      response.candidates[0]?.text
    ) {
      transcriptText = response.candidates[0].text;
    }

    res.status(200).json({ transcript: transcriptText });
  } catch (error) {
    res.status(500).json({ detail: "Failed to transcribe audio." });
  } finally {
    fs.unlink(filePath, (err) => {});
  }
});

app.post("/query-llm", async (req, res) => {
  const { conversationHistory } = req.body;

  if (
    !conversationHistory ||
    !Array.isArray(conversationHistory) ||
    conversationHistory.length === 0
  ) {
    return res.status(400).json({
      detail: "Conversation history is required and cannot be empty.",
    });
  }

  if (
    !conversationHistory.every(
      (msg) =>
        msg &&
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string"
    )
  ) {
    return res
      .status(400)
      .json({ detail: "Invalid conversation history format." });
  }

  const systemPromptContent = `
  You are Laugh, my in-class assistant. I provide audio transcriptions of my teacher's questions or statements *as they happen*.
  Your role is to help *me* quickly understand and formulate responses to the teacher.

  CRITICAL:
  1.  **LANGUAGE MATCH:** Respond *ONLY* in the same language as the transcribed input. If the transcript is in German, your answer *MUST* be in German. If the transcript is in English, your answer *MUST* be in English.
  2.  **DIRECT & FAST:** Provide the direct answer/information to the teacher's query from the transcript. Make it detailed and clear, but avoid unnecessary elaboration or context while ensuring the answer is complete and quite detailed.
  3.  **NO CHAT:** Omit ALL greetings, sign-offs, apologies, or conversational filler (e.g., "Okay," "Sure," "Here's..."). Go straight to the answer.
  4.  **UTILITY MARKDOWN:** Always use markdown for clarity (bold, italics, lists, etc.) to enhance readability. Use bullet points or numbered lists where appropriate.

  Assume I will use your output to help form *my own* spoken answer to the teacher. Focus solely on providing the core information.
  `;

  const messages = [
    { role: "system", content: systemPromptContent },
    ...conversationHistory,
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await groq.chat.completions.create({
      messages: messages,
      model: "gemma2-9b-it",
      temperature: 0.7,
      stream: true,
      stop: null,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
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
        error: "LLM processing failed.",
      })}\n\n`
    );
    if (res.flush) res.flush();
  } finally {
    res.end();
  }
});

// New endpoint: update API keys from UI
app.post("/update-api-keys", express.json(), (req, res) => {
  const { geminiKey, groqKey } = req.body;
  if (!geminiKey || !groqKey) {
    return res.status(400).json({ detail: "Both API keys are required." });
  }
  geminiApiKey = geminiKey;
  groqApiKey = groqKey;
  ai = new GoogleGenAI({ apiKey: geminiApiKey });
  groq = new Groq({ apiKey: groqApiKey });
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
