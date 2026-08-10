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
    `Directory: ${environment.workspace}`,
    // Only when it differs — which is exactly the isolated-child case. A main session runs
    // in the project directory itself, and printing the same path twice under two names
    // taught the model there was a second place to look for the files it was editing.
    ...(environment.origin === environment.workspace ? [] : [`Project: ${environment.origin}`]),
    `Session: ${environment.session}`,
    // One line, because the state directory is now inside the tree the model can see and
    // the undo history is a capability it can use rather than a background service.
    "State: .lyra/ holds Lyra's own state — do not read or edit it. Every state-changing tool call is checkpointed there; git op:\"list\"/\"diff\"/\"restore\" inspects and rewinds.",
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
