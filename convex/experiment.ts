import { v, Validator } from "convex/values";
import { action, mutation } from "./_generated/server";
import { OpenAI } from "openai";
import { RegisteredAction } from "convex/server";

// Demo workflow for batching: https://platform.openai.com/docs/api-reference/batch

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type WorkflowActions = Record<string, RegisteredAction<any, any, any>>;

type ActionArgs<T> =
  T extends RegisteredAction<any, infer Args, any> ? Args : never;
type ActionReturns<T> =
  T extends RegisteredAction<any, any, infer Returns> ? Returns : never;

interface WorkflowCtx<Actions extends WorkflowActions> {
  run<Name extends keyof Actions>(
    name: Name,
    args: ActionArgs<Actions[Name]>,
  ): Promise<ActionReturns<Actions[Name]>>;
}

interface WorkflowFunction<Actions extends WorkflowActions, Args, Returns> {
  args: Validator<Args, any, any>;
  returns: Validator<Returns, any, any>;
  handler: (ctx: WorkflowCtx<Actions>, args: Args) => Promise<Returns>;
}

class Workflow<Actions extends WorkflowActions, Args, Returns> {
  constructor(
    private actions: Actions,
    private workflow: WorkflowFunction<Actions, Args, Returns>,
  ) {}

  export(): any {
    const runActivity = action({
      args: {
        name: v.string(),
        args: v.any(),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        const action = this.actions[args.name];
        const result = await action(ctx, args.args);
        return result;
      },
    });
    const runWorkflow = mutation({
      args: {
        workflowId: v.string(),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        const workflowArgs: any = {};
        const workflowCtx: any = {};
        const workflowPromise = this.workflow.handler(
          workflowCtx,
          workflowArgs,
        );

        // Promise.race on either the workflow promise or a syscall.
        // Queue up a promise to run the syscall if it's not resolved.
      },
    });

    return {
      runActivity,
      runWorkflow,
    };
  }
}

const workflow = new Workflow(
  {
    computeTranscription: action({
      args: {
        storageId: v.id("_storage"),
      },
      returns: v.string(),
      handler: async (ctx, args) => {
        const blob = await ctx.storage.get(args.storageId);
        if (!blob) {
          throw new Error(`Invalid storage ID: ${args.storageId}`);
        }
        // NB: We have to pass in a `File` object here, since the OpenAI SDK
        // looks at its filename to determine the file type.
        const file = new File([blob], `${args.storageId}.mp3`, {
          type: "audio/mpeg",
        });
        const transcription = await openai.audio.transcriptions.create({
          file,
          model: "whisper-1",
        });
        return transcription.text;
      },
    }),
    computeEmbedding: action({
      args: {
        text: v.string(),
      },
      returns: v.array(v.number()),
      handler: async (ctx, args) => {
        const embedding = await openai.embeddings.create({
          model: "text-embedding-ada-002",
          input: [args.text],
        });
        return embedding.data[0].embedding;
      },
    }),
  },
  {
    args: v.object({ storageId: v.id("_storage") }),
    returns: v.null(),
    handler: async (ctx, args) => {
      const transcription = await ctx.run("computeTranscription", args);
      const embedding = await ctx.run("computeEmbedding", {
        text: transcription,
      });
      console.log(embedding);
      return null;
    },
  },
);
// const { runActivity, runWorkflow } = workflow.export();
// export { runActivity, runWorkflow };
