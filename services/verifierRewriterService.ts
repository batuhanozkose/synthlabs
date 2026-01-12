
import { ExternalProvider, VerifierItem } from '../types';
import * as ExternalApiService from './externalApiService';
import * as GeminiService from './geminiService';
import { SettingsService } from './settingsService';

export interface RewriterConfig {
    provider: 'gemini' | 'external';
    externalProvider: ExternalProvider;
    apiKey: string;
    model: string;
    customBaseUrl?: string;
    maxRetries?: number;
    retryDelay?: number;
}

export type RewritableField = 'query' | 'reasoning' | 'answer';

interface RewriteFieldParams {
    item: VerifierItem;
    field: RewritableField;
    config: RewriterConfig;
    signal?: AbortSignal;
}

interface RewriteMessageParams {
    item: VerifierItem;
    messageIndex: number;
    config: RewriterConfig;
    signal?: AbortSignal;
}

const FIELD_REWRITE_PROMPTS: Record<RewritableField, string> = {
    query: `You are rewriting the QUERY field of a dataset item. The query should be a clear, well-formed question or instruction.
Keep the semantic meaning but improve clarity, grammar, and formatting.
Return ONLY the rewritten query as {"response": "..."} JSON object.`,

    reasoning: `You are rewriting the REASONING field of a dataset item. This is a chain-of-thought reasoning trace.
Improve the logical flow, fix any errors, and ensure the reasoning correctly leads to the answer.
Use stenographic notation where appropriate (→, ∴, ⚠, etc.).
Return ONLY the rewritten reasoning trace as {"response": "..."} JSON object.

# THE STENOGRAPHIC PROTOCOL (CRITICAL)

| Symbol | Definition | Usage Mandate |
| :---- | :---- | :---- |
| → | **Flow/Derivation** | Unbroken linear progression from one sub‑task to the next (e.g., Query Parse → Context Retrieval). |
| ↺ | **Refinement Loop** | **Mandatory** whenever the model revisits prior steps for self‑correction, re‑reading sources, or translation. |
| ∴ | **Convergence** | The final logical convergence point just before producing the final answer. |
| ● | **Ground Truth** | A verifiable fact, definition, or data point from a reliable source. |
| ◐ | **Inference** | A reasoned deduction or intermediate result not directly stated in the source. |
| ○ | **Speculation** | A low‑confidence guess or unproven hypothesis. |
| \! | **Insight** | A key realization that resolves ambiguity or unlocks synthesis. |
| ※ | **Constraint/Trap** | A critical rule, limitation, or potential misunderstanding detected in the prompt or context. |
| ? | **Ambiguity** | Explicitly missing information or assumption required to proceed. |
| ⚠ | **Risk/Warning** | Hallucination risk, safety concern, or detected bias. |
| \<H≈X.X\> | **Entropy Marker** | **Mandatory.** Insert before major cognitive shifts.  Range: 0.1 (rigid analytical) to 1.5 (creative synthesis).

**Format Requirements:**
1. Strip all conversational filler ("I think", "Maybe").
2. Use symbols to represent logical flow.
3. Maintain the *original logical steps* but compress them.
`,

    answer: `You are rewriting the ANSWER field of a dataset item. This is the final response to the query.
Improve clarity, accuracy, and formatting while preserving the core content.
Return ONLY the rewritten answer as {"response": "..."} JSON object.`

};

const MESSAGE_REWRITE_PROMPT = `You are rewriting a single message in a conversation. 
Based on the conversation history, rewrite the target message to be clearer, more accurate, and better formatted.
If it's an assistant message with <think> tags, preserve that structure but improve the reasoning.
Return ONLY the rewritten message content as {"response": "..."} JSON object.`;

/**
 * Builds context string from a VerifierItem for AI rewriting
 */
