import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();
app.use(cors());

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   Multer (memory)
========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

/* =========================
   Health check
========================= */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/* =========================
   Analyze image
========================= */
app.post(
  "/api/analyze",
  upload.single("image"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image is required" });
      }

      const imageBase64 = req.file.buffer.toString("base64");

      const prompt = `
You are VivaPortugal AI.

Analyze this product image and return ONLY valid JSON.

Schema:
{
  "seo": {
    "title": "string",
    "description": "string"
  },
  "pinterest": {
    "keywords": ["string"],
    "board": {
      "title": "string",
      "description": "string"
    }
  },
  "crop": {
    "x": number,
    "y": number,
    "width": number,
    "height": number
  }
}

Rules:
- Language: English
- Market: US
- Audience: tourists, diaspora, gift buyers
- Include keywords naturally:
  portugal, azulejo, porto, lisbon, portuguese gifts
- Crop is portrait 1000x1500 (relative values 0..1)
`;

      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "Return ONLY valid JSON. No markdown. No text."
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${req.file.mimetype};base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0].message.content;

      if (!content) {
        throw new Error("OpenAI returned empty response");
      }

      res.json(JSON.parse(content));
    } catch (err: any) {
      console.error("❌ OpenAI error:", err);
      res.status(500).json({
        error: err.message || "Internal server error"
      });
    }
  }
);

/* =========================
   Start server
========================= */
const PORT = 8787;

app.listen(PORT, () => {
  console.log(`🚀 VivaPortugal AI Backend running on http://localhost:${PORT}`);
});
