export const MAX_EXPORT_DIMENSION = 8_192;
export const MAX_EXPORT_PIXELS = 32 * 1_024 * 1_024;
export const MAX_PNG_EXPORT_BYTES = 32 * 1_024 * 1_024;
export const MAX_PNG_DATA_URI_LENGTH = Math.ceil((MAX_PNG_EXPORT_BYTES * 4) / 3) + 64;
export const MAX_SVG_EXPORT_BYTES = 16 * 1_024 * 1_024;
