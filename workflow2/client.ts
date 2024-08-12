import {
  createFunctionHandle,
  Expand,
  FilterApi,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericDataModel,
  GenericMutationCtx,
  internalMutationGeneric,
  RegisteredMutation,
  ReturnValueForOptionalValidator,
} from "convex/server";
import {
  convexToJson,
  ObjectType,
  PropertyValidators,
  v,
  Validator,
} from "convex/values";
import { BaseChannel } from "async-channel";
import type { functions } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { JournalEntry, Step } from "./schema.js";

type InternalizeApi<API> = Expand<{
  [mod in keyof API]: API[mod] extends FunctionReference<any, any, any, any>
    ? FunctionReference<
        API[mod]["_type"],
        "internal",
        API[mod]["_args"],
        API[mod]["_returnType"],
        API[mod]["_componentPath"]
      >
    : InternalizeApi<API[mod]>;
}>;
type InstalledAPI = InternalizeApi<
  FilterApi<typeof functions, FunctionReference<any, "public", any, any>>
>;

interface WorkflowStep {
  runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>;

  runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;

  runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<FunctionReturnType<Action>>;

  sleep(ms: number): Promise<void>;

  // TODO: now & random & randomBytes
}

export type WorkflowId<T> = string & { __workflowReturns: T };

