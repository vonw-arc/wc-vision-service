import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Internal auth key (for Apps Script to prove it's really you)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// Simple health-check route for sanity tests
app.get("/", (req, res) => {
  res.json({ ok: true, service: "wc-vision-service" });
});

// Main vision endpoint
app.post("/analyze-bid-docs", async (req, res) => {
  try {
    // Simple internal auth
    const headerKey = req.headers["x-internal-key"];
    if (!headerKey || headerKey !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { projectId, planUrls, extraContext } = req.body || {};

    if (!Array.isArray(planUrls) || planUrls.length === 0) {
      return res.status(400).json({ error: "planUrls array is required" });
    }

    const firstPlanUrl = planUrls[0];

    const systemPrompt = `
You are the Maneframe Vision Assistant for a concrete/excavation contractor.
You receive residential house plan sheets and must extract structured data to help build bids.

Return a concise JSON object with fields like:
- lot_info: { lot_number, block, subdivision }
- foundation_type
- garage_type
- porch_count
- basement_notes
- unusual_items: [ ... ]
- quick_summary: string

Keep it compact and machine-readable.
    `.trim();

    const userText = `
Project: ${projectId || "Unknown Project"}

Additional context from spreadsheet:
${extraContext || "None"}
    `.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: firstPlanUrl },
            },
          ],
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    const content = completion.choices?.[0]?.message?.content || "{}";

    res.json({
      ok: true,
      projectId: projectId || null,
      raw_model_output: content,
    });
  } catch (err) {
    console.error("Vision error:", err);
    res.status(500).json({
      error: "Vision service failed",
      details: String(err?.message || err),
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`wc-vision-service listening on port ${PORT}`);
});


