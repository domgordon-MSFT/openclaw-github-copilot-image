import { CopilotExecutionError, createCopilotImageAdapter, maxInputImages } from "./copilot-adapter.mjs";
import { hostProfileAuth } from "./openclaw-profile.mjs";

const id = "github-copilot-image";
const model = "image-generation";
const mode = { maxCount: 1, supportsSize: true };

export default {
  id,
  name: "GitHub Copilot Image Generation",
  register(api) {
    const options = api.pluginConfig;
    if (!options?.cliPath) return;
    if (options.authProfileId) hostProfileAuth({ cfg: api.config }, options);
    api.registerImageGenerationProvider({
      id: "github-copilot",
      label: "GitHub Copilot",
      defaultModel: model,
      models: [model],
      isConfiguredAsync: async () => true,
      defaultTimeoutMs: 180_000,
      capabilities: {
        generate: mode,
        edit: { ...mode, enabled: true, maxInputImages },
        geometry: { sizes: ["1024x1024", "1536x1024", "1024x1536"] },
        output: { formats: ["png"], qualities: ["auto", "low", "medium", "high"] },
      },
      async generateImage(req) {
        const references = req.inputImages ?? [];
        if ((req.count ?? 1) !== 1 || references.length > maxInputImages || (req.model && req.model !== model)) {
          throw new Error(`GitHub Copilot supports one output per call and up to ${maxInputImages} reference images`);
        }
        const signal = req.signal
          ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 180_000)])
          : AbortSignal.timeout(req.timeoutMs ?? 180_000);
        const profileAuth = options.authProfileId ? hostProfileAuth(req, options) : undefined;
        const adapter = createCopilotImageAdapter({ ...options, profileAuth });
        try {
          const image = await adapter.submitImage({ prompt: req.prompt, size: req.size, quality: req.quality, references }, signal);
          return { images: [{ ...image, fileName: "copilot-image.png" }], model };
        } catch (error) {
          if (error instanceof CopilotExecutionError) api.logger.warn(`Copilot image SDK outcome: ${error.diagnostic}`);
          throw error;
        }
      },
    });
  },
};
