import {
  ReturnValueForOptionalValidator,
  ArgsArrayForOptionalValidator,
  DefaultArgsForOptionalValidator,
  ArgsArrayToObject,
  GenericDataModel,
  GenericActionCtx,
  RegisteredAction,
  GenericMutationCtx,
  FunctionReference,
  createFunctionHandle,
} from "convex/server";
import { PropertyValidators, Validator } from "convex/values";
import { ComponentClient, parentAction } from "./parentAction.js";

export interface WorkflowStep<DataModel extends GenericDataModel> {
  run<T>(
    label: string,
    fn: (ctx: GenericActionCtx<DataModel>) => Promise<T>,
  ): Promise<T>;

  sleep(ms: number): Promise<void>;
}

// export type RegisteredWorkflow<Args, Returns> = RegisteredAction<
//   "public",
//   Args,
//   Returns
// >;
//  & {
//   __isWorkflow: true;
//   __args: Args;
//   __returns: Returns;
// };
// type WorkflowArgs<W extends RegisteredWorkflow<any, any>> = ArgsArrayToObject<
//   W["__args"]
// >;
// type WorkflowArgs<T> = any;

export type WorkflowId = string & { __isWorkflowId: true };

export class WorkflowClient<DataModel extends GenericDataModel> {
  constructor(private client: ComponentClient) {}

  define<
    ArgsValidator extends PropertyValidators | Validator<any, any, any> | void,
    ReturnsValidator extends
      | PropertyValidators
      | Validator<any, any, any>
      | void,
    ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> = any,
    OneOrZeroArgs extends
      ArgsArrayForOptionalValidator<ArgsValidator> = DefaultArgsForOptionalValidator<ArgsValidator>,
  >(workflow: {
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (
      step: WorkflowStep<DataModel>,
      ...args: OneOrZeroArgs
    ) => ReturnValue;
  }): RegisteredAction<
    "public",
    ArgsArrayToObject<OneOrZeroArgs>,
    ReturnValue
  > {
    return parentAction(this.client, workflow) as any;
  }

  async start<F extends FunctionReference<any, any>>(
    ctx: GenericMutationCtx<DataModel>,
    workflow: F,
    args: F["_args"],
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(this.client.insertWorkflow, {
      args,
      actionHandle: handle,
    });
    return workflowId as WorkflowId;
  }
}
