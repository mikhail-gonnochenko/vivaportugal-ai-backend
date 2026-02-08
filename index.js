import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ================= APP SETUP =================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// CORS (можно сузить origin позже до твоего домена фронта)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

// Чтобы Render не пугал "Cannot GET /"
app.get("/", (req, res) => {
  res.send("VivaPortugal backend OK");
});

// ================= ENV CHECK =================
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing. Set it in Render -> Environment.");
}

// ================= OPENAI CLIENT =================
const client = new OpenAI({ apiKey: API_KEY });

// ================= SYSTEM PROMPT =================
const SYSTEM_PROMPT = `
You are VivaPortugal AI — a strict Pinterest SEO assistant for a Portuguese cultural gift brand.

Your task:
Analyze the provided image and return ONE valid JSON object only.
No explanations. No comments. No markdown. No extra text.

The JSON must strictly follow this schema:

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

1. Pinterest title:
- Max 100 characters
- SEO optimized
- Must include at least ONE keyword when relevant:
  portugal, azulejo, porto, lisbon, portuguese gifts

2. Pinterest description:
- 2–3 sentences
- SEO friendly
- Written for tourists, diaspora, and gift buyers
- Emphasize authenticity and Portuguese culture
- NO hashtags

3. Board selection:
Choose EXACTLY ONE board from this list:
- Azulejo Dreams
- Porto Collection – City Art & Coordinates
- Lisbon Art & Souvenirs
- Portugal Gift Ideas
- Portuguese Icons
- Galo de Barcelos Collection
- Portugal Souvenirs & Gifts
- Ocean Life & Algarve
- Minimalist Portugal Prints
- Douro Valley Travel
- Portugal Wine Collection
- Serra da Estrela

Return ONLY ONE board name exactly as written.

4. Crop:
- You MUST return RELATIVE values between 0 and 1
- NEVER return pixel values
- If any crop value is greater than 1, the response is INVALID
- Correct example:
  { "x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9 }
- Crop must be vertical and Pinterest-friendly
- Focus on the main subject

5. Output:
- JSON only
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

  const maxX = Math.max(x + width, 1);
  const maxY = Math.max(y + height, 1);

  return {
    x: Number((x / maxX).toFixed(4)),
    y: Number((y / maxY).toFixed(4)),
    width: Number((width / maxX).toFixed(4)),
    height: Number((height / maxY).toFixed(4)),
  };
}

// ================= HEALTH CHECK =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ================= ANALYZE ENDPOINT =================
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    console.log("➡️ /api/analyze hit");

    if (!API_KEY) {
      return res.status(500).json({ error: "Server misconfigured: OPENAI_API_KEY missing" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const base64Image = req.file.buffer.toString("base64");

    console.log("📤 Sending image to OpenAI (Responses API)");

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

const text = response.choices[0].message.content;

    // В Responses API есть удобное поле output_text (в доках так и показано)
    let text = (response.output_text || "").trim();
    if (!text) {
      console.error("❌ Empty model output", response);
      return res.status(500).json({ error: "Empty AI response" });
    }

    if (text.startsWith("```")) {
      text = text.replace(/```json|```/g, "").trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error("❌ JSON PARSE ERROR. Raw text:", text);
      return res.status(500).json({ error: "Invalid JSON from AI" });
    }

    parsed.crop = normalizeCrop(parsed.crop);
    return res.json(parsed);

  } catch (err) {
    // Покажем причину в логах Render
    console.error("❌ AI ERROR:", err?.message || err, err);
    return res.status(500).json({ error: "AI analysis failed" });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});

