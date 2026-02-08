import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ================= APP SETUP =================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.get("/", (req, res) => {
  res.send("VivaPortugal backend OK");
});

// ================= ENV =================
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing");
}

// ================= OPENAI =================
const client = new OpenAI({
  apiKey: API_KEY,
});

// ================= PROMPT =================
const SYSTEM_PROMPT = `
You are VivaPortugal AI — a strict Pinterest SEO assistant.

Return ONLY valid JSON. No markdown. No explanations.
`;

// ================= HEALTH =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ================= ANALYZE =================
app.post("/api/analyze", upload.single("image"), async (req, res) => {
  try {
    console.log("➡️ /api/analyze hit");

    if (!API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const base64Image = req.file.buffer.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
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
    });

    const text = response.choices[0]?.message?.content;

    if (!text) {
      console.error("❌ Empty AI response", response);
      return res.status(500).json({ error: "Empty AI response" });
    }

    const clean = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error("❌ JSON parse error. RAW:", clean);
      return res.status(500).json({ error: "Invalid JSON from AI" });
    }

    res.json(parsed);

  } catch (err) {
    console.error("❌ AI ERROR:", err);
    res.status(500).json({ error: "AI analysis failed" });
  }
});

// ================= START =================
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
