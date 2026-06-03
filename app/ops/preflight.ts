import { ChecklistStatus, CutoverStage, GateDecision, type PreflightChecklistItem, type PreflightChecklistResult } from "./types";

export class PreflightChecklistRunner {
  async run(stage: CutoverStage, items: readonly PreflightChecklistItem[]): Promise<PreflightChecklistResult> {
    const results: {
      id: string;
      label: string;
      required: boolean;
      status: ChecklistStatus;
    }[] = [];

    for (const item of items) {
      const status = await item.run();
      results.push({
        id: item.id,
        label: item.label,
        required: item.required,
        status
      });
    }

    const failedRequiredItems = results
      .filter((item) => item.required && item.status !== ChecklistStatus.Pass)
      .map((item) => item.id);

    return {
      stage,
      status: failedRequiredItems.length === 0 ? GateDecision.Pass : GateDecision.Hold,
      items: results,
      failedRequiredItems
    };
  }
}
