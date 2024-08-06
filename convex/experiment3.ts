/* eslint-disable no-constant-condition */
import {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
  GenericActionCtx,
  GenericDataModel,
  RegisteredAction,
  ReturnValueForOptionalValidator,
} from "convex/server";
import { PropertyValidators, v, Validator } from "convex/values";
import {
  action,
  ActionCtx,
  internalAction,
  mutation,
  query,
} from "./_generated/server";
import { api } from "./_generated/api";
import { OpenAI } from "openai";
import { DataModel, Doc, Id } from "./_generated/dataModel";
import { BaseChannel } from "./async_channel";

interface WorkflowStep<DataModel extends GenericDataModel> {
  run<T>(
    label: string,
    fn: (ctx: GenericActionCtx<DataModel>) => Promise<T>,
  ): Promise<T>;
}

type RegisteredWorkflow<
  Args extends DefaultFunctionArgs,
  Returns,
> = RegisteredAction<"internal", never, never> & {
  __isWorkflow: true;
  __args: Args;
  __returns: Returns;
};

const runWorkflow = (handler: any) =>
  action({
    handler: async (ctx, args: any) => {
      const workflowId: Id<"workflows"> = args.workflowId;
      const generationNumber: number = args.generationNumber;
      if (
        typeof workflowId !== "string" ||
        typeof generationNumber !== "number"
      ) {
        throw new Error(`Workflow run incorrectly, use client`);
      }
      const workflow = await ctx.runMutation(api.experiment3.startExecution, {
        workflowId,
        generationNumber,
        now: Date.now(),
      });
      if (workflow.state.type === "completed") {
        return;
      }

      const journalEntries = await ctx.runQuery(api.experiment3.loadJournal, {
        workflowId,
        generationNumber,
      });

      const channel = new BaseChannel<RunStep>(0);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        journalEntries,
        channel,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        const step = new Step(channel);
        let outcome: Result<any>;
        try {
          const result = await handler(step, workflow.args);
          outcome = { type: "success", result };
        } catch (error: any) {
          outcome = { type: "error", error: error.message };
        }
        return { type: "handlerDone", outcome };
      };
      const executorWorker = async (): Promise<WorkerResult> => {
        await executor.run();
        return { type: "executorDone" };
      };

      const result = await Promise.race([handlerWorker(), executorWorker()]);
      switch (result.type) {
        case "handlerDone": {
          await ctx.runMutation(api.experiment3.completeWorkflow, {
            workflowId,
            generationNumber,
            outcome: result.outcome,
            now: Date.now(),
          });
          return;
        }
        case "executorDone": {
          throw new Error(`TODO: executorDone`);
        }
      }
    },
  });

type Result<T> =
  | { type: "success"; result: T }
  | { type: "error"; error: string };
type WorkerResult =
  | { type: "handlerDone"; outcome: Result<any> }
  | { type: "executorDone" };

type RunStep = {
  label: string;
  fn: (ctx: any) => Promise<any>;
  resolve: (result: any) => void;
  reject: (error: any) => void;
};

// TODO: Add system error signal to Step.

class StepExecutor {
  private nextStepNumber: number;
  constructor(
    private workflowId: Id<"workflows">,
    private generationNumber: number,

    private ctx: ActionCtx,
    private journalEntries: Array<Doc<"workflowJournal">>,
    private receiver: BaseChannel<RunStep>,
  ) {
    this.nextStepNumber = journalEntries.length;
  }

  async run() {
    while (true) {
      const msg = await this.receiver.get();
      const entry = this.journalEntries.shift();
      if (!entry) {
        // Push new journal entry.
        const stepNumber = this.nextStepNumber;
        this.nextStepNumber += 1;
        const journalId = await this.ctx.runMutation(
          api.experiment3.pushJournalEntry,
          {
            workflowId: this.workflowId,
            generationNumber: this.generationNumber,
            stepNumber,
            stepLabel: msg.label,
            startedAt: Date.now(),
          },
        );
        // Start executing
        let outcome: Result<any>;
        try {
          const result = await msg.fn(this.ctx);
          outcome = { type: "success", result };
        } catch (error: any) {
          outcome = { type: "error", error: error.message };
        }
        // Complete journal entry.
        await this.ctx.runMutation(api.experiment3.completeJournalEntry, {
          workflowId: this.workflowId,
          generationNumber: this.generationNumber,
          journalId,
          outcome,
          now: Date.now(),
        });
        // Complete the function's promise.
        if (outcome.type === "success") {
          msg.resolve(outcome.result);
        } else {
          msg.reject(new Error(outcome.error));
        }
      } else {
        if (entry.stepLabel !== msg.label) {
          throw new Error(`TODO: journal entry label mismatch?`);
        }
        if (entry.state.type === "running") {
          throw new Error(`TODO: journal entry still running?`);
        }
        const { outcome } = entry.state;
        if (outcome.type === "success") {
          msg.resolve(outcome.result);
        } else {
          msg.reject(new Error(outcome.error));
        }
      }
    }
  }
}

