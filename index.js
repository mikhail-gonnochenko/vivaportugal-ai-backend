import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ================= APP SETUP =================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: "*" }));

app.get("/", (req, res) => {
  res.send("VivaPortugal backend OK");
});

// ================= ENV CHECK =================
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing");
}

// ================= OPENAI CLIENT =================
const client = new OpenAI({
  apiKey: API_KEY,
});

// ================= SYSTEM PROMPT =================
const SYSTEM_PROMPT = `
You are VivaPortugal AI — a strict Pinterest SEO assistant
for a Portuguese cultural gift brand.

Return ONLY ONE valid JSON object.
NO explanations. NO markdown. NO extra fields.

The JSON MUST follow this structure exactly:

{
  "pinterest_title": string,
  "pinterest_description": string,
  "board": string,
  "crop": {
    "x": number,
    "y": number,
    "width": number,
    "height": number
  }
}

Rules:
- crop values MUST be between 0 and 1
- ALWAYS include crop
- crop must be vertical (Pinterest-friendly)
- NO missing fields
`;

// ================= HEALTH =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ================= ANALYZE =================
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze the image." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      temperature: 0.2,
    });

    const text = response.choices?.[0]?.message?.content;

    if (!text) {
      console.error("❌ Empty AI response", response);
      return res.status(500).json({ error: "Empty AI response" });
    }

    const clean = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error("❌ JSON parse error:", clean);
      return res.status(500).json({ error: "Invalid JSON from AI" });
    }

    // ===== HARD VALIDATION =====
    if (
      !parsed.crop ||
      typeof parsed.crop.x !== "number" ||
      typeof parsed.crop.y !== "number" ||
      typeof parsed.crop.width !== "number" ||
      typeof parsed.crop.height !== "number"
    ) {
      return res.status(500).json({
        error: "AI response missing crop",
        raw: parsed,
      });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("❌ AI ERROR:", err);
    return res.status(500).json({ error: "AI analysis failed" });
  }
});

// ================= START =================
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
