import { Module } from '@nestjs/common';
import { AGENT_RUNTIME, AgentService } from './agent.service.js';
import { AgentController } from './agent.controller.js';
import { createAgentRuntime, type AgentRuntime } from './runtime.js';

@Module({
  controllers: [AgentController],
  providers: [
    {
      provide: AGENT_RUNTIME,
      useFactory: (): AgentRuntime => createAgentRuntime(),
    },
    AgentService,
  ],
  exports: [AgentService],
})
export class AgentModule {}
