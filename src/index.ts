import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

// Создаем интерфейс, чтобы TS понимал, что в Request есть файл от Multer
interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const app = express();
app.use(cors());
app.use(express.json()); // Добавлено для корректной работы с JSON

/* =========================
   OpenAI Configuration
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   Multer Storage (Memory)
========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

/* =========================
   Health Check
========================= */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "VivaPortugal AI" });
});

/* =========================
   Analyze Image Endpoint
========================= */
// Используем MulterRequest вместо обычного Request
app.post(
  "/api/analyze",
  upload.single("image"),
  async (req: MulterRequest, res: Response): Promise<any> => {
    try {
      // 1. Проверка наличия файла
      if (!req.file) {
        return res.status(400).json({ error: "Image file is required" });
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
        - Include keywords naturally: portugal, azulejo, porto, lisbon, portuguese gifts
        - Crop is portrait 1000x1500 (relative values 0..1)
      `;

      // 2. Запрос к OpenAI
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Return ONLY valid JSON. No markdown. No text explanations."
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
        throw new Error("OpenAI returned an empty response");
      }

      // 3. Отправка результата
      return res.json(JSON.parse(content));

    } catch (err: any) {
      console.error("❌ OpenAI Error:", err.message);
      return res.status(500).json({
        error: err.message || "Internal server error"
      });
    }
  }
);

/* =========================
   Start Server
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VivaPortugal AI Backend running on port ${PORT}`);
});