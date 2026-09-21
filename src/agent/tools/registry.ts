/**
 * The tools a run may call: built-ins selected by name (`--tools Read,Grep,Glob`) plus, from
 * Phase 3, MCP tools namespaced `mcp__<server>__<tool>`.
 */
import { UsageError } from '../../shared/errors'
import { globTool } from './glob'
import { grepTool } from './grep'
import { readTool } from './read'
import { TOOL_NAME, toolSchema, type Tool } from './types'
import { webSearchTool } from './websearch'

/** WebSearch exists but is not in the default trio: a host opts in by naming it. */
export const BUILTIN_TOOLS: Record<string, Tool> = {
  Read: readTool,
  Grep: grepTool,
  Glob: globTool,
  WebSearch: webSearchTool,
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  add(tool: Tool): void {
    if (!TOOL_NAME.test(tool.name)) throw new UsageError(`tool name "${tool.name}" is not [A-Za-z0-9_-]{1,64}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  get size(): number {
    return this.tools.size
  }

  /** llama-server's `tools` field. */
  schemas(): Record<string, unknown>[] {
    return this.list().map(toolSchema)
  }

  /**
   * Markdown cards for the universal selection step: what each tool is FOR, and nothing else.
   *
   * The cards once carried every tool's JSON Schema, re-read on every step of the loop to pick
   * a name. A host with a strict schema made that untenable — motionbuff's build_slide is a
   * union of sixteen treatments, ~20 KB, some 5,000 tokens per choice — and it was never the
   * right place for it: the schema matters when the arguments are WRITTEN, and that request
   * now shows the chosen tool's schema alone (see universal.ts).
   */
  markdown(): string {
    return this.list()
      .map((t) => `### ${t.name}\n${t.description}`)
      .join('\n\n')
  }
}

/** `--tools Read,Grep` → a registry of those built-ins; `none` or empty → an empty one. */
export function builtinRegistry(spec: string | undefined): ToolRegistry {
  const registry = new ToolRegistry()
  const wanted = (spec ?? 'Read,Grep,Glob').trim()
  if (wanted === '' || wanted.toLowerCase() === 'none') return registry
  for (const name of wanted.split(',').map((s) => s.trim()).filter(Boolean)) {
    const tool = BUILTIN_TOOLS[name]
    if (!tool) throw new UsageError(`unknown built-in tool "${name}" (known: ${Object.keys(BUILTIN_TOOLS).join(', ')})`)
    registry.add(tool)
  }
  return registry
}
