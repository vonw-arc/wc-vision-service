// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { createCanvas, Image as CanvasImage } from 'canvas';

// ✅ Register Node-canvas globals BEFORE loading pdf.js
globalThis.Image = CanvasImage;
globalThis.ImageData = ImageData;
globalThis.DOMMatrix = DOMMatrix;
globalThis.Path2D = Path2D;

// ✅ Lazy-load pdf.js after globals exist (ESM-safe)
let _pdfjsLib;
async function getPdfjs() {
  if (_pdfjsLib) return _pdfjsLib;
  _pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjsLib;
}

async function rasterizePdfToImages(pdfUrl, dpi = 300) {
  const pdfjsLib = await getPdfjs();

  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);

  const pdfBuffer = await res.arrayBuffer();
  const pdfData = new Uint8Array(pdfBuffer);

  const pdf = await pdfjsLib.getDocument({
    data: pdfData,
    disableWorker: true, // ✅ Node/Render-safe
  }).promise;

  const MAX_PAGES = 3;
  const pagesToRender = Math.min(pdf.numPages, MAX_PAGES);

  const images = [];
  const scale = dpi / 72;

  for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // createCanvas expects ints
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');

    ctx.imageSmoothingEnabled = false;

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    images.push(`data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`);
  }

  return images;
}

const app = express();
const port = process.env.PORT || 3000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!process.env.OPENAI_API_KEY) {
console.warn('Warning: OPENAI_API_KEY is not set. Vision calls will fail until you set it.');
}

