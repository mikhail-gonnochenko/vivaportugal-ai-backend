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

// ================= CONFIG =================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.set("trust proxy", 1); // Обязательно для корректной работы rate-limit на Render

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 8787;

// ================= CONSTANTS =================

const FALLBACK_CROP = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

const ALLOWED_BOARDS = [
  "Portugal Gift Ideas",
  "Portuguese Home Decor",
  "Lisbon Travel Gifts",
  "Azulejo Art"
];

// ================= SECURITY =================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests" }
});

app.use("/api/", apiLimiter);

const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS blocked"));
    }
  }
}));

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ================= HEALTH =================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "v5-production" });
});

// ================= PINTEREST OAUTH =================

app.get("/api/pinterest/auth", (req, res) => {
  const CLIENT_ID = process.env.PINTEREST_APP_ID;
  const REDIRECT_URI = encodeURIComponent(process.env.PINTEREST_REDIRECT_URI);
  const scope = "pins:read,pins:write,boards:read,boards:write";

  const authUrl = `https://www.pinterest.com/oauth/?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${scope}`;
  res.redirect(authUrl);
});

app.get("/api/pinterest/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", process.env.PINTEREST_REDIRECT_URI);

    const response = await axios.post(
      "https://api.pinterest.com/v5/oauth/token",
      params,
      {
        auth: {
          username: process.env.PINTEREST_APP_ID,
          password: process.env.PINTEREST_APP_SECRET
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const { access_token, refresh_token } = response.data;

    res.redirect(
      `${process.env.FRONTEND_URL}?access=${access_token}&refresh=${refresh_token}`
    );
  } catch (err) {
    console.error("❌ OAuth error:", err.response?.data || err.message);
    res.status(500).json({ error: "OAuth failed" });
  }
});

app.post("/api/pinterest/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: "Missing refresh token" });
    }

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refresh_token);

    const response = await axios.post(
      "https://api.pinterest.com/v5/oauth/token",
      params,
      {
        auth: {
          username: process.env.PINTEREST_APP_ID,
          password: process.env.PINTEREST_APP_SECRET
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    res.json({
      ok: true,
      access_token: response.data.access_token
    });
  } catch (err) {
    console.error("❌ Refresh error:", err.response?.data || err.message);
    res.status(500).json({ error: "Refresh failed" });
  }
});

// ================= AI ANALYZE =================

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });
    if (!req.file.mimetype.startsWith("image/"))
      return res.status(400).json({ error: "Invalid file type" });

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a Pinterest SEO expert. Return JSON with: pinterest_title, pinterest_description, keywords, board, crop. Title must start with primary keyword. Commercial buyer intent. Boards allowed: ${ALLOWED_BOARDS.join(", ")}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Generate Pinterest SEO." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
          ]
        }
      ]
    });

    let data = JSON.parse(response.choices[0].message.content);
    if (!ALLOWED_BOARDS.includes(data.board)) data.board = ALLOWED_BOARDS[0];
    if (!data.crop || typeof data.crop.x !== "number") data.crop = FALLBACK_CROP;

    res.json(data);
  } catch (err) {
    console.error("❌ AI Error:", err.message);
    res.status(500).json({ error: "AI failed" });
  }
});

// ================= CLOUDINARY UPLOAD =================

app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image" });

    const dims = imageSize(req.file.buffer);
    if (!dims?.width || !dims?.height)
      return res.status(400).json({ error: "Invalid image" });

    let crop;
    try {
      crop = JSON.parse(req.body.crop);
    } catch {
      crop = FALLBACK_CROP;
    }

    const x = Math.max(0, Math.round(crop.x * dims.width));
    const y = Math.max(0, Math.round(crop.y * dims.height));
    const w = Math.max(1, Math.round(crop.width * dims.width));
    const h = Math.max(1, Math.round(crop.height * dims.height));

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vivaportugal/v5",
        transformation: [
          { crop: "crop", x, y, width: w, height: h, gravity: "north_west" },
          { crop: "fill", width: 1000, height: 1500 }
        ]
      },
      (err, result) => {
        if (err) return res.status(500).json({ error: "Upload failed" });
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
    res.status(500).json({ error: "Upload error" });
  }
});

// ================= BOARDS =================

app.get("/api/pinterest/boards", async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const response = await axios.get(
      "https://api.pinterest.com/v5/boards",
      { headers: { Authorization: token } }
    );

    const boards = response.data.items.map(b => ({ id: b.id, name: b.name }));
    res.json({ ok: true, boards });
  } catch (err) {
    console.error("❌ Boards error:", err.response?.data || err.message);
    res.status(500).json({ error: "Boards fetch failed" });
  }
});

// ================= CREATE PIN =================

app.post("/api/pinterest/pins", async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const { title, description, image_url, board_id, link } = req.body;

    const response = await axios.post(
      "https://api.pinterest.com/v5/pins",
      {
        title,
        description,
        board_id,
        link,
        media_source: {
          source_type: "image_url",
          url: image_url
        }
      },
      { headers: { Authorization: token } }
    );

    res.json({ ok: true, id: response.data.id });
  } catch (err) {
    console.error("❌ Pin error:", err.response?.data || err.message);
    res.status(500).json({ error: "Pin failed", details: err.response?.data });
  }
});

// ================= START =================

app.listen(PORT, () => {
  console.log(`🚀 VivaPortugal AI v5 running on port ${PORT}`);
});