export type WorkflowDefinition<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, any, any>,
> = {
  args: ArgsValidator;
  returns: ReturnsValidator;
  handler: (
    step: WorkflowStep,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValueForOptionalValidator<ReturnsValidator>;
};

export class WorkflowClient {
  constructor(private client: InstalledAPI) {}

  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<any, any, any>,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): RegisteredMutation<
    "public",
    ObjectType<ArgsValidator>,
    ReturnValueForOptionalValidator<ReturnsValidator>
  > {
    return workflowMutation(this.client, workflow) as any;
  }

  async start<F extends FunctionReference<"mutation", any>>(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflow: F,
    args: FunctionArgs<F>,
  ): Promise<WorkflowId<FunctionReturnType<F>>> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(this.client.ops.createWorkflow, {
      workflowHandle: handle,
      workflowArgs: args,
    });
    return workflowId as unknown as WorkflowId<FunctionReturnType<F>>;
  }
}

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next. Then, the component
export function workflowMutation<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, any, any>,
>(
  client: InstalledAPI,
  registered: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
): RegisteredMutation<"internal", never, never> {
  return internalMutationGeneric({
    args: {
      workflowId: v.string(),
      generationNumber: v.number(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      // poll => done | notReady
      // workflow
      // workflowJournal
      // let journal represent all things that we can block on
      // - timers
      // - function calls
      // - external events? insert before current executing journal entry?
      // verify workflow state
      // load journal
      // block on function call
      // -> schedule action that runs function, writes result / schedules poll
      //
      const workflowId = args.workflowId as Id<"workflows">;
      const workflow = await ctx.runQuery(client.ops.loadWorkflow, {
        workflowId,
      });
      if (workflow.generationNumber !== args.generationNumber) {
        console.error(`Invalid generation number: ${args.generationNumber}`);
        return;
      }
      if (workflow.state.type === "completed") {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return;
      }
      const blockedBy = await ctx.runQuery(client.ops.workflowBlockedBy, {
        workflowId,
      });
      if (blockedBy !== null) {
        console.log(`Workflow ${workflowId} blocked by...`);
        console.log(`  ${blockedBy._id}: ${blockedBy.step.type}`);
        // TODO: reschedule ourselves if needed
        return;
      }
      const journalEntries = await ctx.runQuery(client.ops.loadJournal, {
        workflowId,
      });
      for (const journalEntry of journalEntries) {
        if (journalEntry.step.inProgress) {
          throw new Error(
            `Assertion failed: not blocked but have in-progress journal entry`,
          );
        }
      }
      const channel = new BaseChannel<StepRequest>(0);
      const executor = new StepExecutor(
        workflowId,
        ctx,
        client,
        journalEntries,
        channel,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        const step = new StepContext(channel);
        let outcome: Result<any>;
        try {
          const result = await registered.handler(step, workflow.args);
          outcome = { type: "success", result: result ?? null };
        } catch (error: any) {
          outcome = { type: "error", error: error.message };
        }
        return { type: "handlerDone", outcome };
      };
      const executorWorker = async (): Promise<WorkerResult> => {
        return await executor.run();
      };
      const result = await Promise.race([handlerWorker(), executorWorker()]);
      switch (result.type) {
        case "handlerDone": {
          await ctx.runMutation(client.ops.completeWorkflow, {
            workflowId: workflowId,
            generationNumber: args.generationNumber,
            outcome: result.outcome,
            now: Date.now(),
          });
          break;
        }
        case "executorBlocked": {
          const { _id, step } = result.entry;
          switch (step.type) {
            case "function": {
              await ctx.scheduler.runAfter(0, client.ops.runFunction, {
                workflowId: workflowId,
                generationNumber: args.generationNumber,
                journalId: _id,
                functionType: step.functionType,
                handle: step.handle,
                args: step.args,
              });
              break;
            }
            case "sleep": {
              await ctx.scheduler.runAfter(
                step.durationMs,
                client.ops.completeSleep,
                {
                  workflowId: workflowId,
                  generationNumber: args.generationNumber,
                  journalId: _id,
                },
              );
              break;
            }
          }
        }
      }
    },
  }) as any;
}

export type Result<T> =
  | { type: "success"; result: T }
  | { type: "error"; error: string };

type WorkerResult =
  | { type: "handlerDone"; outcome: Result<any> }
  | { type: "executorBlocked"; entry: JournalEntry };

class StepContext implements WorkflowStep {
  constructor(private sender: BaseChannel<StepRequest>) {}

  async runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>> {
    return await this.runFunction("query", query, args);
  }

  async runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>> {
    return await this.runFunction("mutation", mutation, args);
  }

  async runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<FunctionReturnType<Action>> {
    return await this.runFunction("action", action, args);
  }

  async sleep(durationMs: number): Promise<void> {
    let send: any;
    const p = new Promise<void>((resolve) => {
      send = this.sender.push({ type: "sleep", durationMs, resolve });
    });
    await send;
    return p;
  }

  private async runFunction<F extends FunctionReference<any>>(
    functionType: "query" | "mutation" | "action",
    f: F,
    args: any,
  ): Promise<any> {
    const handle = await createFunctionHandle(f);
    let send: any;
    const p = new Promise<any>((resolve, reject) => {
      send = this.sender.push({
        type: "function",
        functionType,
        handle,
        args,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}

type StepRequest =
  | {
      type: "function";
      functionType: "query" | "mutation" | "action";
      handle: string;
      args: any;

      resolve: (result: any) => void;
      reject: (error: any) => void;
    }
  | {
      type: "sleep";
      durationMs: number;
      resolve: (result: any) => void;
    };

class StepExecutor {
  private nextStepNumber: number;
  constructor(
    private workflowId: Id<"workflows">,

    private ctx: GenericMutationCtx<GenericDataModel>,
    private client: InstalledAPI,
    private journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
  ) {
    this.nextStepNumber = journalEntries.length;
  }
  async run(): Promise<WorkerResult> {
    while (true) {
      const message = await this.receiver.get();
      const entry = this.journalEntries.shift();
      if (entry) {
        this.completeMessage(message, entry);
        continue;
      }
      const newEntry = await this.pushJournalEntry(message);
      return { type: "executorBlocked", entry: newEntry };
    }
  }

  completeMessage(message: StepRequest, entry: JournalEntry) {
    if (entry.step.inProgress) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    switch (message.type) {
      case "function": {
        if (entry.step.type !== "function") {
          throw new Error(
            `Journal entry mismatch: ${message.type} !== ${entry.step.type}`,
          );
        }
        const stepArgsJson = JSON.stringify(convexToJson(entry.step.args));
        const messageArgsJson = JSON.stringify(convexToJson(message.args));
        if (stepArgsJson !== messageArgsJson) {
          throw new Error(
            `Journal entry mismatch: ${entry.step.args} !== ${message.args}`,
          );
        }
        if (entry.step.outcome === undefined) {
          throw new Error(
            `Assertion failed: no outcome for completed function call`,
          );
        }
        if (entry.step.outcome.type === "success") {
          message.resolve(entry.step.outcome.result);
        } else {
          message.reject(new Error(entry.step.outcome.error));
        }
        return;
      }
      case "sleep": {
        if (entry.step.type !== "sleep") {
          throw new Error(
            `Journal entry mismatch: ${message.type} !== ${entry.step.type}`,
          );
        }
        if (entry.step.durationMs !== message.durationMs) {
          throw new Error(
            `Journal entry mismatch: ${entry.step.durationMs} !== ${message.durationMs}`,
          );
        }
        message.resolve(undefined);
        return;
      }
    }
  }

  async pushJournalEntry(message: StepRequest): Promise<JournalEntry> {
    const stepNumber = this.nextStepNumber;
    this.nextStepNumber += 1;
    let step: Step;
    switch (message.type) {
      case "function": {
        step = {
          type: "function",
          inProgress: true,
          functionType: message.functionType,
          handle: message.handle,
          args: message.args,
          outcome: undefined,
          startedAt: Date.now(),
          completedAt: undefined,
        };
        break;
      }
      case "sleep": {
        step = {
          type: "sleep",
          inProgress: true,
          durationMs: message.durationMs,
          deadline: Date.now() + message.durationMs,
        };
        break;
      }
    }
    const entry = await this.ctx.runMutation(this.client.ops.pushJournalEntry, {
      workflowId: this.workflowId,
      stepNumber,
      step,
    });
    return entry;
  }
}
