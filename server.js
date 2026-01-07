// server.js (NUCLEAR: Poppler rasterization, no pdf.js)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const app = express();
const port = process.env.PORT || 3000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Vision calls will fail until you set it.');
}

const client = new OpenAI();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * ========= CONFIG =========
 */
const MAX_PAGES = 4;
const DPI = 800; // real blueprint clarity
const PDF_FETCH_TIMEOUT_MS = 120000;
const MAX_PDF_BYTES = 85 * 1024 * 1024; // civil PDFs allowed

/**
 * ========= PROMPT BUILDER (yours, unchanged) =========
 */
function buildPrompt(extraContext = {}, estimateId) {
  const { project, address, builder, community, docType } = extraContext || {};
  const docLower = (docType || '').toString().toLowerCase();
  const isPlotOrGrading = docLower.includes('plot') || docLower.includes('grading');

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
        `- If Top of Foundation is given as a full elevation (e.g., 4787.8) and a spot grade is shown as a shorter number (e.g., 84.8), you MUST assume the spot grade shares the same leading digits as the TOF.`,
        `- Always output top_of_foundation_elev_ft and reference_grade_elev_ft as FULL elevations in feet (e.g., 4784.8), not shorthand.`,
        `- If you are not confident, leave reference_grade_elev_ft blank and explain why in plot_grading_notes.`,
        ``,
        `Water / sewer measurement rules (very important):`,
        `- Identify the W (water meter pit) and S (sewer stub) symbols.`,
        `- If an explicit utility line is drawn, use that route to determine the service path.`,
        `- If NO utility line is drawn, assume the shortest reasonable straight-line path from the W or S symbol to the nearest logical foundation entry point.`,
        `- If a scale note or graphic scale bar is present, estimate lengths using that scale.`,
        `- Use dimension text when available. Otherwise measure using the scale and provide a reasonable estimate in feet (rounded).`,
        ``,
        `Reference grade elevation (for dirt balance):`,
        `- Choose ONE representative existing grade elevation at the street/sidewalk/curb directly in front of the house.`,
        `- If none visible, leave reference_grade_elev_ft empty.`,
      ]
    : [
        `Your job:`,
        `1) Carefully read ALL visible notes, schedules, and callouts on the foundation/structural plan.`,
        `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
        `3) Avoid vague wording. When possible, include actual numbers (sizes, spacings, strengths).`,
        ``,
        `Foundation & structural quantity rules (very important):`,
        `- Group foundation walls by HEIGHT and THICKNESS in estimation_data.walls_by_height.`,
        `- Group footings by WIDTH and THICKNESS in estimation_data.footings_by_size.`,
        `- List each slab zone with thickness and area in estimation_data.slabs.`,
        ``,
        `If unknown, use "" or empty arrays. Do NOT make up numbers.`,
      ];

  const contextLines = [
    ``,
    `Context (may help you interpret the plan):`,
    `Estimate ID: ${estimateId || 'Unknown'}`,
    project ? `Project: ${project}` : '',
    address ? `Address: ${address}` : '',
    builder ? `Builder: ${builder}` : '',
    community ? `Community: ${community}` : '',
    docType ? `Document type: ${docType}` : '',
  ].filter(Boolean);

  return [...headerLines, ...jobLines, ...contextLines].join('\n');
}

/**
 * ========= PDF -> PNG (Poppler: pdftoppm) =========
 */
async function downloadToTempFile(url, ext = '.pdf') {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to download file: HTTP ${res.status}`);

    const contentLen = res.headers.get('content-length');
    if (contentLen && Number(contentLen) > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${contentLen} bytes).`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${buf.length} bytes).`);
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-vision-'));
    const filePath = path.join(tmpDir, `input${ext}`);
    await fs.writeFile(filePath, buf);
    return { tmpDir, filePath };
  } finally {
    clearTimeout(t);
  }
}

