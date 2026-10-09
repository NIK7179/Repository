import { ideaInterpretationSchema, validateInterpretationAgainstPitch, type IdeaInterpretation, type TechnicalLevel } from '@pitch2plan/schemas';
import type { LLMGateway } from '../gateway';
import { IDEA_INTERPRETER_V1 } from '../prompts/idea-interpreter';
import { runStructured } from '../structured';

export interface IdeaInterpreterInput {
  projectId: string; workspaceId: string; userId: string; pitch: string; technicalLevel?: TechnicalLevel;
}
export interface IdeaInterpreterOutput {
  output: IdeaInterpretation; promptId: string; promptVersion: number; provider: string; model: string;
}

export class IdeaInterpreter {
  constructor(private readonly gateway: LLMGateway) {}

  async interpret(input: IdeaInterpreterInput): Promise<IdeaInterpreterOutput> {
    const prompt = IDEA_INTERPRETER_V1;
    const { value, result } = await runStructured({
      gateway: this.gateway,
      request: { system: prompt.system, messages: [{ role: 'user', content: prompt.buildUser(input) }], maxTokens: 4096 },
      meta: {
        capability: 'IdeaInterpreter', promptId: prompt.id, promptVersion: prompt.version,
        workspaceId: input.workspaceId, projectId: input.projectId, userId: input.userId,
      },
      schema: ideaInterpretationSchema,
      semantic: (v) => validateInterpretationAgainstPitch(v, input.pitch),
    });
    return { output: value, promptId: prompt.id, promptVersion: prompt.version, provider: result.provider, model: result.model };
  }
}
