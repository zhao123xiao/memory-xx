import {
  parseRecallRequest,
  RECALL_QUERY_ROUTE,
  type RecallHttpRequest,
  type RecallHttpResponse
} from "../../recall/contracts";
import {
  isRecallError,
  toRecallErrorResponseBody
} from "../../recall/errors";
import { type RecallOrchestrator } from "../../recall/orchestrator";

export interface RecallRouteHandler {
  readonly route: typeof RECALL_QUERY_ROUTE;
  handle(request: RecallHttpRequest): Promise<RecallHttpResponse>;
}

export function createRecallRouteHandler(
  orchestrator: RecallOrchestrator
): RecallRouteHandler {
  return {
    route: RECALL_QUERY_ROUTE,
    async handle(request: RecallHttpRequest): Promise<RecallHttpResponse> {
      try {
        const parsedRequest = parseRecallRequest(request.body);
        const response = await orchestrator.execute(parsedRequest);
        return {
          status: 200,
          body: response
        };
      } catch (error) {
        if (isRecallError(error)) {
          return {
            status: error.status,
            body: toRecallErrorResponseBody(error)
          };
        }

        throw error;
      }
    }
  };
}
