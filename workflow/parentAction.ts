import { actionGeneric } from "convex/server";
import type {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { BaseChannel } from "async-channel";
import { insertWorkflow } from ".";

export function parentAction(client: ComponentClient, registered: any) {
  return actionGeneric({
    handler: async (ctx, args: any) => {
      const workflowId: Id<"workflows"> = args.workflowId;
      const generationNumber: number = args.generationNumber;
      if (
        typeof workflowId !== "string" ||
        typeof generationNumber !== "number"
      ) {
        throw new Error(`Workflow run incorrectly, use client`);
      }
      const workflow = await ctx.runMutation(client.startWorkflow, {
        workflowId,
        generationNumber,
        now: Date.now(),
      });
      if (workflow.state.type === "completed") {
        return;
      }

      const journalEntries = await ctx.runQuery(client.loadJournal, {
        workflowId,
        generationNumber,
      });
      const channel = new BaseChannel<RunStep>(0);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        client,
        journalEntries,
        channel,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        const step = new Step(channel);
        let outcome: Result<any>;
        try {
          const result = await registered.handler(step, workflow.args);
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
          await ctx.runMutation(client.completeWorkflow, {
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

type RunStep = {
  label: string;
  fn: (ctx: any) => Promise<any>;
  resolve: (result: any) => void;
  reject: (error: any) => void;
};

type Result<T> =
  | { type: "success"; result: T }
  | { type: "error"; error: string };

type WorkerResult =
  | { type: "handlerDone"; outcome: Result<any> }
  | { type: "executorDone" };

class StepExecutor {
  private nextStepNumber: number;
  constructor(
    private workflowId: Id<"workflows">,
    private generationNumber: number,

    private ctx: GenericActionCtx<GenericDataModel>,
    private client: ComponentClient,
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
          this.client.pushJournalEntry,
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
        await this.ctx.runMutation(this.client.completeJournalEntry, {
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

export type ComponentClient = {
  completeJournalEntry: FunctionReference<
    "mutation",
    "internal",
    {
      generationNumber: number;
      journalId: string;
      now: number;
      outcome:
        | { result: any; type: "success" }
        | { error: string; type: "error" };
      workflowId: string;
    },
    any
  >;
  completeWorkflow: FunctionReference<
    "mutation",
    "internal",
    {
      generationNumber: number;
      now: number;
      outcome:
        | { result: any; type: "success" }
        | { error: string; type: "error" };
      workflowId: string;
    },
    any
  >;
  loadJournal: FunctionReference<
    "query",
    "internal",
    { generationNumber: number; workflowId: string },
    any
  >;
  pushJournalEntry: FunctionReference<
    "mutation",
    "internal",
    {
      generationNumber: number;
      startedAt: number;
      stepLabel: string;
      stepNumber: number;
      workflowId: string;
    },
    string
  >;
  startWorkflow: FunctionReference<
    "mutation",
    "internal",
    { generationNumber: number; now: number; workflowId: string },
    any
  >;
  insertWorkflow: FunctionReference<"mutation", "internal", { args: any }, any>;
};
