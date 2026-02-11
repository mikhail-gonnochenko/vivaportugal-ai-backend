import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import { imageSize } from "image-size";
import rateLimit from "express-rate-limit";

dotenv.config();

// ================= CLOUDINARY CONFIG =================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ================= APP INIT =================
const app = express();

// ================= SECURITY =================

// Rate limit (budget protection)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many requests. Budget protection active." },
});
app.use("/api/", apiLimiter);

// CORS whitelist
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

// ================= MULTER =================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// ================= OPENAI =================
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ================= CONSTANTS =================
const FALLBACK_CROP = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

const ALLOWED_BOARDS = [
  "Portugal Gift Ideas",
  "Portuguese Home Decor",
  "Lisbon Travel Gifts",
  "Azulejo Art"
];

// ================= VALIDATION =================
const validateAIResponse = (data) => {
  if (typeof data.pinterest_title !== "string" || data.pinterest_title.length < 15)
    throw new Error("Invalid title");

  if (
    typeof data.pinterest_description !== "string" ||
    data.pinterest_description.length < 250 ||
    data.pinterest_description.length > 850
  )
    throw new Error("Invalid description length");

  if (!Array.isArray(data.keywords) || data.keywords.length < 3 || data.keywords.length > 12)
    throw new Error("Invalid keywords");

  if (!ALLOWED_BOARDS.includes(data.board))
    data.board = ALLOWED_BOARDS[0];

  if (
    !data.crop ||
    typeof data.crop.x !== "number" ||
    typeof data.crop.y !== "number" ||
    typeof data.crop.width !== "number" ||
    typeof data.crop.height !== "number"
  ) {
    data.crop = FALLBACK_CROP;
  }

  return data;
};

// ================= HEALTH =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "v3.6-final-stable" });
});

// ================= ANALYZE =================
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No image uploaded" });

    if (!req.file.mimetype.startsWith("image/"))
      return res.status(400).json({ error: "Images only" });

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a Pinterest SEO Expert for VivaPortugal.

Return ONLY valid JSON:
{
  "pinterest_title": string,
  "pinterest_description": string,
  "keywords": string[],
  "board": string,
  "crop": { "x": number, "y": number, "width": number, "height": number }
}

Rules:
- Title must start with primary keyword (within first 30 chars).
- Description 500-800 characters.
- 3-5 keyword phrases naturally included.
- Commercial buyer intent only.
          `
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

// ================= UPLOAD =================
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No image uploaded" });

    if (!req.file.mimetype.startsWith("image/"))
      return res.status(400).json({ error: "Invalid file type" });

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
      if (
        typeof raw.x !== "number" ||
        typeof raw.y !== "number" ||
        typeof raw.width !== "number" ||
        typeof raw.height !== "number" ||
        raw.width <= 0 ||
        raw.height <= 0
      ) {
        throw new Error();
      }
      crop = raw;
    } catch {
      crop = FALLBACK_CROP;
    }

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
          image: {
            pinterest_url: result.secure_url,
            public_id: result.public_id
          }
        });
      }
    );

    stream.end(req.file.buffer);

  } catch (err) {
    console.error("❌ Server Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ================= MULTER ERROR HANDLER =================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large. Max 5MB." });
  }
  next(err);
});

// ================= START =================
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`🚀 VivaPortugal AI Engine running on port ${PORT}`);
});
