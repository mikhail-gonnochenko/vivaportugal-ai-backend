import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import dotenv from "dotenv";

/**
 * Загружаем переменные окружения (.env локально, Render — автоматически)
 */
dotenv.config();

// ================= APP SETUP =================

const app = express();

/**
 * Multer — принимаем файл в памяти (multipart/form-data)
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

/**
 * CORS — разрешаем запросы с frontend (Render Static Site)
 * ✅ ИСПРАВЛЕНО: более специфичный origin
 */
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:4173",
      "https://vivaportugal-ai-frontend.onrender.com",
    ],
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

/**
 * Обработка preflight-запросов
 */
app.options("*", cors());

// ================= LOGGING MIDDLEWARE =================
// ✅ ДОБАВЛЕНО: логирование всех запросов

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log("Origin:", req.headers.origin || "none");
  next();
});

// ================= OPENAI CLIENT =================

console.log("=================================");
console.log("🚀 VIVAPORTUGAL AI BACKEND");
console.log("=================================");

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is NOT defined");
  console.error("⚠️  Please set it in Render Environment Variables");
} else {
  console.log("✅ OPENAI_API_KEY found:", process.env.OPENAI_API_KEY.substring(0, 10) + "...");
}

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
- Crop must be vertical and Pinterest-friendly
- Focus on the main subject

5. Output:
- JSON only
`;

// ================= UTILS =================

/**
 * Нормализация crop, даже если AI прислал мусор
 */
function normalizeCrop(crop) {
  if (!crop) {
    console.log("⚠️  No crop data, using defaults");
    return { x: 0.1, y: 0.05, width: 0.8, height: 0.9 };
  }

  const { x, y, width, height } = crop;

  if (
    x >= 0 && x <= 1 &&
    y >= 0 && y <= 1 &&
    width > 0 && width <= 1 &&
    height > 0 && height <= 1
  ) {
    console.log("✅ Crop values are valid (0-1 range)");
    return crop;
  }

  console.log("⚠️  Crop values out of range, normalizing...");
  console.log("Original crop:", { x, y, width, height });

  const maxX = Math.max(x + width, 1);
  const maxY = Math.max(y + height, 1);

  const normalized = {
    x: Number((x / maxX).toFixed(4)),
    y: Number((y / maxY).toFixed(4)),
    width: Number((width / maxX).toFixed(4)),
    height: Number((height / maxY).toFixed(4)),
  };

  console.log("Normalized crop:", normalized);
  return normalized;
}

// ================= HEALTH CHECK =================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 8787,
    env: process.env.NODE_ENV || "development",
    openaiKeyExists: !!process.env.OPENAI_API_KEY,
  });
});

// ✅ ДОБАВЛЕНО: тест OpenAI соединения
app.get("/api/test-openai", async (req, res) => {
  console.log("🧪 Testing OpenAI connection...");

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "OPENAI_API_KEY not configured",
      });
    }

    // Простой тест - список моделей
    const models = await client.models.list();

    console.log("✅ OpenAI connection successful");

    res.json({
      success: true,
      message: "OpenAI API connection successful",
      modelsCount: models.data.length,
    });
  } catch (error) {
    console.error("❌ OpenAI test failed:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ================= ANALYZE ENDPOINT =================

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  console.log("");
  console.log("=================================");
  console.log("➡️  /api/analyze HIT");
  console.log("=================================");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Origin:", req.headers.origin);
  console.log("Content-Type:", req.headers["content-type"]);

  try {
    // Проверка файла
    if (!req.file) {
      console.error("❌ No file uploaded");
      return res.status(400).json({ error: "No image uploaded" });
    }

    console.log("✅ File received:");
    console.log("  - Name:", req.file.originalname || "unknown");
    console.log("  - Size:", req.file.size, "bytes");
    console.log("  - Type:", req.file.mimetype);

    // Проверка OpenAI ключа
    if (!process.env.OPENAI_API_KEY) {
      console.error("❌ OPENAI_API_KEY not set");
      return res.status(500).json({
        error: "OpenAI API key not configured",
      });
    }

    // Конвертация в base64
    console.log("🔄 Converting to base64...");
    const base64Image = req.file.buffer.toString("base64");
    console.log("✅ Converted, length:", base64Image.length);

    console.log("🤖 Sending to OpenAI Vision API...");
    console.log("Model: gpt-4o-mini");

    const startTime = Date.now();

    // ✅ ИСПРАВЛЕНО: используем правильный Chat Completions API
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
            { 
              type: "text", 
              text: "Analyze the image." 
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high", // для лучшего анализа
              },
            },
          ],
        },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const duration = Date.now() - startTime;
    console.log(`✅ OpenAI response received in ${duration}ms`);

    // ✅ ИСПРАВЛЕНО: правильное извлечение контента
    let text = response.choices[0].message.content.trim();
    
    console.log("📥 OpenAI raw output (first 200 chars):", text.substring(0, 200));

    if (!text) {
      throw new Error("Empty AI response");
    }

    // Удаление markdown code blocks если есть
    if (text.startsWith("```")) {
      console.log("🔄 Removing markdown code blocks...");
      text = text.replace(/```json|```/g, "").trim();
    }

    // Парсинг JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
      console.log("✅ JSON parsed successfully");
    } catch (e) {
      console.error("❌ JSON PARSE ERROR");
      console.error("Raw text:", text);
      console.error("Parse error:", e.message);
      return res.status(500).json({ 
        error: "Invalid JSON from AI",
        raw: text.substring(0, 500) // первые 500 символов для отладки
      });
    }

    // Нормализация crop
    console.log("🔄 Normalizing crop values...");
    parsed.crop = normalizeCrop(parsed.crop);

    console.log("🎉 Success! Sending response to frontend");
    console.log("  - Title:", parsed.pinterest_title?.substring(0, 50) + "...");
    console.log("  - Board:", parsed.board);
    console.log("  - Crop:", parsed.crop);
    console.log("=================================");
    console.log("");

    res.json(parsed);

  } catch (err) {
    console.error("");
    console.error("=================================");
    console.error("🔥 ERROR IN /api/analyze");
    console.error("=================================");
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error stack:", err.stack);

    if (err.response) {
      console.error("OpenAI Response Status:", err.response.status);
      console.error("OpenAI Response Data:", err.response.data);
    }

    console.error("=================================");
    console.error("");

    res.status(500).json({ 
      error: "AI analysis failed",
      message: err.message,
      ...(process.env.NODE_ENV === "development" && { stack: err.stack })
    });
  }
});

// ================= 404 HANDLER =================

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// ================= START SERVER =================

const PORT = process.env.PORT || 8787;

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("=================================");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔑 OpenAI Key: ${process.env.OPENAI_API_KEY ? "✅ Set" : "❌ Missing"}`);
  console.log("");
  console.log("Available endpoints:");
  console.log("  GET  /api/health");
  console.log("  GET  /api/test-openai");
  console.log("  POST /api/analyze");
  console.log("=================================");
  console.log("");
});

// ================= GRACEFUL SHUTDOWN =================

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing server");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing server");
  process.exit(0);
});