function buildItemContext(item: VerifierItem, targetField: RewritableField): string {
    return `## FULL ITEM CONTEXT

**Query:** ${item.query}

**Reasoning Trace:**
${item.reasoning}

**Answer:**
${item.answer}

---
TARGET FIELD TO REWRITE: ${targetField.toUpperCase()}
Current value of ${targetField}:
${item[targetField]}`;
}

/**
 * Builds context for message rewriting with conversation history up to target
 */
function buildMessageContext(item: VerifierItem, targetIndex: number): string {
    if (!item.messages || item.messages.length === 0) {
        return '';
    }

    const contextMessages = item.messages.slice(0, targetIndex + 1);
    const formattedHistory = contextMessages.map((msg, idx) => {
        const isTarget = idx === targetIndex;
        return `[${msg.role.toUpperCase()}]${isTarget ? ' (TARGET TO REWRITE)' : ''}:
${msg.content}`;
    }).join('\n\n');

    return `## CONVERSATION HISTORY (up to and including target message)

${formattedHistory}

---
REWRITE THE LAST MESSAGE IN THE HISTORY ABOVE (the one marked as TARGET).`;
}

/**
 * Helper to extract content from potentially JSON-wrapped response
 */
function cleanResponse(input: any): string {
    let content = input;

    // If input is a string that looks like JSON, try to parse it
    if (typeof input === 'string') {
        try {
            const trimmed = input.trim();
            // Check if it looks like a JSON object using simple heuristic
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                content = JSON.parse(input);
            }
        } catch (e) {
            // Not valid JSON, treat as raw string
            return input;
        }
    }

    // If content is an object (either returned directly or parsed)
    if (typeof content === 'object' && content !== null) {
        return content.response || content.answer || content.content || content.text || content.reasoning || JSON.stringify(content);
    }

    return String(content);
}

/**
 * Calls the AI service to rewrite content
 */
export async function callRewriterAI(
    systemPrompt: string,
    userPrompt: string,
    config: RewriterConfig,
    signal?: AbortSignal
): Promise<string> {
    if (config.provider === 'gemini') {
        const result = await GeminiService.generateReasoningTrace(
            userPrompt,
            systemPrompt,
            {
                maxRetries: config.maxRetries ?? 2,
                retryDelay: config.retryDelay ?? 1000
            }
        );
        // GeminiService returns { query, reasoning, answer }
        // The rewriten text might be in 'answer' (potentially as a JSON string if prompted)
        // or just the answer text itself
        const rawText = result.answer || result.reasoning || String(result);
        return cleanResponse(rawText);
    } else {
        const result = await ExternalApiService.callExternalApi({
            provider: config.externalProvider,
            apiKey: config.apiKey || SettingsService.getApiKey(config.externalProvider),
            model: config.model,
            customBaseUrl: config.customBaseUrl || SettingsService.getCustomBaseUrl(),
            systemPrompt,
            userPrompt,
            signal,
            maxRetries: config.maxRetries ?? 2,
            retryDelay: config.retryDelay ?? 1000
        });

        return cleanResponse(result);
    }
}

/**
 * Rewrites a specific field of a VerifierItem using AI
 */
export async function rewriteField(params: RewriteFieldParams): Promise<string> {
    const { item, field, config, signal } = params;

    const systemPrompt = FIELD_REWRITE_PROMPTS[field];
    const userPrompt = buildItemContext(item, field);

    const result = await callRewriterAI(systemPrompt, userPrompt, config, signal);
    return result.trim();
}

/**
 * Rewrites a specific message in a multi-turn conversation
 */
export async function rewriteMessage(params: RewriteMessageParams): Promise<string> {
    const { item, messageIndex, config, signal } = params;

    if (!item.messages || messageIndex >= item.messages.length) {
        throw new Error('Invalid message index or no messages in item');
    }

    const systemPrompt = MESSAGE_REWRITE_PROMPT;
    const userPrompt = buildMessageContext(item, messageIndex);

    const result = await callRewriterAI(systemPrompt, userPrompt, config, signal);
    return result.trim();
}