class Step {
  constructor(private sender: BaseChannel<RunStep>) {}

  async run<T>(label: string, fn: (ctx: any) => Promise<T>): Promise<T> {
    let send: any;
    const p = new Promise<T>((resolve, reject) => {
      const msg = { label, fn, resolve, reject };
      send = this.sender.push(msg);
    });
    await send;
    return p;
  }
}

export const startExecution = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type === "completed") {
      return workflow;
    }
    // TODO: Preempt if it's been sufficiently long.
    if (workflow.executing) {
      throw new Error(`Workflow already executing: ${args.workflowId}`);
    }

    workflow.executing = true;
    workflow.lastHeartbeat = args.now;
    await ctx.db.replace(workflow._id, workflow);

    return workflow;
  },
});

export const loadJournal = query({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    const journalEntries = await ctx.db
      .query("workflowJournal")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .collect();
    return journalEntries;
  },
});

export const pushJournalEntry = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    stepNumber: v.number(),
    stepLabel: v.string(),
    startedAt: v.number(),
  },
  returns: v.id("workflowJournal"),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const existing = await ctx.db
      .query("workflowJournal")
      .withIndex("workflowId", (q) =>
        q.eq("workflowId", args.workflowId).eq("stepNumber", args.stepNumber),
      )
      .first();
    if (existing) {
      throw new Error(`Journal entry already exists: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("workflowJournal")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .order("desc")
      .first();
    if (maxEntry && maxEntry.stepNumber + 1 !== args.stepNumber) {
      throw new Error(`Invalid step number: ${args.stepNumber}`);
    }
    const journalId = await ctx.db.insert("workflowJournal", {
      workflowId: args.workflowId,
      stepNumber: args.stepNumber,
      stepLabel: args.stepLabel,
      startedAt: args.startedAt,
      state: { type: "running" },
    });
    return journalId;
  },
});

export const completeJournalEntry = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    journalId: v.id("workflowJournal"),
    outcome: v.union(
      v.object({
        type: v.literal("success"),
        result: v.any(),
      }),
      v.object({
        type: v.literal("error"),
        error: v.string(),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const journalEntry = await ctx.db.get(args.journalId);
    if (!journalEntry) {
      throw new Error(`Journal entry not found: ${args.journalId}`);
    }
    if (journalEntry.workflowId !== args.workflowId) {
      throw new Error(`Journal entry not for this workflow: ${args.journalId}`);
    }
    if (journalEntry.state.type !== "running") {
      throw new Error(`Journal entry not running: ${args.journalId}`);
    }
    journalEntry.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    await ctx.db.replace(journalEntry._id, journalEntry);
  },
});

export const completeWorkflow = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    outcome: v.union(
      v.object({
        type: v.literal("success"),
        result: v.any(),
      }),
      v.object({
        type: v.literal("error"),
        error: v.string(),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    await ctx.db.replace(workflow._id, workflow);
  },
});

function workflow<
  ArgsValidator extends PropertyValidators | Validator<any, any, any> | void,
  ReturnsValidator extends PropertyValidators | Validator<any, any, any> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
  OneOrZeroArgs extends
    ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
>(workflow: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  // TODO: need to wire in codegen here?
  handler: (
    step: WorkflowStep<DataModel>,
    ...args: OneOrZeroArgs
  ) => ReturnValue;
}): RegisteredWorkflow<ArgsArrayToObject<OneOrZeroArgs>, ReturnValue> {
  return runWorkflow(workflow.handler) as any;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const experiment3 = workflow({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (step, args) => {
    const transcription = await step.run(
      "computeTranscription",
      async (ctx) => {
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
    );
    const embedding = await step.run("computeEmbedding", async (ctx) => {
      const embedding = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: [transcription],
      });
      return embedding.data[0].embedding;
    });
    console.log(embedding);
    return null;
  },
});
