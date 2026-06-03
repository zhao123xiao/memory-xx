// MCP tool registration and dispatch — self-contained.

export interface ToolInputSchema {
  readonly type: "object";
  readonly properties?: Record<string, {
    readonly type: string;
    readonly description?: string;
    readonly enum?: readonly string[];
    readonly default?: unknown;
  }>;
  readonly required?: readonly string[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.handler(args);
  }
}

export interface ResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export type ResourceHandler = () => Promise<{ content: string; mimeType?: string }>;

interface RegisteredResource {
  readonly definition: ResourceDefinition;
  readonly handler: ResourceHandler;
}

export class ResourceRegistry {
  private readonly resources = new Map<string, RegisteredResource>();

  register(definition: ResourceDefinition, handler: ResourceHandler): void {
    this.resources.set(definition.uri, { definition, handler });
  }

  list(): ResourceDefinition[] {
    return Array.from(this.resources.values()).map((r) => r.definition);
  }

  has(uri: string): boolean {
    return this.resources.has(uri);
  }

  async read(uri: string): Promise<{ content: string; mimeType?: string }> {
    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resource.handler();
  }
}
