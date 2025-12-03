// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Vision calls will fail until you set it.');
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/**
 * Build a focused prompt for foundation plans.
 */
function buildPrompt(extraContext = {}, estimateId) {
  const {
    project,
    address,
    builder,
    community,
    docType,
  } = extraContext;

  return [
    `You are a concrete and excavation foundation-plan assistant for Watren Concrete.`,
    `You are reading either:`,
    `  • a single-page or multi-page PDF plan, or`,
    `  • a raster image (PNG/JPEG/etc.) of a foundation plan.`,
    ``,
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project   ? `Project: ${project}`       : '',
    address   ? `Address: ${address}`       : '',
    builder   ? `Builder: ${builder}`       : '',
    community ? `Community: ${community}`   : '',
    docType   ? `Document type: ${docType}` : '',
    ``,
    `Your job: extract scope + risk info in a JSON-friendly way using the given schema.`,
    ``,
    `VERY IMPORTANT NUMERIC ACCURACY RULES:`,
    `- Carefully read dimensions, bar sizes, spacing, basement heights, and slab thickness from the plan text.`,
    `- If you see multiple values, choose the one clearly labeled as FINAL or TYPICAL for this plan.`,
    `- If a value is unclear or missing, use an empty string "" and DO NOT invent numbers.`,
    ``,
    `Focus on:`,
    `- Lot info (lot number, block, subdivision) if shown.`,
    `- Foundation type (e.g., "N.S.F. foundation with slab on grade", "crawlspace", etc.).`,
    `- Garage configuration (side, bay count, orientation if obvious).`,
    `- Number of porches / stoops called out structurally.`,
    `- Basement notes (height, slab thickness, compaction / soils notes, any special conditions).`,
    `- Unusual or risk items (no-substitution notes, special inspection requirements, odd rebar patterns, special hardware).`,
    ``,
    `Return ONLY valid JSON that matches the schema. Do not include commentary outside JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Shared JSON schema configuration for Responses API.
 * This replaces the old `response_format` parameter.
 */
const jsonSchemaConfig = {
  format: 'json_schema',
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

// Main endpoint – supports BOTH images and PDFs via Responses API
app.post('/analyze-plan', async (req, res) => {
  try {
    const internalKey = req.headers['x-internal-key'];
    if (!INTERNAL_API_KEY || internalKey !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      estimateId,
      imageUrl,
      fileUrl,
      fileType,
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

    const prompt = buildPrompt(extraContext || {}, estimateId);

    // Build the content array for Responses API
    const content = [
      {
        type: 'input_text',
        text: prompt,
      },
    ];

    if (isPdf) {
      // ✅ PDF path – let the model fetch the PDF via URL
      content.push({
        type: 'input_file',
        file_url: url, // Responses API supports file_url here
      });
    } else {
      // ✅ Image path – NEW correct type and shape
      content.push({
        type: 'input_image',
        image_url: url, // plain URL string, not { url: ... }
      });
    }

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: jsonSchemaConfig,
    });

    // With json_schema + strict, output_text should be pure JSON text
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
