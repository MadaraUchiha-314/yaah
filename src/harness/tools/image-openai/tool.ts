/**
 * The `generate_image` tool on OpenAI's image API (`POST /v1/images/generations`, the
 * SDK's `images.generate`). The image is not a tool result the model reads: it is
 * returned as an artifact, which the harness delivers to the person as an A2A artifact
 * with its media type. The model is told only that the image was delivered.
 */
import OpenAI from 'openai';
import type { ImageGenerateParamsNonStreaming } from 'openai/resources/images';

import { isJsonObject } from '../../../kernel/json.ts';
import type { Json } from '../../../kernel/json.ts';
import { t } from '../../../kernel/strings.ts';
import type { ContentPart, ToolResult } from '../../core/types.ts';
import type { FetchLike } from '../../models/llm/openai/content.ts';
import type { ErrorScope } from '../../models/llm/openai/errors.ts';
import { toLlmError } from '../../models/llm/openai/errors.ts';
import { OPENAI_BASE_URL } from '../../models/llm/openai/provider.ts';
import { OPENAI } from '../../models/llm/openai/request.ts';
import type { Tool, ToolCallContext } from '../types.ts';
import { defineTool, errorResult } from '../types.ts';

/** The name the model calls the tool by. */
export const GENERATE_IMAGE = 'generate_image';
/** The image model used unless the configuration names another. */
export const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';

/** What {@link createGenerateImageTool} needs. */
export interface GenerateImageOptions {
  /** The model id as OpenAI names it. Defaults to {@link OPENAI_IMAGE_MODEL}. */
  readonly model?: string | undefined;
  /** The API key. Sent only as the bearer token; never logged or put in an error. */
  readonly apiKey: string;
  /** Defaults to OpenAI's own API. */
  readonly baseUrl?: string | undefined;
  /** Replaces the global `fetch`; tests use it to replay canned responses. */
  readonly fetch?: FetchLike | undefined;
}

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
type Size = (typeof SIZES)[number];

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    size: { type: 'string', enum: [...SIZES] },
  },
  required: ['prompt'],
  additionalProperties: false,
};

function sizeOf(value: Json | undefined): Size | undefined {
  return SIZES.find((size: Size) => size === value);
}

/** The delivered image as an artifact part: inline PNG, or a link when the API gave one. */
function imagePart(image: OpenAI.Images.Image | undefined): ContentPart | null {
  if (typeof image?.b64_json === 'string' && image.b64_json !== '') {
    const source = { kind: 'base64', data: image.b64_json } as const;
    return { type: 'file', mediaType: 'image/png', name: 'image.png', source };
  }
  if (typeof image?.url === 'string' && image.url.startsWith('https://')) {
    const source = { kind: 'url', url: image.url } as const;
    return { type: 'file', mediaType: 'image/png', name: 'image.png', source };
  }
  return null;
}

/**
 * Creates the `generate_image` tool.
 *
 * The tool never retries, and is not marked safe to repeat: every call is billed. A
 * failure is returned to the model as an error result built from the HTTP status only.
 */
export function createGenerateImageTool(options: GenerateImageOptions): Tool {
  const model = options.model ?? OPENAI_IMAGE_MODEL;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? OPENAI_BASE_URL,
    maxRetries: 0,
    // Ambient OPENAI_ORG_ID / OPENAI_PROJECT_ID must not change what a configured model does.
    organization: null,
    project: null,
    fetch: options.fetch,
  });
  const scope: ErrorScope = { provider: OPENAI, model, secrets: [options.apiKey] };
  const invoke = async (args: Json, ctx: ToolCallContext): Promise<ToolResult> => {
    const fields = isJsonObject(args) ? args : {};
    const prompt = typeof fields['prompt'] === 'string' ? fields['prompt'] : '';
    const size = sizeOf(fields['size']);
    const params: ImageGenerateParamsNonStreaming = {
      model,
      prompt,
      n: 1,
      output_format: 'png',
      ...(size === undefined ? {} : { size }),
    };
    try {
      const response = await client.images.generate(params, { signal: ctx.signal });
      const image = imagePart(response.data?.[0]);
      return image === null
        ? errorResult('failed', t('tool.generate-image.empty'))
        : {
            ok: true,
            content: [{ type: 'text', text: t('tool.generate-image.delivered') }],
            artifacts: [image],
          };
    } catch (error) {
      return errorResult('failed', toLlmError(scope, error, ctx.signal).message);
    }
  };
  return defineTool({
    id: GENERATE_IMAGE,
    description: t('tool.generate-image.description'),
    inputSchema: INPUT_SCHEMA,
    invoke,
  });
}
