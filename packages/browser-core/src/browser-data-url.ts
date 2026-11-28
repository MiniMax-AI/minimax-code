/**
 * `beta.browserReadV2`: page reads replace long `data:` URLs (inline images,
 * base64 fonts) with a short placeholder that keeps the media type and the
 * payload length, e.g. `data:image/png;base64,[omitted 48213 chars]`, so a
 * read does not spend the model's context on base64. Shorter payloads (small
 * inline icons) stay as they are.
 */
export const DATA_URL_MIN_OMITTED_CHARS = 256;

/** `data:` + optional media type + `;param` list + `,` + payload up to a quote, bracket or space. */
const DATA_URL_PATTERN = String.raw`\bdata:([\w.+-]+\/[\w.+-]+)?((?:;[\w.+-]+(?:=[\w.+-]+)?)*),([^\s"'<>()\[\]]+)`;

/**
 * Page-side source of the placeholder rewrite: `(value: string) => string`.
 * The host interpolates it into its fixed read expressions; it reads nothing
 * from the page itself.
 */
export const OMIT_DATA_URLS_SOURCE = `((pattern) => (value) => String(value).replace(pattern, (match, mediaType, params, payload) =>
  payload.length < ${DATA_URL_MIN_OMITTED_CHARS} ? match : 'data:' + (mediaType || '') + params + ',[omitted ' + payload.length + ' chars]'))(new RegExp(${JSON.stringify(DATA_URL_PATTERN)}, 'gi'))`;
