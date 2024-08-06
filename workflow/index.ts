// TODO:
// [ ] Easier typesafety for client constructor
// [ ] Cancelation
// [ ] Preemption for idempotent steps

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { outcome } from "./schema";
import { FunctionHandle } from "convex/server";

export const insertWorkflow = mutation({
  args: {
    actionHandle: v.string(),
    args: v.any(),
  },
  handler: async (ctx, args) => {
    const workflowId = await ctx.db.insert("workflows", {
      startedAt: Date.now(),
      actionHandle: args.actionHandle,
      args: args.args,
      state: { type: "running" },
      executing: false,
      generationNumber: 0,
      lastHeartbeat: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      args.actionHandle as FunctionHandle<"action", any, any>,
      {
        workflowId,
        generationNumber: 0,
      },
    );
    return workflowId;
  },
});

export const startWorkflow = mutation({
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
    if (workflow.executing) {
      throw new Error(`Workflow already executing: ${args.workflowId}`);
    }
    if (workflow.sleepingUntil && workflow.sleepingUntil <= args.now) {
      delete workflow.sleepingUntil;
    }
    workflow.executing = true;
    workflow.lastHeartbeat = args.now;
    await ctx.db.replace(workflow._id, workflow);

    return workflow;
  },
});

export const putWorkflowToSleep = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    until: v.number(),
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
    if (!workflow.executing) {
      throw new Error(`Workflow not executing: ${args.workflowId}`);
    }
    workflow.executing = false;
    workflow.sleepingUntil = args.until;
    await ctx.db.replace(workflow._id, workflow);
    await ctx.scheduler.runAt(
      args.until,
      workflow.actionHandle as FunctionHandle<"action", any, any>,
      {
        workflowId: args.workflowId,
        generationNumber: args.generationNumber,
      },
    );
  },
});

export const heartbeatWorkflow = mutation({
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
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    workflow.lastHeartbeat = args.now;
    await ctx.db.replace(workflow._id, workflow);
  },
});

export const completeWorkflow = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    outcome,
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
    workflow.executing = false;
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    await ctx.db.replace(workflow._id, workflow);
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
