import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import { imageSize } from "image-size";
import rateLimit from "express-rate-limit";

dotenv.config();

// ================= 1. CONFIGURATION =================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ================= 2. SECURITY & MIDDLEWARE =================

// Защита от спама и лишних трат OpenAI бюджета
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 30, // лимит 30 запросов на один IP
  message: { error: "Too many requests. Budget protection active." },
});

// Белый список доменов для CORS
const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked for origin: ${origin}`);
      callback(new Error("CORS policy violation"));
    }
  }
}));

app.use(express.json());
app.use("/api/", apiLimiter);

// Настройка Multer (лимит 5MB для защиты памяти)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } 
});

// ================= 3. CONSTANTS & HELPERS =================
const FALLBACK_CROP = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
const ALLOWED_BOARDS = [
  "Portugal Gift Ideas",
  "Portuguese Home Decor",
  "Lisbon Travel Gifts",
  "Azulejo Art"
];

const validateAIResponse = (data) => {
  if (typeof data.pinterest_title !== "string" || data.pinterest_title.length < 15)
    throw new Error("Invalid title from AI");

  if (typeof data.pinterest_description !== "string" || data.pinterest_description.length < 250 || data.pinterest_description.length > 850)
    throw new Error("Invalid description length");

  if (!Array.isArray(data.keywords) || data.keywords.length < 3 || data.keywords.length > 12)
    throw new Error("Invalid keywords array");

  if (!ALLOWED_BOARDS.includes(data.board))
    data.board = ALLOWED_BOARDS[0];

  if (!data.crop || typeof data.crop.x !== "number")
    data.crop = FALLBACK_CROP;

  return data;
};

// ================= 4. ENDPOINTS =================

// Проверка работоспособности
app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "v3.7.1-final-stable" });
});

// Эндпоинт №1: Анализ через OpenAI GPT-4o-mini
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    if (!req.file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Images only" });

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a Pinterest SEO Expert for VivaPortugal. 
          Return ONLY valid JSON. Title must start with primary keyword (<30 chars). 
          Description 500-800 characters. Commercial intent.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze for Pinterest SEO." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const validated = validateAIResponse(parsed);

    res.json(validated);
  } catch (err) {
    console.error("❌ AI Error:", err.message);
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// Эндпоинт №2: Кроп и загрузка в Cloudinary (Stream Mode)
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });
    if (!req.file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Invalid file type" });

    let dims;
    try {
      dims = imageSize(req.file.buffer);
    } catch {
      return res.status(400).json({ error: "Invalid image data" });
    }

    if (!dims?.width || !dims?.height)
      return res.status(400).json({ error: "Cannot read image dimensions" });

    let crop;
    try {
      const raw = JSON.parse(req.body.crop);
      if (typeof raw.x !== "number" || raw.width <= 0) throw new Error();
      crop = raw;
    } catch {
      crop = FALLBACK_CROP;
    }

    // Расчет координат с защитой от выхода за границы и NaN
    let x = Math.max(0, Math.min(dims.width - 1, Math.round(crop.x * dims.width)));
    let y = Math.max(0, Math.min(dims.height - 1, Math.round(crop.y * dims.height)));
    let w = Math.max(1, Math.min(dims.width - x, Math.round(crop.width * dims.width)));
    let h = Math.max(1, Math.min(dims.height - y, Math.round(crop.height * dims.height)));

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vivaportugal/v3_final",
        transformation: [
          { crop: "crop", x, y, width: w, height: h, gravity: "north_west" },
          { crop: "fill", width: 1000, height: 1500 },
        ],
      },
      (err, result) => {
        if (err) {
          console.error("❌ Cloudinary Error:", err);
          return res.status(500).json({ error: "Upload failed" });
        }
        res.json({
          ok: true,
          image: { pinterest_url: result.secure_url, public_id: result.public_id }
        });
      }
    );

    stream.end(req.file.buffer);
  } catch (err) {
    console.error("❌ Server Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Эндпоинт №3: Pinterest OAuth Callback (Safe Exchange)
app.get("/api/pinterest/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) return res.status(400).send("Missing authorization code.");

    // Используем URLSearchParams для безопасного application/x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", "https://vivaportugal-ai-backend.onrender.com/api/pinterest/callback");

    const tokenResponse = await axios.post(
      "https://api.pinterest.com/v5/oauth/token",
      params,
      {
        auth: {
          username: process.env.PINTEREST_APP_ID,
          password: process.env.PINTEREST_APP_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("🚀 ACCESS TOKEN RECEIVED:", tokenResponse.data.access_token);

    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1 style="color: #2ecc71;">Pinterest Connected!</h1>
        <p>Your account is successfully linked. You can close this window.</p>
        <button onclick="window.close()" style="background: #e60023; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">
          Return to App
        </button>
      </div>
    `);
    
  } catch (err) {
    console.error("❌ OAuth token error:", err.response?.data || err.message);
    res.status(500).send("Token exchange failed. Check server logs.");
  }
});

// ================= 5. GLOBAL ERROR HANDLING =================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large. Max 5MB." });
  }
  next(err);
});

// ================= 6. START SERVER =================
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`🚀 VivaPortugal AI Engine v3.7.1 running on port ${PORT}`);
});
