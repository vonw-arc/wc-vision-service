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
  } = extraContext || {};

  return [
    `You are a senior concrete and excavation estimator for Watren Concrete.`,
    `You are reading either a FOUNDATION PLAN IMAGE or a MULTI-PAGE FOUNDATION PDF.`,
    ``,
    `Your job:`,
    `1) Carefully read ALL visible notes, schedules, and callouts.`,
    `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
    `3) Avoid vague wording. When possible, include actual numbers (sizes, spacings, strengths).`,
    ``,
    `If an item truly is not present or cannot be read, leave that field as an empty string. Do NOT make up numbers.`,
    ``,
    `Context (may help you interpret the plan):`,
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project   ? `Project: ${project}`       : '',
    address   ? `Address: ${address}`       : '',
    builder   ? `Builder: ${builder}`       : '',
    community ? `Community: ${community}`   : '',
    docType   ? `Document type: ${docType}` : '',
    ``,
    `Important:`,
    `- Include any wall heights, slab thicknesses, footing sizes, and concrete strengths you can read.`,
    `- Include key rebar sizes and spacings (e.g., "#4 @ 12\\" o.c. horiz / vert").`,
    `- Note special features that affect cost (retaining conditions, turndowns, piers, thickened slabs, etc.).`,
    `- If the subdivision name is visible anywhere, put it in lot_info.subdivision.`,
  ].filter(Boolean).join('\n');
}


// ✅ Structured Outputs config – CORRECT shape for Responses API
const textFormatConfig = {
  format: {
    type: "json_schema",
    name: "wc_foundation_summary",
    schema: {
      type: "object",
      properties: {
        lot_info: {
          type: "object",
          properties: {
            lot_number:  { type: "string" },
            block:       { type: "string" },
            subdivision: { type: "string" },
          },
          required: ["lot_number", "block", "subdivision"],
          additionalProperties: false,
        },

        foundation_type: { type: "string" },
        garage_type:     { type: "string" },
        porch_count:     { type: "integer" },
        basement_notes:  { type: "string" },

        structural_notes: { type: "string" },

        estimation_data: {
          type: "object",
          properties: {
            basement_wall_height_ft:    { type: "string" },
            basement_wall_thickness_in: { type: "string" },
            basement_perimeter_ft:      { type: "string" },
            footing_width_in:           { type: "string" },
            footing_thickness_in:       { type: "string" },
            frost_depth_in:             { type: "string" },
            slab_thickness_in:          { type: "string" },
            concrete_strength_psi:      { type: "string" },
            garage_slab_sqft:           { type: "string" },
            basement_slab_sqft:         { type: "string" },
            porch_sqft_total:           { type: "string" },
            driveway_sqft:              { type: "string" },
            retaining_conditions:       { type: "string" },
            rebar_summary:              { type: "string" },
          },
          // 🔥 strict mode demands that required includes *every* key in properties
          required: [
            "basement_wall_height_ft",
            "basement_wall_thickness_in",
            "basement_perimeter_ft",
            "footing_width_in",
            "footing_thickness_in",
            "frost_depth_in",
            "slab_thickness_in",
            "concrete_strength_psi",
            "garage_slab_sqft",
            "basement_slab_sqft",
            "porch_sqft_total",
            "driveway_sqft",
            "retaining_conditions",
            "rebar_summary",
          ],
          additionalProperties: false,
        },

        unusual_items: {
          type: "array",
          items: { type: "string" },
        },

        inspection_requirements: {
          type: "array",
          items: { type: "string" },
        },

        code_references: {
          type: "array",
          items: { type: "string" },
        },

        quick_summary: { type: "string" },
      },
      required: [
  "lot_info",
  "foundation_type",
  "garage_type",
  "porch_count",
  "basement_notes",
  "structural_notes",   // 👈 add this line
  "unusual_items",
  "quick_summary",

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
    const lowerUrl  = String(url).toLowerCase();
    const lowerType = (fileType || '').toLowerCase();

    const hasPdfExt = /\.pdf(\?|$)/.test(lowerUrl);
    const hasImgExt = /\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(lowerUrl);

    const isExplicitPdfType  = lowerType === 'pdf';
    const isExplicitImgType  = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(lowerType);

    // Start with explicit hints and URL extension
    let isPdf = isExplicitPdfType || hasPdfExt;

    // 🚫 IMPORTANT: if we *know* it's an image type, NEVER flip it to PDF
    if (!isPdf && !hasImgExt && !isExplicitImgType) {
      // Ambiguous URL + no explicit type → assume PDF (your common case)
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
  model: "gpt-4.1",
  input: [
    {
      role: "user",
      content,
    },
  ],
  text: textFormatConfig,  // ← use the schema you defined above
});

const jsonText = response.output_text;
let parsed;

try {
  parsed = JSON.parse(jsonText);
} catch (e) {
  console.error("Failed to parse JSON schema output:", e);
  console.error("Raw output_text:", jsonText);
  return res.status(500).json({
    error: "Vision service failed",
    details: "Could not parse JSON output.",
  });
}

res.json({
  success: true,
  source: isPdf ? "pdf" : "image",
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
