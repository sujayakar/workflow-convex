import { DefaultFunctionArgs, RegisteredAction } from "convex/server";
import { v, Validator } from "convex/values";

interface WorkflowConfig<Args extends DefaultFunctionArgs, Returns> {
  id: string;
  args: Validator<Args, any, any>;
  returns: Validator<Returns, any, any>;
}

interface RegisteredWorkflow<Args extends DefaultFunctionArgs, Returns>
  extends RegisteredAction<"internal", Args, Returns> {}

interface WorkflowCtx {
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

interface ConvexWorkflow {
  createFunction<Args extends DefaultFunctionArgs, Returns>(
    config: WorkflowConfig<Args, Returns>,
    handler: (ctx: WorkflowCtx, args: Args) => Promise<Returns>,
  ): RegisteredWorkflow<Args, Returns>;
}

const workflow: ConvexWorkflow = {
  createFunction: null as any,
};

// export default workflow.createFunction(
//   {
//     id: "experiment2",
//     args: v.object({ storageId: v.id("_storage") }),
//     returns: v.null(),
//   },
//   async (ctx, args) => {
//     const s3Urls = await ctx.run("copy-images-to-s3", async () => {
//       return ["foo", "bar"];
//     });
//     await ctx.run("resize-images", async () => {
//       return "foo";
//     });
//   },
// );
