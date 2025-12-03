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

const client = new OpenAI();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
    `You are reading either a foundation **image** or a multi-page **PDF** plan.`,
    '',
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project ? `Project: ${project}` : '',
    address ? `Address: ${address}` : '',
    builder ? `Builder: ${builder}` : '',
    community ? `Community: ${community}` : '',
    docType ? `Document type: ${docType}` : '',
    '',
    `Extract the key scope and risk details for our estimating pipeline, in a tight, JSON-friendly way.`,
    `Focus on:`,
    `- Lot info (lot #, block, subdivision)`,
    `- Foundation type (N.S.F., slab on grade vs crawl vs basement, etc.)`,
    `- Garage type (e.g. 2-car left, 3-car tandem, etc.)`,
    `- Porches / exterior slabs count and any notes`,
    `- Basement notes (height, slab notes, compaction / soils notes, etc.)`,
    `- Unusual / risk items that affect cost, schedule, or coordination.`,
  ].filter(Boolean).join('\n');
}

// ✅ Structured Outputs config – CORRECT shape for Responses API
const textFormatConfig = {
  format: {
    type: 'json_schema',
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
      additionalProperties: false,
    },
    strict: true,
  },
};

// Main endpoint – supports BOTH images and PDFs
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

    // Decide if this is a PDF or an image
        const lowerUrl = String(url).toLowerCase();
    const lowerType = (fileType || '').toLowerCase();

    const hasPdfExt   = /\.pdf(\?|$)/.test(lowerUrl);
    const hasImgExt   = /\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(lowerUrl);

    let isPdf = (lowerType === 'pdf') || hasPdfExt;

    // If there’s no clear image extension and no explicit type,
    // default to PDF because 90–95% of your docs are PDFs.
    if (!isPdf && !hasImgExt) {
      isPdf = true;
    }

    // 👇 Multimodal content: prompt + either file or image
    const content = [
      {
        type: 'input_text',
        text: buildPrompt(extraContext, estimateId),
      },
    ];

    if (isPdf) {
      // ✅ PDF: Responses API pulls the PDF directly from the URL (all pages)
      content.push({
        type: 'input_file',
        file_url: url,
      });
    } else {
      // ✅ Image: normal vision path
      content.push({
        type: 'input_image',
        image_url: url,
      });
    }

    const response = await client.responses.create({
      model: 'gpt-4o-mini',               // ← supports text.format structured outputs
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: textFormatConfig,             // ← CORRECT place for json_schema now
    });

    // With text.format + json_schema, output_text will be valid JSON
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
