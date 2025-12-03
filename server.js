// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const client = new OpenAI();

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Vision calls will fail until you set it.');
}

const SYSTEM_PROMPT = `
You are a VERY LITERAL plan-reading assistant for residential foundation bids for Watren Concrete.

Core rules:
- Your #1 job is to read what is printed on the plan, NOT to “fix” or reinterpret it.
- When copying text like bar callouts, hardware notes, or special requirements,
  COPY THEM EXACTLY as written (including odd abbreviations, punctuation, and spacing).
  Examples: "420 BAR", "4EQ #4 @ 20' O.C.", "MST BAR USA", "NO SUBSTITUTIONS".
- DO NOT spell-check or normalize technical terms. If the plan says "4EQ", do NOT change it.
- If you truly cannot read a piece of text, use the string "unreadable" instead of guessing.

Numeric details (VERY IMPORTANT):
- Whenever they are clearly visible on the image/PDF, you MUST include:
  - Basement wall height (e.g. "8'-0\" basement", "9'-0\" basement")
  - Slab thickness (e.g. "4\" slab", "5\" slab")
  - Any minimum depth to untreated wood or frost (e.g. "min 18\" to untreated wood")
  - Any footing dimensions (e.g. "16\" x 8\" footing") if they are printed and readable
- These numeric details should appear inside "basement_notes" or "unusual_items"
  EXACTLY as they appear on the plan.

Use of context:
- Only use extra context (lot number, project, address, builder, community, doc type)
  to understand what you’re looking at, NOT to infer or guess numeric values.

Output:
- Return ONLY a single JSON object that obeys the provided json_schema exactly.
`;

function buildPrompt(extraContext = {}, estimateId) {
  const {
    project,
    address,
    builder,
    community,
    docType,
  } = extraContext;

  return [
    `You are reading either a foundation image or a multi-page PDF plan for a residential job.`,
    '',
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project ? `Project: ${project}` : '',
    address ? `Address: ${address}` : '',
    builder ? `Builder: ${builder}` : '',
    community ? `Community: ${community}` : '',
    docType ? `Document type: ${docType}` : '',
    '',
    `Extract the key scope and risk details in a tight, JSON-friendly way.`,
    `ALWAYS focus on numeric structural details when they are visible, especially:`,
    `- Basement wall height (8', 9', etc.)`,
    `- Slab thickness (4", 5", etc.)`,
    `- Minimum depth to untreated wood / frost`,
    `- Any footing sizes or similar dimensions`,
    '',
    `Put these numeric values inside "basement_notes" and/or "unusual_items" as plain text,`,
    `copied exactly as printed on the plan.`,
  ].filter(Boolean).join('\n');
}

// Shared JSON schema for output back to Sheets
const responseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'wc_foundation_summary',
    schema: {
      type: 'object',
      properties: {
        lot_info: {
          type: 'object',
          properties: {
            lot_number: { type: 'string' },
            block: { type: 'string' },
            subdivision: { type: 'string' },
          },
          required: ['lot_number', 'block', 'subdivision'],
          additionalProperties: false,
        },
        foundation_type: { type: 'string' },
        garage_type: { type: 'string' },
        porch_count: { type: 'integer' },
        basement_notes: { type: 'string' },
        unusual_items: {
          type: 'array',
          items: { type: 'string' },
        },
        quick_summary: { type: 'string' },
      },
      required: [
        'lot_info',
        'foundation_type',
        'garage_type',
        'porch_count',
        'basement_notes',
        'unusual_items',
        'quick_summary',
      ],
      additionalProperties: true,
    },
    strict: true,
  },
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Main endpoint – handles PDFs (multi-page) + images
app.post('/analyze-plan', async (req, res) => {
  try {
    const internalKey = req.headers['x-internal-key'];
    if (!INTERNAL_API_KEY || internalKey !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      estimateId,
      fileUrl,
      fileType,
      imageUrl,
      extraContext,
    } = req.body || {};

    const url = fileUrl || imageUrl;
    if (!url) {
      return res.status(400).json({ error: 'Missing file/image URL' });
    }

    const lowerUrl = String(url).toLowerCase();
    const lowerType = (fileType || '').toLowerCase();
    const isPdf =
      lowerType === 'pdf' ||
      /\.pdf(\?|$)/.test(lowerUrl);

    const content = [
      {
        type: 'input_text',
        text: buildPrompt(extraContext || {}, estimateId),
      },
    ];

    if (isPdf) {
      // PDF path – Responses API pulls the PDF directly from the URL (all pages)
      content.push({
        type: 'input_file',
        file_url: url,
      });
    } else {
      // Image path – high detail for better reading
      content.push({
        type: 'input_image_url',
        image_url: { url, detail: 'high' },
      });
    }

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: SYSTEM_PROMPT }],
        },
        {
          role: 'user',
          content,
        },
      ],
      response_format: responseFormat,
    });

    const jsonText = response.output_text;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse JSON from response.output_text:', e);
      console.error('Raw output_text:', jsonText);
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Could not parse JSON from model output.',
      });
    }

    res.json({
      success: true,
      source: isPdf ? 'pdf' : 'image',
      data: parsed,
    });
  } catch (err) {
    console.error('Vision error:', err);
    res.status(500).json({
      error: 'Vision service failed',
      details: err?.message || String(err),
    });
  }
});

app.get('/', (_req, res) => {
  res.send('wc-vision-service is alive 🦁');
});

app.listen(port, () => {
  console.log(`wc-vision-service listening on port ${port}`);
});



