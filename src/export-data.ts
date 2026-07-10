import {
  MAX_PNG_DATA_URI_LENGTH,
  MAX_PNG_EXPORT_BYTES,
  MAX_SVG_EXPORT_BYTES,
} from "./export-limits";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function pngDataUriLengthWithinLimit(length: number): boolean {
  return Number.isSafeInteger(length) && length >= 0 && length <= MAX_PNG_DATA_URI_LENGTH;
}

export function svgTextWithinLimit(svg: string): boolean {
  return Buffer.byteLength(svg, "utf8") <= MAX_SVG_EXPORT_BYTES;
}

export type SvgValidationResult =
  | { ok: true }
  | { ok: false; reason: "too-large" | "invalid-root" | "unsafe-content" };

export function validateSvgText(svg: string): SvgValidationResult {
  if (!svgTextWithinLimit(svg)) return { ok: false, reason: "too-large" };
  if (!/^<svg(?:\s|>)/i.test(svg.trimStart())) return { ok: false, reason: "invalid-root" };
  if (
    /<(?:script|foreignObject|iframe|object|embed|image|use|a)\b/i.test(svg) ||
    /\bon[a-z]+\s*=/i.test(svg) ||
    /\b(?:href|xlink:href)\s*=/i.test(svg) ||
    /<!DOCTYPE|\burl\s*\(/i.test(svg)
  ) {
    return { ok: false, reason: "unsafe-content" };
  }
  return { ok: true };
}

export function svgTextIsSafe(svg: string): boolean {
  return validateSvgText(svg).ok;
}

export function decodePngExport(dataUri: unknown): Buffer | undefined {
  if (typeof dataUri !== "string" || !pngDataUriLengthWithinLimit(dataUri.length)) return undefined;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri.trim());
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length <= MAX_PNG_EXPORT_BYTES &&
    bytes.length > PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    ? bytes
    : undefined;
}
