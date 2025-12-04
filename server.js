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
    `1) Carefully read ALL visible notes, schedules, and callouts on the plan.`,
    `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON fields described below.`,
    `3) Avoid vague wording. When possible, include actual numbers (sizes, spacings, strengths).`,
    ``,
    `If an item truly is not present or cannot be read, leave that field as an empty string or an empty array.`,
    `Do NOT invent or guess numbers.`,
    ``,
    `Context (may help you interpret the plan):`,
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project   ? `Project: ${project}`       : '',
    address   ? `Address: ${address}`       : '',
    builder   ? `Builder: ${builder}`       : '',
    community ? `Community: ${community}`   : '',
    docType   ? `Document type: ${docType}` : '',
    ``,
    `IMPORTANT DATA TO PULL OUT:`,
    `- Lot info: lot number, block, subdivision (if the subdivision/filer name is visible anywhere).`,
    `- Foundation type: e.g. "N.S.F. foundation with slab on grade", "Standard basement", etc.`,
    `- Garage type: e.g. "2-car left", "3-car tandem right", etc.`,
    `- Porch count: how many porches or exterior slabs are clearly shown/called out.`,
    `- Basement notes: wall heights, slab thicknesses, footing sizes, concrete strengths, etc.`,
    `- Structural notes: any general structural/engineering notes that affect how we pour or form.`,
    `- Estimation data: numeric-ish values as strings:`,
    `  • basement_wall_height_ft`,
    `  • basement_wall_thickness_in`,
    `  • basement_perimeter_ft`,
    `  • footing_width_in`,
    `  • footing_thickness_in`,
    `  • frost_depth_in`,
    `  • slab_thickness_in`,
    `  • concrete_strength_psi`,
    `  • garage_slab_sqft`,
    `  • basement_slab_sqft`,
    `  • porch_sqft_total`,
    `  • driveway_sqft`,
    `  • retaining_conditions (short description)`,
    `  • rebar_summary (summary of main bar sizes/spacings)`,
    `- Unusual items: anything that is non-standard or that could be a risk, change order, or cost driver.`,
    `- Inspection requirements: any special inspections required (e.g., open hole inspection, rebar inspection, etc.).`,
    `- Code references: any explicit building code or design standard references (e.g., "2021 IRC").`,
    `- Quick summary: 1–2 sentences summarizing the overall foundation scope in plain English.`,
    ``,
    `OUTPUT FORMAT (IMPORTANT):`,
    `Return ONLY a single JSON object, no extra commentary, in this exact structure:`,
    ``,
    `{
      "lot_info": {
        "lot_number": "",
        "block": "",
        "subdivision": ""
      },
      "foundation_type": "",
      "garage_type": "",
      "porch_count": 0,
      "basement_notes": "",
      "structural_notes": "",
      "estimation_data": {
        "basement_wall_height_ft": "",
        "basement_wall_thickness_in": "",
        "basement_perimeter_ft": "",
        "footing_width_in": "",
        "footing_thickness_in": "",
        "frost_depth_in": "",
        "slab_thickness_in": "",
        "concrete_strength_psi": "",
        "garage_slab_sqft": "",
        "basement_slab_sqft": "",
        "porch_sqft_total": "",
        "driveway_sqft": "",
        "retaining_conditions": "",
        "rebar_summary": ""
      },
      "unusual_items": [],
      "inspection_requirements": [],
      "code_references": [],
      "quick_summary": ""
    }`,
    ``,
    `Only change the values. Keep all keys exactly as written. Do NOT wrap this JSON in backticks or any explanation.`,
  ].filter(Boolean).join('\n');
}

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

    const isExplicitPdfType = lowerType === 'pdf';
    const isExplicitImgType = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(lowerType);

    let isPdf = isExplicitPdfType || hasPdfExt;

    // If it's not clearly image and not clearly pdf by extension, default to PDF (your common case)
    if (!isPdf && !hasImgExt && !isExplicitImgType) {
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
      model: 'gpt-4.1',
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: {
        // No schema gymnastics—just "return JSON"
        format: 'json',
      },
    });

    const jsonText = response.output_text;
    let parsed;

    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse JSON output:', e);
      console.error('Raw output_text:', jsonText);
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Could not parse JSON output.',
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
