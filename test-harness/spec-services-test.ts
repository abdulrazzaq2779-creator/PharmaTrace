/**
 * Harness for the new spec services: GS1/URL parsing, identification chain,
 * drug classes, batch lookup, code checks. No medicine values are hardcoded
 * in the app flow — reference data comes from JSON files.
 */
import {
  parseCodePayload,
  looksLikeUrl,
} from '../src/services/barcode';
import { classifyComposition, identifyProduct, lookupBatchInfo } from '../src/services/identify';
import { runCodeChecks, runBatchInfoCheck } from '../src/utils/checks';

let passCount = 0;
let failCount = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount++;
    console.log(`  PASS ${name}`);
  } else {
    failCount++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// GS1 / URL payload parsing
// ---------------------------------------------------------------------------

console.log('\n[GS1 bracketed]');
{
  const parsed = parseCodePayload('(01)08712345000012(10)ABC123(17)261031(21)S987');
  check('kind=gs1', parsed.kind === 'gs1');
  check('gtin parsed', parsed.gtin === '08712345000012', JSON.stringify(parsed.gtin));
  check('batch parsed', parsed.batch === 'ABC123', JSON.stringify(parsed.batch));
  check('expiry parsed to MM/YYYY', parsed.expiry === '10/2026', JSON.stringify(parsed.expiry));
  check('serial parsed', parsed.serial === 'S987');
}

console.log('\n[GS1 FNC1]');
{
  const parsed = parseCodePayload('0108712345000012\u001d10ABC123\u001d17261031');
  check('kind=gs1', parsed.kind === 'gs1');
  check('gtin parsed', parsed.gtin === '08712345000012', JSON.stringify(parsed.gtin));
  check('batch parsed', parsed.batch === 'ABC123', JSON.stringify(parsed.batch));
  check('expiry parsed', parsed.expiry === '10/2026', JSON.stringify(parsed.expiry));
}

console.log('\n[URL + security]');
{
  check('http url detected', looksLikeUrl('http://example.com/verify?x=1'));
  check('https url detected', looksLikeUrl('https://verify.example-pharma.com/g/abc'));
  check('plain text not url', !looksLikeUrl('LOT42-EXP2027'));
  const parsed = parseCodePayload('https://verify.example-pharma.com/g/abc');
  check('kind=url', parsed.kind === 'url');
  check('domain extracted', parsed.domain === 'verify.example-pharma.com', JSON.stringify(parsed.domain));
  const bad = parseCodePayload('http://bad url with spaces');
  check('invalid url has no domain crash', bad.kind === 'url' && bad.domain === '');
}

console.log('\n[plain payload]');
{
  const parsed = parseCodePayload('JUST-SOME-TEXT-1234');
  check('kind=plain', parsed.kind === 'plain');
}

// ---------------------------------------------------------------------------
// Drug classes
// ---------------------------------------------------------------------------

console.log('\n[drug classes]');
{
  const bp = classifyComposition('Amlodipine 5mg + Atenolol 50mg');
  check('amlodipine+atenolol → blood pressure', bp?.classes.includes('Blood pressure (antihypertensive)') === true, JSON.stringify(bp));
  const dm = classifyComposition('Glimepiride 2mg + Metformin 1000mg');
  check('metformin+glimepiride → diabetes', dm?.classes.includes('Diabetes (antidiabetic)') === true, JSON.stringify(dm));
  const statin = classifyComposition('Atorvastatin 10mg');
  check('atorvastatin → cholesterol', statin?.classes.includes('Cholesterol (statin)') === true, JSON.stringify(statin));
  const unknown = classifyComposition('Unobtainium 5mg');
  check('unknown ingredient → null', unknown === null, JSON.stringify(unknown));
  check('undefined → null', classifyComposition(undefined) === null);
}

// ---------------------------------------------------------------------------
// Batch lookup + format check
// ---------------------------------------------------------------------------

console.log('\n[batch lookup]');
{
  const known = lookupBatchInfo('G652046', 'Mankind Pharma');
  check('known batch → reference found', known.reference?.product === 'Amlokind AT', JSON.stringify(known.reference));
  const unknownBatch = lookupBatchInfo('ZZZ999', 'Mankind Pharma');
  check('unknown batch → null reference', unknownBatch.reference === null);
  check('no pattern file entry → unknown format check', known.formatCheck?.status === 'unknown', JSON.stringify(known.formatCheck));
}

// ---------------------------------------------------------------------------
// Identification fallback chain
// ---------------------------------------------------------------------------

const emptyFields = {
  brand_name: null,
  composition: null,
  dosage_form: null,
  manufacturer_name: null,
  marketer_name: null,
  manufacturing_license_no: null,
  batch_no: null,
  mfg_date: null,
  expiry_date: null,
  mrp: null,
  schedule_marking: null,
  qr_or_barcode_present: null,
  pill_imprint: null,
} as const;

console.log('\n[identification chain]');
{
  // (a) code URL + brand text
  const urlFields = { ...emptyFields, brand_name: { value: 'Amlokind AT', confidence: 'high' as const, origin: 'image' as const } };
  const viaUrl = identifyProduct(urlFields, [{ payload: 'https://verify.example.com/g/1', format: 'QR_CODE', source: 'zxing' }], []);
  check('code-url identifies with method label', viaUrl?.method === 'code-url' && viaUrl.productName === 'Amlokind AT', JSON.stringify(viaUrl));

  // GS1 code without catalog GTIN → low-confidence code-gtin lead
  const viaGs1 = identifyProduct(emptyFields, [{ payload: '0108712345000012\u001d10ABC123', format: 'DATA_MATRIX', source: 'zxing' }], []);
  check('gs1 without catalog → code-gtin low', viaGs1?.method === 'code-gtin' && viaGs1.confidence === 'low', JSON.stringify(viaGs1));

  // (b) composition
  const compFields = { ...emptyFields, composition: { value: 'Glimepiride 2mg + Metformin 1000mg', confidence: 'high' as const, origin: 'image' as const } };
  const viaComp = identifyProduct(compFields, [], []);
  check('composition → method composition', viaComp?.method === 'composition', JSON.stringify(viaComp));

  // (c) fuzzy brand vs products.json (Amlokind AT is in the catalog)
  const brandFields = { ...emptyFields, brand_name: { value: 'Amlokind-AT', confidence: 'low' as const, origin: 'image' as const } };
  const viaFuzzy = identifyProduct(brandFields, [], []);
  check('fuzzy brand → Amlokind AT', viaFuzzy?.method === 'fuzzy-brand' && viaFuzzy.productName === 'Amlokind AT', JSON.stringify(viaFuzzy));

  // (d) pill imprint
  const pillFields = { ...emptyFields, pill_imprint: { value: 'I-2', confidence: 'low' as const, origin: 'image' as const } };
  const viaPill = identifyProduct(pillFields, [], []);
  check('pill imprint → method pill', viaPill?.method === 'pill', JSON.stringify(viaPill));

  // (e) user typed
  const viaUser = identifyProduct(emptyFields, [], [], 'Some Medicine');
  check('user typed → method user', viaUser?.method === 'user' && viaUser.productName === 'Some Medicine', JSON.stringify(viaUser));

  // nothing at all → null (never invent)
  check('no signals → null', identifyProduct(emptyFields, [], []) === null);

  // priority: code beats composition
  const bothFields = { ...emptyFields, composition: { value: 'Metformin 500mg', confidence: 'high' as const, origin: 'image' as const } };
  const viaBoth = identifyProduct(bothFields, [{ payload: 'https://x.example.com', format: 'QR_CODE', source: 'zxing' }], []);
  check('code outranks composition', viaBoth?.method === 'code-url', JSON.stringify(viaBoth));
}

// ---------------------------------------------------------------------------
// Code checks (readable + cross-check)
// ---------------------------------------------------------------------------

console.log('\n[code checks]');
{
  const noCodes = runCodeChecks(emptyFields, []);
  check('no codes → unavailable, never fail', noCodes[0].status === 'unavailable' && !noCodes.some(c => c.status === 'fail'), JSON.stringify(noCodes));

  const readable = runCodeChecks(emptyFields, [{ payload: 'https://x.example.com', format: 'QR_CODE', source: 'zxing' }]);
  check('readable → pass + authenticity note', readable[0].status === 'pass' && /does NOT prove/i.test(readable[0].reason), JSON.stringify(readable[0]));

  // batch mismatch = fail
  const fieldsBatch = { ...emptyFields, batch_no: { value: 'ZZZ999', confidence: 'high' as const, origin: 'image' as const } };
  const mismatch = runCodeChecks(fieldsBatch, [{ payload: '(01)08712345000012(10)ABC123(17)261031', format: 'DATA_MATRIX', source: 'zxing' }]);
  const batchCheck = mismatch.find(c => c.id === 'code-batch-match');
  check('batch mismatch → fail with spec reason', batchCheck?.status === 'fail' && batchCheck.reason === 'Printed batch differs from the code.', JSON.stringify(batchCheck));

  // batch match = pass
  const fieldsMatch = { ...emptyFields, batch_no: { value: 'ABC123', confidence: 'high' as const, origin: 'image' as const } };
  const match = runCodeChecks(fieldsMatch, [{ payload: '(01)08712345000012(10)ABC123(17)261031', format: 'DATA_MATRIX', source: 'zxing' }]);
  check('batch match → pass', match.find(c => c.id === 'code-batch-match')?.status === 'pass');

  // expiry mismatch = fail
  const fieldsExp = { ...emptyFields, expiry_date: { value: '05/2027', confidence: 'high' as const, origin: 'image' as const } };
  const expMismatch = runCodeChecks(fieldsExp, [{ payload: '(01)08712345000012(10)ABC123(17)261031', format: 'DATA_MATRIX', source: 'zxing' }]);
  const expCheck = expMismatch.find(c => c.id === 'code-expiry-match');
  check('expiry mismatch → fail', expCheck?.status === 'fail', JSON.stringify(expCheck));
}

// ---------------------------------------------------------------------------
// Batch info check
// ---------------------------------------------------------------------------

console.log('\n[batch info check]');
{
  const fields = { ...emptyFields, batch_no: { value: 'ZZZ999', confidence: 'high' as const, origin: 'image' as const } };
  const batchChecks = runBatchInfoCheck(fields);
  const ref = batchChecks.find(c => c.id === 'batch-reference');
  check('unknown batch → cannot-verify wording', ref?.status === 'unavailable' && ref.reason.includes('not in reference data. Cannot be verified.'), JSON.stringify(ref));
  const fmt = batchChecks.find(c => c.id === 'batch-format');
  check('unknown pattern → format unavailable', fmt?.status === 'unavailable' && /pattern/i.test(fmt.reason), JSON.stringify(fmt));
  const noBatch = runBatchInfoCheck(emptyFields);
  check('no batch → no checks', noBatch.length === 0);

  // Known batch → reference pass with recorded details
  const knownFields = { ...emptyFields, batch_no: { value: 'G652046', confidence: 'high' as const, origin: 'image' as const } };
  const knownChecks = runBatchInfoCheck(knownFields);
  const knownRef = knownChecks.find(c => c.id === 'batch-reference');
  check('known batch → reference pass', knownRef?.status === 'pass' && knownRef.reason.includes('Amlokind AT'), JSON.stringify(knownRef));
}

console.log(`\n==== ${passCount} passed, ${failCount} failed ====`);
process.exit(failCount > 0 ? 1 : 0);
