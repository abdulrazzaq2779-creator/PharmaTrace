/**
 * Typed facade over services/verify.js so TypeScript call sites keep full
 * checking. The engine itself is plain JS loaded with allowJs.
 */
import { createVerifier } from './verify.js';
import productsJson from '../data/products.json';

export type VerifyFieldKey =
  | 'batch'
  | 'mfg'
  | 'exp'
  | 'manufacturer'
  | 'brand'
  | 'composition'
  | 'dosageForm'
  | 'mfgLicence';

export interface VerifyInput {
  /** EVERY recognized line from ALL passes/bands/crops/rotations, joined. */
  rawText: string;
  fields: Partial<Record<VerifyFieldKey, string>>;
}

export type VerifyCheckStatus = 'pass' | 'fail' | 'review' | 'unavailable';

export interface VerifyCheck {
  name: string;
  status: VerifyCheckStatus;
  reason: string;
}

export interface VerifyFromReference {
  brand: string;
  composition: string;
  dosageForm: string;
  drugClass: string;
  manufacturer: string;
  licenseNo: string | null;
  uses: string;
  sideEffects: string[];
  warnings: string[];
  disclaimer: string;
}

export interface VerificationResult {
  label: string;
  confidence: 'high' | 'medium' | 'low';
  riskLevel: 'consistent' | 'needs-review' | 'high-risk';
  counts: { passed: number; failed: number; review: number; unavailable: number };
  checks: VerifyCheck[];
  fromReference: VerifyFromReference | null;
  rawTextLength: number;
}

export type Verifier = (input: VerifyInput) => VerificationResult;

/** The verifier instance the whole scan flow uses (built once from products.json). */
export const verify: Verifier = createVerifier(productsJson as never);
