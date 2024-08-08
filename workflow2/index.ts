import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { functions } from "./_generated/api";
import { FunctionHandle } from "convex/server";
import {
  journalDocument,
  JournalEntry,
  outcome,
  step,
  STEP_TYPES,
  Workflow,
  workflowDocument,
} from "./schema";
import { Id } from "./_generated/dataModel";
import { Result } from "./client";

export const createWorkflow = mutation({
  args: {
    workflowHandle: v.string(),
    workflowArgs: v.any(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const workflowId = await ctx.db.insert("workflows", {
      startedAt: now,
      workflowHandle: args.workflowHandle,
      args: args.workflowArgs,
      state: { type: "running" },
      generationNumber: 0,
    });
    await ctx.scheduler.runAfter(
      0,
      args.workflowHandle as FunctionHandle<"mutation", any, any>,
      {
        workflowId,
        generationNumber: 0,
      },
    );
    return workflowId as string;
  },
});

export const loadWorkflow = query({
  args: {
    workflowId: v.string(),
  },
  returns: workflowDocument,
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    return workflow as Workflow;
  },
});

export const completeWorkflow = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    outcome,
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type !== "running") {
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

export const workflowBlockedBy = query({
  args: {
    workflowId: v.string(),
  },
  returns: v.union(journalDocument, v.null()),
  handler: async (ctx, args) => {
    const result = [];
    for (const stepType of STEP_TYPES) {
      const inProgressEntries = await ctx.db
        .query("workflowJournal")
        .withIndex("inProgress", (q) =>
          q
            .eq("step.type", stepType)
            .eq("step.inProgress", true)
            .eq("workflowId", args.workflowId as Id<"workflows">),
        )
        .collect();
      result.push(...inProgressEntries);
    }
    if (result.length > 1) {
      throw new Error("TODO: multiple in-progress entries");
    }
    return (result[0] ?? null) as JournalEntry | null;
  },
});

export const loadJournal = query({
  args: {
    workflowId: v.string(),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const entries = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", args.workflowId as Id<"workflows">),
      )
      .collect();
    return entries as JournalEntry[];
  },
});

export const pushJournalEntry = mutation({
  args: {
    workflowId: v.string(),
    stepNumber: v.number(),
    step,
  },
  returns: journalDocument,
  handler: async (ctx, args) => {
    if (!args.step.inProgress) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const existing = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q
          .eq("workflowId", args.workflowId as Id<"workflows">)
          .eq("stepNumber", args.stepNumber),
      )
      .first();
    if (existing) {
      throw new Error(`Journal entry already exists: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", args.workflowId as Id<"workflows">),
      )
      .order("desc")
      .first();
    if (maxEntry && maxEntry.stepNumber + 1 !== args.stepNumber) {
      throw new Error(`Invalid step number: ${args.stepNumber}`);
    }
    const journalId = await ctx.db.insert("workflowJournal", {
      workflowId: args.workflowId as Id<"workflows">,
      stepNumber: args.stepNumber,
      step: args.step,
    });
    const entry = await ctx.db.get(journalId);
    return entry! as JournalEntry;
  },
});

export const completeSleep = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const journalEntry = await ctx.db.get(
      args.journalId as Id<"workflowJournal">,
    );
    if (!journalEntry) {
      throw new Error(`Journal entry not found: ${args.journalId}`);
    }
    if (journalEntry.workflowId !== args.workflowId) {
      throw new Error(`Journal entry not for this workflow: ${args.journalId}`);
    }
    if (journalEntry.step.type !== "sleep") {
      throw new Error(`Journal entry not a sleep: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }
    journalEntry.step.inProgress = false;
    await ctx.db.replace(journalEntry._id, journalEntry);
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
    });
  },
});

export const runFunction = action({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),

    functionType: v.union(
      v.literal("query"),
      v.literal("mutation"),
      v.literal("action"),
    ),
    handle: v.string(),
    args: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let outcome: Result<any>;
    try {
      switch (args.functionType) {
        case "query": {
          const result = await ctx.runQuery(
            args.handle as FunctionHandle<"query", any>,
            args.args,
          );
          outcome = { type: "success", result };
          break;
        }
        case "mutation": {
          const result = await ctx.runMutation(
            args.handle as FunctionHandle<"mutation", any>,
            args.args,
          );
          outcome = { type: "success", result };
          break;
        }
        case "action": {
          const result = await ctx.runAction(
            args.handle as FunctionHandle<"action", any>,
            args.args,
          );
          outcome = { type: "success", result };
          break;
        }
      }
    } catch (error: any) {
      outcome = { type: "error", error: error.message };
    }
    await ctx.runMutation(functions.index.completeFunction, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
      journalId: args.journalId,
      outcome,
    });
  },
});

export const completeFunction = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
    outcome,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log("completeFunction", args);
    const workflow = await ctx.db.get(args.workflowId as Id<"workflows">);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const journalEntry = await ctx.db.get(
      args.journalId as Id<"workflowJournal">,
    );
    if (!journalEntry) {
      throw new Error(`Journal entry not found: ${args.journalId}`);
    }
    if (journalEntry.workflowId !== args.workflowId) {
      throw new Error(`Journal entry not for this workflow: ${args.journalId}`);
    }
    if (journalEntry.step.type !== "function") {
      throw new Error(`Journal entry not a function: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }
    journalEntry.step.inProgress = false;
    journalEntry.step.outcome = args.outcome;
    journalEntry.step.completedAt = Date.now();
    await ctx.db.replace(journalEntry._id, journalEntry);
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
    });
  },
});
