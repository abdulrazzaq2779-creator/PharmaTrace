import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';

/**
 * /api/scan — server-side vision analysis.
 *
 * The API key lives ONLY in server environment variables; it is never bundled
 * into frontend code. Supported providers (first match wins):
 *   OPENAI_API_KEY        (+ optional OPENAI_BASE_URL, OPENAI_VISION_MODEL)
 *   OPENROUTER_API_KEY    (+ optional OPENROUTER_VISION_MODEL)
 *
 * With no key configured the route returns 501 and the client falls back to
 * on-device Tesseract.js. The route NEVER returns fabricated data.
 */

interface ScanRequestBody {
  image?: string;
}

interface VisionField {
  value: string;
  confidence: 'high' | 'medium' | 'low';
}

interface VisionAnalysis {
  usable: boolean;
  reject_reason?: string;
  fields: Partial<Record<string, VisionField | null>>;
  text_lines: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }>;
  unreadable_regions?: Array<{ bbox: { x0: number; y0: number; x1: number; y1: number }; reason: string }>;
}

const SYSTEM_PROMPT = `You are a pharmaceutical package text extractor. You receive a photo of a medicine package, blister strip, or label.

Extract ONLY text that is actually visible. Never guess or infer from brand names. If a value is not readable, set it to null.

Return STRICT JSON (no markdown fences) with this shape:
{
  "usable": boolean,            // true only if this is a medicine pack/strip/label
  "reject_reason": string|null, // why not usable, e.g. "A cat, not a medicine package"
  "fields": {
    "brand_name":        { "value": string, "confidence": "high"|"medium"|"low" } | null,
    "composition":       { "value": string, "confidence": "..." } | null,  // ingredient(s) + strength(s), e.g. "Amlodipine 5mg + Atenolol 50mg"
    "dosage_form":       { "value": string, "confidence": "..." } | null,  // tablet/capsule/syrup/injection...
    "manufacturer_name": { "value": string, "confidence": "..." } | null,
    "marketer_name":     { "value": string, "confidence": "..." } | null,
    "manufacturing_license_no": { "value": string, "confidence": "..." } | null,
    "batch_no":          { "value": string, "confidence": "..." } | null,
    "mfg_date":          { "value": string, "confidence": "..." } | null,  // normalize to MM/YYYY when month+year visible
    "expiry_date":       { "value": string, "confidence": "..." } | null,  // normalize to MM/YYYY
    "mrp":               { "value": string, "confidence": "..." } | null,
    "schedule_marking":  { "value": string, "confidence": "..." } | null,  // Rx, Schedule H/H1/X...
    "qr_or_barcode_present": { "value": "yes"|"no", "confidence": "..." } | null,
    "pill_imprint":      { "value": string, "confidence": "..." } | null
  },
  "text_lines": [ { "text": string, "bbox": {"x0":int,"y0":int,"x1":int,"y1":int}, "confidence": 0-100 } ],
  "unreadable_regions": [ { "bbox": {...}, "reason": string } ]
}

text_lines must list every line you can read in reading order with pixel bounding boxes on the provided image. Also check the image rotated 90° in your analysis: if text is printed sideways (common on blister strips), read it and include those lines too. If the image is too blurry to read reliably, mark confidences "low" and say so in unreadable_regions. If the image is not a medicine product, set usable=false and all fields null.`;

interface ProviderConfig {
  url: string;
  apiKey: string;
  model: string;
  headerName: string;
  headerPrefix: string;
}

function resolveProvider(): ProviderConfig | null {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    return {
      url: `${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`,
      apiKey: openAiKey,
      model: process.env.OPENAI_VISION_MODEL ?? 'gpt-4o-mini',
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
    };
  }
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openRouterKey,
      model: process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-flash-1.5',
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
    };
  }
  return null;
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 15 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function extractJson(text: string): VisionAnalysis {
  // Tolerate markdown fences around the JSON.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model returned no JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as VisionAnalysis;
}

async function callVisionProvider(provider: ProviderConfig, imageDataUrl: string): Promise<VisionAnalysis> {
  const response = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [provider.headerName]: `${provider.headerPrefix}${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract all visible medicine package text per the system instructions.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Vision provider error ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content ?? '';
  return extractJson(content);
}

/** Vite dev/preview middleware mounting POST /api/scan. */
export function configureScanApi(middlewares: Connect.Server): void {
  middlewares.use('/api/scan', (req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'Method not allowed' });
        return;
      }

      const provider = resolveProvider();
      if (!provider) {
        json(res, 501, { error: 'No vision API key configured on the server (OPENAI_API_KEY or OPENROUTER_API_KEY).' });
        return;
      }

      try {
        const body = JSON.parse(await readBody(req)) as ScanRequestBody;
        if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) {
          json(res, 400, { error: 'Send { image: "<jpeg data url>" }' });
          return;
        }
        console.log('[api/scan] sending image to vision model', provider.model, `${Math.round(body.image.length / 1024)} KB`);
        const analysis = await callVisionProvider(provider, body.image);
        console.log('[api/scan] vision model returned', analysis.usable ? 'usable' : 'not usable');
        json(res, 200, analysis);
      } catch (error) {
        console.error('[api/scan] analysis failed:', error);
        json(res, 502, { error: 'Could not analyze image' });
      }
    })();
  });
}
