
import { ExternalProvider, GenerationParams } from '../types';
import { PROVIDER_URLS } from '../constants';
import { logger } from '../utils/logger';

export interface ExternalApiConfig {
  provider: ExternalProvider;
  apiKey: string;
  model: string;
  customBaseUrl?: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  maxRetries?: number;
  retryDelay?: number;
  generationParams?: GenerationParams;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const callExternalApi = async (config: ExternalApiConfig): Promise<any> => {
  const {
    provider, apiKey, model, customBaseUrl, systemPrompt, userPrompt, signal,
    maxRetries = 3, retryDelay = 2000, generationParams
  } = config;

  let baseUrl = provider === 'other' ? customBaseUrl : PROVIDER_URLS[provider];

  if (!baseUrl) {
    throw new Error(`No base URL found for provider: ${provider}`);
  }

  // Remove trailing slash if present
  baseUrl = baseUrl.replace(/\/$/, '');

  // Sanitize API Key
  const safeApiKey = apiKey ? apiKey.replace(/[^\x20-\x7E]/g, '').trim() : '';

  // Determine headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (provider === 'anthropic') {
    headers['x-api-key'] = safeApiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'ollama' && !safeApiKey) {
    headers['Authorization'] = 'Bearer ollama-local';
  } else {
    headers['Authorization'] = `Bearer ${safeApiKey}`;
  }

  // Filter undefined generation params
  const cleanGenParams: Record<string, any> = {};
  if (generationParams) {
    if (generationParams.temperature !== undefined) cleanGenParams.temperature = generationParams.temperature;
    if (generationParams.topP !== undefined) cleanGenParams.top_p = generationParams.topP;
    if (generationParams.topK !== undefined) cleanGenParams.top_k = generationParams.topK; // OpenAI typically doesn't use top_k, but others might
    if (generationParams.frequencyPenalty !== undefined) cleanGenParams.frequency_penalty = generationParams.frequencyPenalty;
    if (generationParams.presencePenalty !== undefined) cleanGenParams.presence_penalty = generationParams.presencePenalty;
  }

  // Construct Payload
  let url = '';
  let payload: any = {};

  if (provider === 'anthropic') {
    url = `${baseUrl}/messages`;
    payload = {
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: cleanGenParams.temperature ?? 0.8,
      top_p: cleanGenParams.top_p,
      top_k: cleanGenParams.top_k
    };
  } else {
    url = `${baseUrl}/chat/completions`;
    payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      ...cleanGenParams
    };
    // If temp was not provided in params, default to 0.8 if strictly needed, 
    // but usually APIs have defaults. We only set it if explicitly passed or fallback logic.
    if (cleanGenParams.temperature === undefined) payload.temperature = 0.8;
  }

  // RETRY LOOP
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal
      });

      // Handle Rate Limits (429) and Server Errors (5xx)
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const backoff = retryDelay * Math.pow(2, attempt); // Exponential backoff
          logger.warn(`Attempt ${attempt + 1} failed (${response.status}). Retrying in ${backoff}ms...`);
          await sleep(backoff);
          continue;
        } else {
          const errText = await response.text();
          throw new Error(`${provider} API Error ${response.status} after ${maxRetries} retries: ${errText}`);
        }
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`${provider} API Error: ${response.status} - ${err}`);
      }

      // Success Logic
      const data = await response.json();

      if (provider === 'anthropic') {
        const content = data.content?.[0]?.text || "";
        return parseJsonContent(content);
      } else {
        const choice = data.choices?.[0];
        const message = choice?.message;

        let rawContent = message?.content;
        if (!rawContent) {
          rawContent = message?.reasoning || message?.reasoning_content || "";
        }

        if (!rawContent) {
          logger.warn("Provider returned empty content", data);
          throw new Error("Provider returned empty content (check console for details)");
        }
        return parseJsonContent(rawContent);
      }

    } catch (err: any) {
      if (err.name === 'AbortError') throw err; // Don't retry aborts

      lastError = err;

      // If network error (fetch failed completely), also retry
      if (attempt < maxRetries) {
        const backoff = retryDelay * Math.pow(2, attempt);
        logger.warn(`Attempt ${attempt + 1} network error. Retrying in ${backoff}ms...`, err);
        await sleep(backoff);
        continue;
      }
    }
  }

  throw lastError;
};

// New function to generate synthetic seeds using external providers
export const generateSyntheticSeeds = async (
  baseConfig: Omit<ExternalApiConfig, 'userPrompt' | 'systemPrompt'>,
  topic: string,
  count: number
): Promise<string[]> => {
  const prompt = `Generate ${count} DISTINCT, high-quality, factual text paragraphs about: "${topic}".
  The texts should be suitable for testing an AI's reasoning capabilities.
  
  Output format: A raw JSON array of strings. 
  Example: ["Text paragraph 1...", "Text paragraph 2..."].
  Do not include markdown formatting or explanations. Output ONLY the JSON.`;

  try {
    const result = await callExternalApi({
      ...baseConfig,
      systemPrompt: "You are a high-fidelity synthetic data generator. You output strict JSON arrays of strings.",
      userPrompt: prompt
    });

    // Handle cases where the model might return { "seeds": [...] } instead of just [...]
    if (Array.isArray(result)) return result.map(String);
    if (result && Array.isArray(result.seeds)) return result.seeds.map(String);
    if (result && Array.isArray(result.paragraphs)) return result.paragraphs.map(String);

    return [];
  } catch (e) {
    console.error("External Seed Gen failed", e);
    // If it fails, return empty so the UI knows
    return [];
  }
};

// Helper to safely parse JSON from LLM output, handling markdown blocks
function parseJsonContent(content: string): any {
  const cleanContent = content
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleanContent);
  } catch (e) {
    console.error("JSON Parse Failed", e, content);
    throw new Error("Failed to parse response as JSON");
  }
}
