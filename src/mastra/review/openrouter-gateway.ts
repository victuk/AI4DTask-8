import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway, type ProviderConfig } from '@mastra/core/llm';

export class OpenRouterGateway extends MastraModelGateway {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter (remote)';

  /** Enable when the base URL is defined */
  shouldEnable(): boolean {
    return Boolean(process.env.OPENROUTER_BASE_URL);
  }

  /** Fetch the list of models that OpenRouter serves */
  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    if (!this.shouldEnable()) return {};

    let models: string[] = [];
    try {
      const baseUrl = process.env.OPENROUTER_BASE_URL!.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/models`);
      
      if (res.ok) {
        const data = (await res.json()) as { data?: { id: string }[] };
        // OpenRouter API returns `id` for model identifiers (e.g., "mistralai/mistral-7b-instruct")
        models = (data.data ?? []).map((m) => `openrouter/${m.id}`);
      }
    } catch {
      models = [];
    }

    const provider: ProviderConfig = {
      name: 'OpenRouter (remote)',
      models: models.length ? models : ['openrouter/mistralai/mistral-7b-instruct-v0.2'],
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      gateway: this.id,
      url: process.env.OPENROUTER_BASE_URL,
    };
    return { openrouter: provider };
  }

  /** Build the base API URL without duplicating /v1 path segments */
  buildUrl(): string {
    const rawUrl = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    return rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl}/v1`;
  }

  /** Retrieve the API key */
  async getApiKey(): Promise<string> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error('OPENROUTER_API_KEY environment variable is not defined.');
    }
    return key;
  }

  /** Resolve a language model for the given ID */
  resolveLanguageModel({ modelId }: { modelId: string; providerId: string; }) {
    // Strip gateway prefix so OpenRouter receives "mistralai/mistral-7b-instruct-v0.2"
    const cleanedModelId = modelId.replace(/^openrouter\//, '');

    return createOpenAICompatible({
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: this.buildUrl(),
    }).chatModel(cleanedModelId);
  }
}