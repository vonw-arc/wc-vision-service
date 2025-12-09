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
    `OUTPUT RULES (VERY IMPORTANT):`,
    `- You must output ONLY a single JSON object.`,
    `- That JSON object must strictly match the "wc_foundation_summary" schema provided by the tool.`,
    `- Do NOT include any commentary, Markdown, or explanations outside the JSON.`,
    `- Every required field in the schema MUST be present.`,
    `- When a value is not shown or cannot be reliably inferred, use an empty string "" for that field.`,
    ``,
  ];

  const jobLines = isPlotOrGrading
    ? [
        `Your job:`,
        `1) Carefully read ALL visible notes, schedules, callouts, dimension strings, utility symbols (W/S), and scale/graphic bars on the plot/grading plan.`,
        `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
        `3) Focus especially on:`,
        `   - Water service route and length from meter pit (W) to house (estimation_data.water_service_length_ft).`,
        `   - Sanitary sewer route and length from stub (S) to house (estimation_data.sewer_service_length_ft).`,
        `   - Lot area (estimation_data.lot_area_sqft).`,
        `   - House footprint area (estimation_data.house_footprint_area_sqft).`,
        `   - Grading area = lot area minus house footprint (estimation_data.grading_area_sqft) when both are known.`,
        `   - Top of foundation elevation (estimation_data.top_of_foundation_elev_ft).`,
        `   - Total foundation wall linear footage if reasonably determinable (estimation_data.foundation_wall_total_lf).`,
        `   - Any notable options, grading-related conditions, or assumptions (estimation_data.plot_grading_notes).`,
        ``,
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
        `- For <service>_length_method, use one of:`,
        `     "dimension_text"              (length is clearly labeled with a dimension),`,
        `     "scale_bar_approx"           (estimated via scale note or graphic scale bar),`,
        `     "inferred_from_property_dims" (inferred from known lot dimensions and offsets),`,
        `     "assumed_straight_path"      (no route drawn; assumed shortest reasonable path),`,
        `     "unknown"                    (cannot determine length).`,
        `- If you assumed a straight-line path, explicitly use "assumed_straight_path" and briefly explain in estimation_data.plot_grading_notes.`,
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
        ``,
        `Quick summary:`,
        `- quick_summary must be a short, estimator-friendly sentence or two describing:`,
        `  foundation type, main wall height/thickness (if visible), concrete strength, utility lengths, and any notable grading/retaining conditions.`,
      ]
    : [
        `Your job:`,
        `1) Carefully read ALL visible notes, schedules, and callouts.`,
        `2) Extract SPECIFIC, ESTIMATION-READY DATA into the JSON schema fields provided.`,
        `3) Avoid vague wording. When possible, include actual numbers (sizes, spacings, strengths).`,
        ``,
        `For estimation_data, focus on:`,
        `- basement_wall_height_ft, basement_wall_thickness_in, basement_perimeter_ft.`,
        `- footing_width_in, footing_thickness_in, frost_depth_in.`,
        `- slab_thickness_in, concrete_strength_psi.`,
        `- garage_slab_sqft, basement_slab_sqft, porch_sqft_total, driveway_sqft.`,
        `- retaining_conditions and rebar_summary.`,
        `- foundation_wall_total_lf if determinable from dimensions/scale.`,
        ``,
        `If an item truly is not present or cannot be read, leave that field as an empty string. Do NOT make up numbers.`,
        ``,
        `Important:`,
        `- Include any wall heights, slab thicknesses, footing sizes, and concrete strengths you can read.`,
        `- Include key rebar sizes and spacings (e.g., "#4 @ 12\\" o.c. horiz / vert").`,
        `- Note special features that affect cost (retaining conditions, turndowns, piers, thickened slabs, etc.).`,
        `- If the subdivision name is visible anywhere, put it in lot_info.subdivision.`,
        ``,
        `Quick summary:`,
        `- quick_summary must briefly state the main concrete sizes and system:`,
        `  e.g. "9' basement, 8\\" walls with (2) #4 top/bottom and #5 @18\\" o.c. soil side,`,
        `       10\\" x 20\\" footings, 4\\" 3000 psi basement and garage slabs."`,
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

    // Multimodal content: prompt + either file or image
    const content = [
      {
        type: 'input_text',
        text: buildPrompt(extraContext, estimateId),
      },
    ];

    if (isPdf) {
      content.push({
        type: 'input_file',
        file_url: url,
      });
    } else {
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
      response_format: {
        type: 'json_schema',
        json_schema: {
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
                  // Existing foundation-focused fields
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

                  // Plot/grading-focused fields
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
      temperature: 0.1,
      max_output_tokens: 2000,
    });

    // Responses API: read the text content
    const firstOutput = response.output && response.output[0];
    const firstContent = firstOutput && firstOutput.content && firstOutput.content[0];
    const jsonText = firstContent && firstContent.text;

    if (!jsonText) {
      console.error('No text content in vision response:', JSON.stringify(response, null, 2));
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'No text content returned from model.',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Failed to parse JSON schema output:', e);
      console.error('Raw output text:', jsonText);
      return res.status(500).json({
        error: 'Vision service failed',
        details: 'Could not parse JSON output.',
      });
    }

    // IMPORTANT: shape this to match what Apps Script expects (model + raw)
    res.json({
      success: true,
      source: isPdf ? 'pdf' : 'image',
      model: parsed,
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

app.get('/', (_req, res) => {
  res.send('wc-vision-service is alive 🦁');
});

app.listen(port, () => {
  console.log(`wc-vision-service listening on port ${port}`);
});
