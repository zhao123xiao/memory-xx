import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface AuthChecker {
  isAuthenticated(req: IncomingMessage): boolean;
  isAuthEnabled(): boolean;
}

export function createAuthChecker(env: NodeJS.ProcessEnv): AuthChecker {
  const expectedToken = (env.MEMORY_V2_API_TOKEN ?? "").trim();
  const enabled = expectedToken.length > 0;

  function extractToken(req: IncomingMessage): string {
    const bearer = req.headers["authorization"];
    if (typeof bearer === "string" && bearer.startsWith("Bearer ")) {
      return bearer.slice(7).trim();
    }
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string") {
      return apiKey.trim();
    }
    return "";
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    return timingSafeEqual(bufA, bufB);
  }

  return {
    isAuthEnabled: () => enabled,
    isAuthenticated: (req) => {
      if (!enabled) return true;
      const token = extractToken(req);
      return token.length > 0 && constantTimeEqual(token, expectedToken);
    },
  };
}
