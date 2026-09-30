import { Module } from '@nestjs/common';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { AGENT_MEMORY_STORE, AGENT_RUNTIME, AgentService } from './agent.service.js';
import { AgentController } from './agent.controller.js';
import {
  A2AController,
  A2A_SERVER_OPTIONS,
  resolveA2AServerOptions,
  type A2AServerOptions,
} from './a2a.controller.js';
import { createAgentRuntime, type AgentRuntime } from '../runtime.js';

@Module({
  controllers: [AgentController, A2AController],
  providers: [
    {
      provide: AGENT_RUNTIME,
      useFactory: (): Promise<AgentRuntime> => createAgentRuntime(),
    },
    {
      // AGENT_MEMORY=memory（缺省）时与从前完全一致；file 时会话跨进程重启存活（ADR-0004）
      provide: AGENT_MEMORY_STORE,
      useFactory: (): MemoryStore => {
        const kind = process.env.AGENT_MEMORY;
        const dir = process.env.AGENT_MEMORY_DIR;
        return createMemoryStore({ ...(kind ? { kind } : {}), ...(dir ? { dir } : {}) });
      },
    },
    {
      provide: A2A_SERVER_OPTIONS,
      useFactory: (): A2AServerOptions => resolveA2AServerOptions(),
    },
    AgentService,
  ],
  exports: [AgentService],
})
export class AgentModule {}
