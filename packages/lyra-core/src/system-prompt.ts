export interface SystemCapability {
  name: string;
  description: string;
}

export interface SystemPromptEnvironment {
  os: string;
  arch: string;
  workspace: string;
  origin: string;
  session: string;
  tools: readonly SystemCapability[];
  skills: readonly SystemCapability[];
}

export function buildSystemPrompt(environment: SystemPromptEnvironment): string {
  const lines = [
    "# Lyra",
    `OS: ${environment.os} ${environment.arch}`,
    `Workspace: ${environment.workspace}`,
    `Origin: ${environment.origin}`,
    `Session: ${environment.session}`,
    "",
    "## Tools",
    ...capabilityLines(environment.tools),
    "",
    "## Skills",
    ...capabilityLines(environment.skills),
  ];
  const prompt = `${lines.join("\n")}\n`;
  if (prompt.length > 4_000) {
    throw new Error(
      `System capability index is ${prompt.length} characters; keep it under 4,000 by shortening descriptions`,
    );
  }
  return prompt;
}

function capabilityLines(capabilities: readonly SystemCapability[]): string[] {
  const names = new Set<string>();
  return capabilities.map((capability) => {
    if (capability.name.length === 0 || capability.description.length === 0) {
      throw new Error("System capabilities require a name and one-line description");
    }
    if (capability.name.includes("\n") || capability.description.includes("\n")) {
      throw new Error(`System capability ${capability.name} must fit on one line`);
    }
    if (names.has(capability.name)) throw new Error(`Duplicate system capability: ${capability.name}`);
    names.add(capability.name);
    return `${capability.name.padEnd(8)} — ${capability.description}`;
  });
}