const client = new OpenAI();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function buildPrompt(extraContext = {}, estimateId) {
  const {
    project,
    address,
    builder,
    community,
    docType,
  } = extraContext || {};

  const docLower = (docType || '').toString().toLowerCase();
  const isPlotOrGrading =
    docLower.includes('plot') ||
    docLower.includes('grading');

  const headerLines = [
    `You are a senior concrete and excavation estimator for Watren Concrete.`,
    isPlotOrGrading
      ? `You are reading a residential PLOT / GRADING PLAN image or multi-page PDF.`
      : `You are reading either a FOUNDATION PLAN IMAGE or a MULTI-PAGE FOUNDATION PDF.`,
    ``,
  ];

  const jobLines = isPlotOrGrading
    ? [
        `Your job:`,
        `1) Carefully read ALL visible notes, schedules, callouts, OPTIONS tables, dimension strings, utility symbols (W/S), and scale/graphic bars on the plot/grading plan.`,
        `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
        `3) Focus especially on:`,
        `   - Water service route and length from meter pit (W) to house (estimation_data.water_service_length_ft).`,
        `   - Sanitary sewer route and length from stub (S) to house (estimation_data.sewer_service_length_ft).`,
        `   - Lot area (estimation_data.lot_area_sqft).`,
        `   - House footprint area (estimation_data.house_footprint_area_sqft).`,
        `   - Grading area = lot area minus house footprint (estimation_data.grading_area_sqft) when both are known.`,
        `   - Top of foundation elevation (estimation_data.top_of_foundation_elev_ft).`,
        `   - Total foundation wall linear footage if reasonably determinable (estimation_data.foundation_wall_total_lf).`,
        `   - A single representative existing grade elevation at street/sidewalk/curb in front of the house (estimation_data.reference_grade_elev_ft).`,
        `   - Any notable options, grading-related conditions, or assumptions (estimation_data.plot_grading_notes).`,
        ``,
        `Foundation basics from plot/option notes (VERY important):`,
        `- Many plot plans include an OPTIONS or MODEL table that states things like "8' walls", "9' basement", "garden level", etc.`,
        `- You MUST read those notes and, when present:`,
        `    - Set estimation_data.basement_wall_height_ft to the numeric height (e.g. "8" or "9").`,
        `    - Set foundation_type to a short description (e.g. "8' basement with NSF foundation", "Garden level basement").`,
        `- If the plan clearly indicates that garage and/or crawlspace foundation walls are present but does NOT state their height,`,
        `  assume those are 4' foundation walls for your description and mention this assumption in estimation_data.plot_grading_notes.`,
        `- Do NOT leave basement_wall_height_ft blank if the options/model notes clearly state the wall height (e.g. "8' walls").`,
        ``,
	`Elevation shorthand rule (critical):`,
	`- Many plot plans show spot grades as shorthand like "84.8" where the leading digits are omitted for legibility.`,
	`- If Top of Foundation is given as a full elevation (e.g., 4787.8) and a spot grade is shown as a shorter number (e.g., 84.8), you MUST assume the spot grade shares the same leading digits as the TOF. Example: TOF 4787.8 and spot grade 84.8 → interpret spot grade as 4784.8.`,
	`- Always output top_of_foundation_elev_ft and reference_grade_elev_ft as FULL elevations in feet (e.g., 4784.8), not shorthand.`,
	`- If you are not confident, leave reference_grade_elev_ft blank and explain why in plot_grading_notes.`,
        `Water / sewer measurement rules (very important):`,
        `- Identify the W (water meter pit) and S (sewer stub) symbols.`,
        `- If an explicit utility line is drawn, use that route to determine the service path.`,
        `- If NO utility line is drawn, you MUST assume the shortest reasonable straight-line path from the W or S symbol to the nearest logical foundation entry point for that unit.`,
        `- A logical entry point means the closest spot on the foundation wall where that service would connect based on typical residential construction.`,
        `- If a legible scale note (for example "1\\"=20'-0") or a graphic scale bar is present, you MUST attempt to estimate the water and sewer line lengths using that scale.`,
        `- Use dimension text when available. Otherwise, measure using the scale and provide a reasonable estimate in feet, rounded to the nearest whole foot.`,
        `- Always return ALL of the following fields, using empty strings ("") when truly unknown:`,
        `     estimation_data.water_service_length_ft`,
        `     estimation_data.water_service_length_method`,
        `     estimation_data.sewer_service_length_ft`,
        `     estimation_data.sewer_service_length_method`,
        `     estimation_data.lot_area_sqft`,
        `     estimation_data.house_footprint_area_sqft`,
        `     estimation_data.grading_area_sqft`,
        `     estimation_data.top_of_foundation_elev_ft`,
        `     estimation_data.foundation_wall_total_lf`,
        `     estimation_data.reference_grade_elev_ft`,
        ``,
        `Reference grade elevation (for dirt balance):`,
        `- Choose ONE representative existing grade elevation at the street/sidewalk/curb directly in front of the house (for example a spot grade at back of walk or top of curb).`,
        `- Put ONLY the numeric elevation in feet into estimation_data.reference_grade_elev_ft (for example "5574.2").`,
        `- If no reasonable street/sidewalk/curb elevation is visible, leave estimation_data.reference_grade_elev_ft as an empty string.`,
        ``,
        `Townhomes / multi-unit rules:`,
        `- Plot plans may show multiple units in a single block (e.g., Unit A, Unit B, Unit C).`,
        `- Each unit may have its own W (water meter pit) and S (sewer stub) marker.`,
        `- You MUST identify which W/S pair belongs to the specific unit being analyzed.`,
        `- Use the address, lot, or unit label from the provided context (project, address, community, docType) and any unit labels on the plan to determine which unit applies.`,
        `- If the context clearly corresponds to a specific unit, RETURN ONLY that unit’s primary measurements in:`,
        `     estimation_data.water_service_length_ft`,
        `     estimation_data.water_service_length_method`,
        `     estimation_data.sewer_service_length_ft`,
        `     estimation_data.sewer_service_length_method`,
        `     estimation_data.lot_area_sqft`,
        `     estimation_data.house_footprint_area_sqft`,
        `     estimation_data.grading_area_sqft`,
        `     estimation_data.top_of_foundation_elev_ft`,
        `     estimation_data.foundation_wall_total_lf`,
        `- If the context does NOT clearly specify a single unit and multiple units exist, you may also populate estimation_data.multi_unit_services as an array with one entry per unit (unit_id plus water/sewer lengths and methods).`,
        `- Never mix or average service lengths across different units. Treat each unit independently.`,
        ``,
        `General rules:`,
        `- Prefer dimension text and explicit area callouts (e.g., "LOT AREA = 6000 SF", "BUILDING AREA = 1800 SF").`,
        `- You MAY combine clearly labeled dimensions to infer a total length or area when it is straightforward.`,
        `- Avoid wild guessing. When a value is not clearly stated or reasonably inferred from dimensions/scale, leave that field as an empty string ("").`,
        `- If you approximate a value using the scale, keep it reasonable and mention the assumption in unusual_items, structural_notes, or estimation_data.plot_grading_notes.`,
        `- Do NOT invent obviously unrealistic numbers.`,
      ]
    : [
        `Your job:`,
        `1) Carefully read ALL visible notes, schedules, and callouts on the foundation/structural plan.`,
        `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
        `3) Avoid vague wording. When possible, include actual numbers (sizes, spacings, strengths).`,
        ``,
        `Foundation & structural quantity rules (very important):`,
        `- You MUST group foundation walls into buckets by HEIGHT and THICKNESS and report total LF for each group in estimation_data.walls_by_height.`,
        `- You MUST group footings into buckets by WIDTH and THICKNESS and report total LF for each group in estimation_data.footings_by_size.`,
        `- You MUST list each distinct slab zone (basement slab, garage slab, porch slab, etc.) with thickness and area in estimation_data.slabs.`,
        ``,
        `For estimation_data.walls_by_height:`,
        `- Each item represents a group of walls with the same nominal height and thickness.`,
        `- height_ft: the typical clear height (e.g. "8", "9", "10").`,
        `- thickness_in: nominal wall thickness (e.g. "8", "10").`,
        `- length_lf: total linear footage of wall at that height/thickness (sum multiple segments).`,
        `- notes: short description (e.g. "Basement soil side", "Garage retaining", "Crawlspace stemwalls").`,
        ``,
        `For estimation_data.footings_by_size:`,
        `- Each item represents a group of continuous or spread footings with the same width and thickness.`,
        `- width_in: footing width (e.g. "16", "24").`,
        `- thickness_in: footing thickness (e.g. "8", "12").`,
        `- length_lf: total linear footage using that size (sum segments and pads as equivalent LF when reasonable).`,
        `- notes: short description (e.g. "Continuous under basement walls", "Porch/column pads").`,
        ``,
        `For estimation_data.slabs:`,
        `- Each item represents a slab area relevant to WCF's work (basement slab, garage slab, porch stoops, patios if shown).`,
        `- location: human label ("Basement slab", "Garage slab", "Porch slab", etc.).`,
        `- thickness_in: slab thickness from notes or typical details (e.g. "4").`,
        `- area_sqft: total slab area in square feet for that zone.`,
        `- notes: short description (e.g. "Interior slab, 3000 psi", "Garage slab with thickened edge").`,
        ``,
        `If an item truly is not present or cannot be read, leave that field as an empty string or leave the array empty. Do NOT make up numbers.`,
        ``,
        `Important:`,
        `- Include any wall heights, slab thicknesses, footing sizes, and concrete strengths you can read.`,
        `- Include key rebar sizes and spacings (e.g., "#4 @ 12\\" o.c. horiz / vert") in estimation_data.rebar_summary.`,
        `- Note special features that affect cost (retaining conditions, turndowns, piers, caissons, thickened slabs, etc.) in retaining_conditions or structural_notes.`,
        `- Prefer explicit dimensions and schedules. You may sum lengths when it is straightforward, but avoid wild guessing.`,
        `- If the subdivision name is visible anywhere, put it in lot_info.subdivision.`,
      ];

  const contextLines = [
    ``,
    `Context (may help you interpret the plan):`,
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project   ? `Project: ${project}`       : '',
    address   ? `Address: ${address}`       : '',
    builder   ? `Builder: ${builder}`       : '',
    community ? `Community: ${community}`   : '',
    docType   ? `Document type: ${docType}` : '',
  ].filter(Boolean);

  return [...headerLines, ...jobLines, ...contextLines].join('\n');
}

