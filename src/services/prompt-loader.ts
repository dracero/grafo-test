import fs from 'fs';
import path from 'path';

export interface PromptSignature {
  name: string;
  description: string;
  inputs: string[];
  outputs: string[];
  instruction: string;
  examples: any[];
}

export class PromptLoader {
  private static promptsDir = path.join(process.cwd(), 'src', 'prompts');

  /**
   * Retrieves the prompt signature for a given agent.
   */
  static getPrompt(agentName: string): PromptSignature {
    const filePath = path.join(this.promptsDir, `${agentName}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Prompt file not found for agent: ${agentName} at path: ${filePath}`);
    }
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  }

  /**
   * Overwrites the prompt signature file (used during optimization).
   */
  static savePrompt(agentName: string, prompt: PromptSignature): void {
    const filePath = path.join(this.promptsDir, `${agentName}.json`);
    // Ensure parent directories exist
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(prompt, null, 2), 'utf-8');
  }

  /**
   * Replaces double curly brace placeholders (e.g. {{variable}}) in the instruction
   * with their stringified or string values from the provided data object.
   */
  static interpolate(instruction: string, data: Record<string, any>): string {
    let result = instruction;
    for (const [key, value] of Object.entries(data)) {
      const stringValue = typeof value === 'object' && value !== null
        ? JSON.stringify(value, null, 2)
        : String(value ?? '');
      // Match {{key}}, {{ key }}, etc.
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      result = result.replace(regex, stringValue);
    }
    return result;
  }
}
