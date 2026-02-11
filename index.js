import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";
import sizeOf from "image-size";

dotenv.config();

// ================= CLOUDINARY CONFIG =================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ================= APP SETUP =================

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));
app.use(express.json());

// ================= OPENAI CLIENT =================

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================= STRATEGIC SYSTEM PROMPT (SEO ULTIMATE) =================

const SYSTEM_PROMPT = `
You are a Pinterest SEO expert for VivaPortugal. Your mission is to generate content that ranks and converts.

Return ONLY a valid JSON object.

CRITICAL RULES FOR CONTENT:
1. **Prioritize search intent over creativity.**
2. **Titles:** Must START with the primary keyword.
3. **Keyword Placement:** The primary keyword MUST appear within the first 40 characters of the title.
4. **Forbidden Phrases:** Strictly avoid vague words like "explore", "discover", "celebrate".
5. **Tone:** Use commercial and buyer-intent phrasing (e.g., "Wall art", "Gift ideas", "Souvenir").
6. **Description:** 500-800 characters, natural SEO-rich paragraph. NO hashtags.
7. **Keywords:** 5-8 high-intent phrases (no single words).
8. **Board:** Choose from: Azulejo Dreams, Porto Collection, Lisbon Art, Portugal Gift Ideas, Portuguese Icons, Galo de Barcelos, Ocean Life, Minimalist Portugal, Douro Valley, Wine Collection.
9. **Crop:** Relative values (0-1).

JSON Schema:
{
  "pinterest_title": string,
  "pinterest_description": string,
  "keywords": string[],
  "board": string,
  "crop": { "x": number, "y": number, "width": number, "height": number }
}
`;

// ================= UTILS =================

function normalizeCrop(crop) {
  if (!crop) return { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
  const { x, y, width, height } = crop;

  if (
    x >= 0 && x <= 1 &&
    y >= 0 && y <= 1 &&
    width > 0 && width <= 1 &&
    height > 0 && height <= 1
  ) {
    return crop;
  }
  return { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
}

// ================= ENDPOINTS =================

app.get("/api/health", (req, res) => {
  res.json({ ok: true, status: "Backend is running" });
});

// Эндпоинт №1: Анализ (OpenAI)
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image for high-intent Pinterest SEO." },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
    });

    let text = response.choices[0].message.content.trim();
    if (text.startsWith("```")) {
      text = text.replace(/```json|```/g, "").trim();
    }

    const parsed = JSON.parse(text);
    parsed.crop = normalizeCrop(parsed.crop);

    res.json(parsed);
  } catch (err) {
    console.error("❌ AI ERROR:", err);
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// Эндпоинт №2: Загрузка и Кроп (Cloudinary)
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const cropRaw = req.body.crop;
    if (!cropRaw) return res.status(400).json({ error: "Missing crop data" });

    let crop = JSON.parse(cropRaw);

    const dims = sizeOf(req.file.buffer);
    const imgW = dims.width;
    const imgH = dims.height;

    const x = Math.max(0, Math.round(crop.x * imgW));
    const y = Math.max(0, Math.round(crop.y * imgH));
    const w = Math.max(1, Math.round(crop.width * imgW));
    const h = Math.max(1, Math.round(crop.height * imgH));

    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    const uploaded = await cloudinary.uploader.upload(dataUri, {
      folder: "vivaportugal/original",
      resource_type: "image",
    });

    const pinterestUrl = cloudinary.url(uploaded.public_id, {
      secure: true,
      transformation: [
        { crop: "crop", x, y, width: w, height: h, gravity: "north_west" },
        { crop: "fill", width: 1000, height: 1500 },
      ],
    });

    return res.json({
      ok: true,
      image: {
        public_id: uploaded.public_id,
        original_url: uploaded.secure_url,
        pinterest_url: pinterestUrl,
        original_width: imgW,
        original_height: imgH,
        crop_px: { x, y, width: w, height: h },
      },
    });
  } catch (err) {
    console.error("❌ /api/upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ================= START SERVER =================

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
