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

// ================= OPENAI CLIENT =================

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  {
    "x": 0.1,
    "y": 0.05,
    "width": 0.8,
    "height": 0.9
  }
- Crop must be vertical and Pinterest-friendly
- Focus on the main subject

5. Output:
- JSON only
`;

// ================= UTILS =================

// Backend safety: normalize crop no matter what AI returns
function normalizeCrop(crop) {
  if (!crop) {
    return { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
  }

  const { x, y, width, height } = crop;

  // Already valid (0–1)
  if (
    x >= 0 && x <= 1 &&
    y >= 0 && y <= 1 &&
    width > 0 && width <= 1 &&
    height > 0 && height <= 1
  ) {
    return crop;
  }

  // Assume pixel-like or garbage values → normalize
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
  res.send("ok");
});

// ================= ANALYZE ENDPOINT =================

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze the image." },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${base64Image}`,
            },
          ],
        },
      ],
    });

    let text = response.output_text?.trim();
    if (!text) {
      throw new Error("Empty AI response");
    }

    // Remove ```json fences if AI disobeys
    if (text.startsWith("```")) {
      text = text.replace(/```json|```/g, "").trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error("JSON PARSE ERROR:", text);
      return res.status(500).json({ error: "Invalid JSON from AI" });
    }

    // 🔒 FINAL SAFETY LAYER
    parsed.crop = normalizeCrop(parsed.crop);

    res.json(parsed);

  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// ================= START SERVER =================

const PORT = process.env.PORT || 8787;

app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
