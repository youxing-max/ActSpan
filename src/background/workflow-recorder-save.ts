import type { FunctionResult } from '../functions/types';
import { saveWorkflowFunction } from '../functions/save-workflow';

type SaveWorkflowExecutor = (params: Record<string, unknown>) => Promise<FunctionResult>;

export const saveAuditedWorkflow = async (
  workflow: Record<string, unknown>,
  execute: SaveWorkflowExecutor = saveWorkflowFunction.execute,
): Promise<FunctionResult> => execute({ workflow_json: JSON.stringify(workflow) });
