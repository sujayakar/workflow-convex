import { v } from "convex/values";
import { OpenAI } from "openai";
import { WorkflowClient } from "../workflow2/client";
import { action, app, mutation } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const workflow = new WorkflowClient(app.workflow2);

export const experiment = workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (step, args) => {
    const transcription = await step.runAction(
      api.experiment4.computeTranscription,
      {
        storageId: args.storageId,
      },
    );
    await step.sleep(10 * 1000);
    const embedding = await step.runAction(api.experiment4.computeEmbedding, {
      transcription,
    });
    console.log("embedding done", embedding);
  },
});

export const computeTranscription = action({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) {
      throw new Error(`Invalid storage ID: ${args.storageId}`);
    }
    const file = new File([blob], `${args.storageId}.mp3`, {
      type: "audio/mpeg",
    });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    return transcription.text;
  },
});

export const computeEmbedding = action({
  args: {
    transcription: v.string(),
  },
  returns: v.array(v.number()),
  handler: async (ctx, args) => {
    const embedding = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: [args.transcription],
    });
    return embedding.data[0].embedding;
  },
});

export const kickoffWorkflow = mutation({
  handler: async (ctx) => {
    const storageId = "kg2c4mhdc0xvt772gzyk26g1856yayky" as Id<"_storage">;
    await workflow.start(ctx, api.experiment4.experiment, { storageId });
  },
});
