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

export {
  AllProvidersFailedError,
  FailoverChatModel,
  StreamInterruptedError,
  formatFailoverEvent,
  type FailoverAttempt,
  type FailoverChatModelOptions,
  type FailoverEvent,
  type ProviderMember,
  type ProviderState,
} from './failover-model.js';

import { OpenAIChatModel, type OpenAIChatModelOptions } from './openai-chat-model.js';
import {
  FailoverChatModel,
  type FailoverChatModelOptions,
} from './failover-model.js';
import type { ChatModel } from './chat-model.js';
import { selectProvider, type ProviderConfig } from './provider-config.js';

/** 按配置造一个模型客户端。换供应商只换 config，调用方零改动。 */
export function createChatModel(config: ProviderConfig, options?: OpenAIChatModelOptions): ChatModel {
  return new OpenAIChatModel(config, options);
}

export interface ResilientModelOptions {
  /** 主供应商 key；缺省取 priority 最高的那个 */
  primaryKey?: string;
  temperature?: number;
  maxTokens?: number;
  failover?: FailoverChatModelOptions;
}

/**
 * 造一个带故障转移的模型：选中的供应商打头，其余按 priority 依次兜底。
 * 只有一家可用时不套壳——单供应商场景保持朴素行为，少一层包装好排查。
 */
export function createFailoverModel(
  providers: readonly ProviderConfig[],
  options: ResilientModelOptions = {},
): ChatModel {
  const primary = selectProvider(providers, options.primaryKey);
  const modelOptions: OpenAIChatModelOptions = {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  };
  if (providers.length === 1) return createChatModel(primary, modelOptions);

  const ordered = [primary, ...providers.filter((provider) => provider.key !== primary.key)];
  return new FailoverChatModel(
    ordered.map((config) => ({
      key: config.key,
      label: config.name,
      model: createChatModel(config, modelOptions),
    })),
    options.failover,
  );
}