// ---- MAIN ENDPOINT: supports BOTH images and PDFs ----
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

    // If we *know* it's an image, never force it to PDF.
    if (!isPdf && !hasImgExt && !isExplicitImgType) {
      // Ambiguous URL (your usual case from Drive) → assume PDF
      isPdf = true;
    }

    // Multimodal content: system-like prompt + either file or image
    const content = [
      {
        type: 'input_text',
        text: buildPrompt(extraContext, estimateId),
      },
    ];

    if (isPdf) {
  // 🔥 Rasterize PDF to high-DPI images
  const pageImages = await rasterizePdfToImages(url, 350, 3);

  pageImages.forEach((img) => {
    content.push({
      type: 'input_image',
      image_url: img,
    });
  });
} else {
  // Regular image path
  content.push({
    type: 'input_image',
    image_url: url,
  });
}

    const response = await client.responses.create({
      model: 'gpt-5.2',
      temperature: 0,
      top_p: 1,
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'wc_foundation_summary',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              lot_info: {
                type: 'object',
                properties: {
                  lot_number:  { type: 'string' },
                  block:       { type: 'string' },
                  subdivision: { type: 'string' },
                },
                required: ['lot_number', 'block', 'subdivision'],
                additionalProperties: false,
              },

              foundation_type: { type: 'string' },
              garage_type:     { type: 'string' },
              porch_count:     { type: 'integer' },
              basement_notes:  { type: 'string' },

              structural_notes: { type: 'string' },

               estimation_data: {
                type: 'object',
                properties: {
                  // --- Scalar fields shared by plot + structural ---
                  basement_wall_height_ft:    { type: 'string' },
                  basement_wall_thickness_in: { type: 'string' },
                  basement_perimeter_ft:      { type: 'string' },
                  footing_width_in:           { type: 'string' },
                  footing_thickness_in:       { type: 'string' },
                  frost_depth_in:             { type: 'string' },
                  slab_thickness_in:          { type: 'string' },
                  concrete_strength_psi:      { type: 'string' },
                  garage_slab_sqft:           { type: 'string' },
                  basement_slab_sqft:         { type: 'string' },
                  porch_sqft_total:           { type: 'string' },
                  driveway_sqft:              { type: 'string' },
                  retaining_conditions:       { type: 'string' },
                  rebar_summary:              { type: 'string' },

                  water_service_length_ft:     { type: 'string' },
                  water_service_length_method: { type: 'string' },
                  sewer_service_length_ft:     { type: 'string' },
                  sewer_service_length_method: { type: 'string' },
                  lot_area_sqft:               { type: 'string' },
                  house_footprint_area_sqft:   { type: 'string' },
                  grading_area_sqft:           { type: 'string' },
                  top_of_foundation_elev_ft:   { type: 'string' },
                  foundation_wall_total_lf:    { type: 'string' },
                  plot_grading_notes:          { type: 'string' },

                  // NEW: reference grade elevation at street/sidewalk/curb
                  reference_grade_elev_ft:     { type: 'string' },

                  // --- NEW arrays (can be empty when unknown) ---

                  // Groups of walls by height & thickness
                  walls_by_height: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        height_ft:    { type: 'string' }, // e.g. "8", "9", "10"
                        thickness_in: { type: 'string' }, // e.g. "8", "10"
                        length_lf:    { type: 'string' }, // total LF for this group
                        notes:        { type: 'string' }, // e.g. "Basement soil side"
                      },
                      required: ['height_ft', 'thickness_in', 'length_lf', 'notes'],
                      additionalProperties: false,
                    },
                  },

                  // Groups of footings by width & thickness
                  footings_by_size: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        width_in:    { type: 'string' }, // e.g. "16", "24"
                        thickness_in:{ type: 'string' }, // e.g. "8", "12"
                        length_lf:   { type: 'string' }, // total LF for this group
                        notes:       { type: 'string' }, // e.g. "Continuous under basement walls"
                      },
                      required: ['width_in', 'thickness_in', 'length_lf', 'notes'],
                      additionalProperties: false,
                    },
                  },

                  // Individual slab zones (basement, garage, porch, etc.)
                  slabs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        location:     { type: 'string' }, // "Basement slab", "Garage slab", etc.
                        thickness_in: { type: 'string' }, // e.g. "4"
                        area_sqft:    { type: 'string' }, // slab area in SF
                        notes:        { type: 'string' }, // short description
                      },
                      required: ['location', 'thickness_in', 'area_sqft', 'notes'],
                      additionalProperties: false,
                    },
                  },
                },

                // strict mode: MUST list *all* keys from properties here.
                // The model can still use "" or [] when it genuinely can't read a value.
                required: [
                  'basement_wall_height_ft',
                  'basement_wall_thickness_in',
                  'basement_perimeter_ft',
                  'footing_width_in',
                  'footing_thickness_in',
                  'frost_depth_in',
                  'slab_thickness_in',
                  'concrete_strength_psi',
                  'garage_slab_sqft',
                  'basement_slab_sqft',
                  'porch_sqft_total',
                  'driveway_sqft',
                  'retaining_conditions',
                  'rebar_summary',
                  'water_service_length_ft',
                  'water_service_length_method',
                  'sewer_service_length_ft',
                  'sewer_service_length_method',
                  'lot_area_sqft',
                  'house_footprint_area_sqft',
                  'grading_area_sqft',
                  'top_of_foundation_elev_ft',
                  'foundation_wall_total_lf',
                  'plot_grading_notes',
                  'reference_grade_elev_ft',
                  'walls_by_height',
                  'footings_by_size',
                  'slabs',
                ],
                additionalProperties: false,
              },


              unusual_items: {
                type: 'array',
                items: { type: 'string' },
              },

              inspection_requirements: {
                type: 'array',
                items: { type: 'string' },
              },

              code_references: {
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
              'structural_notes',
              'estimation_data',
              'unusual_items',
              'inspection_requirements',
              'code_references',
              'quick_summary',
            ],
            additionalProperties: false,
          },
        },
      },
    });

    // ---- Safely extract the JSON text ----
    let jsonText = '';

    if (typeof response.output_text === 'string' && response.output_text.trim()) {
      jsonText = response.output_text;
    } else if (
      Array.isArray(response.output) &&
      response.output[0] &&
      response.output[0].content &&
      response.output[0].content[0] &&
      typeof response.output[0].content[0].text === 'string'
    ) {
      jsonText = response.output[0].content[0].text;
    }

    if (!jsonText) {
      console.error('No JSON text returned from model:', JSON.stringify(response, null, 2));
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Model did not return JSON text in output.',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse JSON schema output:', e);
      console.error('Raw output_text:', jsonText);
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Could not parse JSON output.',
      });
    }

    // Backward-compatible payload for Apps Script
    res.json({
      success: true,
      source: isPdf ? 'pdf' : 'image',
      model: parsed,       // <- what Apps Script uses now
      data: parsed,        // <- legacy alias
      raw: jsonText,       // <- for logging/debug in the sheet
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

