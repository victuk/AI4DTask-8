import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway, type ProviderConfig } from '@mastra/core/llm';

// Local models can take many minutes per step on CPU. Node's default undici
// dispatcher gives up on response headers after 300s, which kills long local
// generations — so when OLLAMA_BASE_URL is set, install a patient dispatcher.
if (process.env.OLLAMA_BASE_URL) {
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(
    new Agent({
      headersTimeout: 30 * 60 * 1000,
      bodyTimeout: 30 * 60 * 1000,
    }),
  );
}

/**
 * Local Ollama gateway so the review pipeline can be exercised without a
 * hosted API key. Enabled only when OLLAMA_BASE_URL is set (e.g.
 * http://localhost:11434/v1) and MODEL_NAME uses the ollama provider prefix:
 *   MODEL_NAME=ollama/qwen2.5:7b-instruct
 *
 * Ollama's OpenAI-compatible endpoint needs no API key; a placeholder is sent.
 */
export class OllamaGateway extends MastraModelGateway {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  shouldEnable(): boolean {
    return Boolean(process.env.OLLAMA_BASE_URL);
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    if (!this.shouldEnable()) return {};
    let models: string[] = [];
    try {
      const res = await fetch(`${process.env.OLLAMA_BASE_URL!.replace(/\/+$/, '')}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as { models?: { name: string }[] };
        models = (data.models ?? []).map((m) => m.name);
      }
    } catch {
      models = [];
    }
    const provider: ProviderConfig = {
      name: 'Ollama (local)',
      models: models.length ? models : ['llama3.2'],
      apiKeyEnvVar: 'OLLAMA_API_KEY',
      gateway: this.id,
      url: process.env.OLLAMA_BASE_URL,
    };
    return { ollama: provider };
  }

  buildUrl(): string {
    return `${process.env.OLLAMA_BASE_URL!.replace(/\/+$/, '')}/v1`;
  }

  async getApiKey(): Promise<string> {
    return process.env.OLLAMA_API_KEY ?? 'local-ollama';
  }

  resolveLanguageModel({ modelId }: { modelId: string; providerId: string; apiKey: string }) {
    return createOpenAICompatible({
      name: 'ollama',
      apiKey: process.env.OLLAMA_API_KEY ?? 'local-ollama',
      baseURL: this.buildUrl(),
    }).chatModel(modelId);
  }
}