async function rasterizePdfToImagesPoppler(pdfUrl, {
  dpi = DPI,
  maxPages = MAX_PAGES,
  maxPixels = 140_000_000, // 140 MP ≈ perfect blueprint clarity, safe + cheap
} = {}) {

  await execFileAsync('pdftoppm', ['-h']);
  const { tmpDir, filePath } = await downloadToTempFile(pdfUrl, '.pdf');
  const outPrefix = path.join(tmpDir, 'page');

  try {
    let safeDpi = dpi;

    try {
      const { stdout } = await execFileAsync('pdfinfo', [filePath], { maxBuffer: 2 * 1024 * 1024 });
      const m = stdout.match(/Page\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/i);

      if (m) {
        const w = (parseFloat(m[1]) / 72) * dpi;
        const h = (parseFloat(m[2]) / 72) * dpi;
        const pixels = w * h;

        if (pixels > maxPixels) {
          const factor = Math.sqrt(maxPixels / pixels);
          safeDpi = Math.floor(dpi * factor);
        }
      }
    } catch {}

    const args = [
      '-png',
      '-r', String(safeDpi),
      '-aa', 'yes',
      '-aaVector', 'yes',
      '-thinLineMode', 'solid',
      '-f', '1',
      '-l', String(maxPages),
      filePath,
      outPrefix,
    ];

    await execFileAsync('pdftoppm', args, { maxBuffer: 500 * 1024 * 1024 });

    const images = [];
    for (let i = 1; i <= maxPages; i++) {
      try {
        const img = await fs.readFile(`${outPrefix}-${i}.png`);
        images.push(`data:image/png;base64,${img.toString('base64')}`);
      } catch { break; }
    }

    if (!images.length) throw new Error('Rasterization produced no images.');
    return images;

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * ========= MAIN ENDPOINT =========
 */
app.post('/analyze-plan', async (req, res) => {
  try {
    const internalKey = req.headers['x-internal-key'];
    if (!INTERNAL_API_KEY || internalKey !== INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { estimateId, imageUrl, fileUrl, fileType, extraContext } = req.body || {};
    const url = fileUrl || imageUrl;

    if (!url) return res.status(400).json({ error: 'Missing file/image URL' });

    const lowerUrl = String(url).toLowerCase();
    const lowerType = (fileType || '').toLowerCase();

    const hasPdfExt = /\.pdf(\?|$)/.test(lowerUrl);
    const hasImgExt = /\.(png|jpg|jpeg|gif|webp)(\?|$)/.test(lowerUrl);

    const isExplicitPdfType = lowerType === 'pdf';
    const isExplicitImgType = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(lowerType);

    let isPdf = isExplicitPdfType || hasPdfExt;

    // Ambiguous Drive URL → assume PDF unless it clearly looks like an image
    if (!isPdf && !hasImgExt && !isExplicitImgType) isPdf = true;

    const content = [
      { type: 'input_text', text: buildPrompt(extraContext, estimateId) },
    ];

    if (isPdf) {
      const docLower = String(extraContext?.docType || '').toLowerCase();
  const isPlot = docLower.includes('plot') || docLower.includes('grading');

  // Plot plans benefit from higher DPI; structural plans blow up fast
  const dpi = isPlot ? 750 : 450;

const pageImages = await rasterizePdfToImagesPoppler(url, {
  dpi,
  maxPages: isPlot ? 4 : 3,
  maxPixels: isPlot ? 90_000_000 : 45_000_000,
});

      pageImages.forEach((img) => content.push({ type: 'input_image', image_url: img }));
    } else {
      content.push({ type: 'input_image', image_url: url });
    }

    const response = await client.responses.create({
      model: 'gpt-5.2',
      temperature: 0,
      top_p: 1,
      input: [{ role: 'user', content }],
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
              structural_notes:{ type: 'string' },

              estimation_data: {
                type: 'object',
                properties: {
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
                  reference_grade_elev_ft:     { type: 'string' },

                  walls_by_height: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        height_ft:    { type: 'string' },
                        thickness_in: { type: 'string' },
                        length_lf:    { type: 'string' },
                        notes:        { type: 'string' },
                      },
                      required: ['height_ft', 'thickness_in', 'length_lf', 'notes'],
                      additionalProperties: false,
                    },
                  },

                  footings_by_size: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        width_in:     { type: 'string' },
                        thickness_in: { type: 'string' },
                        length_lf:    { type: 'string' },
                        notes:        { type: 'string' },
                      },
                      required: ['width_in', 'thickness_in', 'length_lf', 'notes'],
                      additionalProperties: false,
                    },
                  },

                  slabs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        location:     { type: 'string' },
                        thickness_in: { type: 'string' },
                        area_sqft:    { type: 'string' },
                        notes:        { type: 'string' },
                      },
                      required: ['location', 'thickness_in', 'area_sqft', 'notes'],
                      additionalProperties: false,
                    },
                  },
                },
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

    const jsonText = (typeof response.output_text === 'string' && response.output_text.trim())
      ? response.output_text
      : '';

    if (!jsonText) {
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Model did not return output_text.',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Could not parse JSON output.',
      });
    }

    res.json({
      success: true,
      source: isPdf ? 'pdf' : 'image',
      model: parsed,
      data: parsed,
      raw: jsonText,
    });
  } catch (err) {
    console.error('Vision error:', err);
    res.status(500).json({
      error: 'Vision service failed',
      details: err?.message || String(err),
    });
  }
});

app.get('/', (_req, res) => res.send('wc-vision-service is alive 🦁'));

app.listen(port, () => console.log(`wc-vision-service listening on port ${port}`));


