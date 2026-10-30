/**
 * Projection of MCP tool results into DSH `ContentBlock`s.
 *
 * DSH's model-facing output is text-only, while MCP servers may return images,
 * audio, embedded resources, resource links and future block types. Everything
 * is therefore projected into a single text-only block per input block; binary
 * payloads (base64 image/audio data, blob contents) are never copied into the
 * text, so they cannot leak into the model context.
 *
 * @module dsh-basemind-plugin/lib/result
 */

/**
 * @param {unknown} value
 * @returns {boolean} true for `{}`-like objects only (no arrays, no class instances).
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {string} text
 * @returns {{ type: 'text', text: string }}
 */
function textBlock(text) {
  return { type: 'text', text };
}

/**
 * @param {unknown} value
 * @returns {string} a short, safe description of a non-object value's type.
 */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * @param {unknown} value
 * @returns {string} a non-empty MIME type or the fallback label.
 */
function mimeTypeOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown media type';
}

/**
 * Projects one raw MCP content block into a text-only ContentBlock.
 *
 * @param {unknown} block
 * @returns {{ type: 'text', text: string }}
 */
function projectBlock(block) {
  if (!isPlainObject(block)) {
    return textBlock(
      `[unsupported MCP content block: expected an object, got ${kindOf(block)}]`,
    );
  }

  switch (block.type) {
    case 'text':
      return textBlock(typeof block.text === 'string' ? block.text : '');

    case 'resource_link': {
      const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : null;
      const uri = typeof block.uri === 'string' && block.uri.length > 0 ? block.uri : null;
      if (name === null || uri === null) {
        return textBlock(
          '[resource link unavailable: the MCP block is missing its name or URI]',
        );
      }
      return textBlock(`Resource link: ${name} (${uri})`);
    }

    case 'image':
      return textBlock(
        `[image result: ${mimeTypeOf(block.mimeType)}; not projected into model context]`,
      );

    case 'audio':
      return textBlock(
        `[audio result unsupported: ${mimeTypeOf(block.mimeType)}; not projected into model context]`,
      );

    case 'resource':
      return textBlock(
        '[embedded resource unsupported; embedded resource content is not projected into model context]',
      );

    default: {
      const type = typeof block.type === 'string' && block.type.length > 0 ? block.type : 'unknown';
      return textBlock(`[unsupported MCP content type: ${type}]`);
    }
  }
}

/**
 * Projects a raw MCP `content` array into text-only ContentBlocks.
 *
 * Always returns at least one block (`[{ type: 'text', text: '' }]`).
 *
 * @param {unknown} content
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function projectMcpContent(content) {
  const blocks = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      try {
        blocks.push(projectBlock(block));
      } catch {
        blocks.push(textBlock('[unsupported MCP content block: the MCP block could not be read]'));
      }
    }
  }
  if (blocks.length === 0) blocks.push(textBlock(''));
  return blocks;
}

/**
 * Projects a tool result value into text-only ContentBlocks.
 *
 * Uses `value.content` when it is a non-empty array; otherwise falls back to a
 * single text block containing `value.text` (which may be `''`). Never returns
 * an empty array and never throws.
 *
 * @param {{ text?: unknown, content?: unknown, isError?: unknown } | unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function projectContent(value) {
  try {
    if (isPlainObject(value)) {
      if (Array.isArray(value.content) && value.content.length > 0) {
        return projectMcpContent(value.content);
      }
      const text = typeof value.text === 'string' ? value.text : '';
      return [textBlock(text)];
    }
  } catch {
    // Fall through to the empty text block below.
  }
  return [textBlock('')];
}

/**
 * Builds the plain-text form of a tool result, used for DSH error messages.
 *
 * Joins every projected text block with `\n`; an empty projection yields `''`.
 * Never throws for arbitrary input values.
 *
 * @param {{ text?: unknown, content?: unknown, isError?: unknown } | unknown} value
 * @returns {string}
 */
export function resultText(value) {
  try {
    const parts = [];
    for (const block of projectContent(value)) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}
