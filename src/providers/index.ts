export type { ChatModel, ChatRequest, ChatResponse, FinishReason, StreamChunk } from './chat-model.js';
export { OpenAIChatModel, type OpenAIChatModelOptions } from './openai-chat-model.js';
export {
  buildProviders,
  selectProvider,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  type ProviderConfig,
  type ProviderEnv,
} from './provider-config.js';

import { OpenAIChatModel, type OpenAIChatModelOptions } from './openai-chat-model.js';
import type { ChatModel } from './chat-model.js';
import type { ProviderConfig } from './provider-config.js';

/** 按配置造一个模型客户端。换供应商只换 config，调用方零改动。 */
export function createChatModel(config: ProviderConfig, options?: OpenAIChatModelOptions): ChatModel {
  return new OpenAIChatModel(config, options);
}
