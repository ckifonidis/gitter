# Implementation Plan: AI-Powered Repository Descriptions

## Document Info

| Field | Value |
|-------|-------|
| Project | gitter |
| Plan ID | plan-002 |
| Feature | AI-Powered Repository Descriptions |
| Date | 2026-03-22 |
| Status | Ready for Implementation |
| Based On | refined-request-ai-repo-descriptions.md, investigation-ai-integration.md, codebase-scan-ai-enhancement.md |

---

## Overview

This plan details the implementation of the `gitter describe` command, which uses the Anthropic Claude SDK to analyze registered git repositories and generate structured business and technical descriptions. The feature supports three Claude providers (Anthropic direct, Azure AI Foundry, Google Vertex AI) via a priority-based configuration system.

---

## Phase A: Dependencies & Configuration System

### A.1 Install npm Packages

**Action**: Add four production dependencies.

```bash
npm install @anthropic-ai/sdk @anthropic-ai/foundry-sdk @anthropic-ai/vertex-sdk dotenv
```

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Direct Anthropic Claude API client |
| `@anthropic-ai/foundry-sdk` | Azure AI Foundry (Claude on Azure) client |
| `@anthropic-ai/vertex-sdk` | Google Vertex AI client |
| `dotenv` | Load `.env` files for configuration resolution |

**Verification**: Run `npm ls @anthropic-ai/sdk @anthropic-ai/foundry-sdk @anthropic-ai/vertex-sdk dotenv` to confirm all four are in `node_modules`.

### A.2 Create `src/ai-config.ts`

**File**: `src/ai-config.ts`
**Purpose**: Load and validate AI configuration with priority resolution.

#### Configuration Priority (highest to lowest)

1. **Environment variables** (shell-set vars take precedence)
2. **`.env` file** in CWD (loaded via `dotenv.config()` at module import; dotenv does NOT override existing env vars)
3. **`~/.gitter/config.json`** (JSON file in the same directory as `registry.json`)

#### Exported Interface: `AIConfig`

```typescript
export type AIProvider = 'anthropic' | 'azure' | 'vertex';

export interface AIConfig {
  provider: AIProvider;
  model: string;
  maxTokens: number;
  anthropic?: {
    apiKey: string;
  };
  azure?: {
    apiKey: string;
    resource: string;
  };
  vertex?: {
    projectId: string;
    region: string;
  };
}
```

#### Exported Function: `loadAIConfig(): AIConfig`

**Implementation Steps**:

1. Call `dotenv.config()` to load `.env` from CWD (only if not already called). This populates `process.env` for any variables not already set in the shell.
2. Attempt to read `~/.gitter/config.json` using `getRegistryDir()` from `registry.ts`. If the file does not exist, set config-file source to `null`. If it exists but is malformed JSON, throw: `"Config file is corrupted: ~/.gitter/config.json"`.
3. For each configuration field, resolve using the priority chain:

| Config Field | Env Var | Config Path | Required When |
|-------------|---------|-------------|---------------|
| `provider` | `GITTER_AI_PROVIDER` | `ai.provider` | Always |
| `model` | `GITTER_AI_MODEL` | `ai.model` | Always |
| `maxTokens` | `GITTER_AI_MAX_TOKENS` | `ai.maxTokens` | Always |
| `anthropic.apiKey` | `ANTHROPIC_API_KEY` | `ai.anthropic.apiKey` | provider = anthropic |
| `azure.apiKey` | `ANTHROPIC_FOUNDRY_API_KEY` | `ai.azure.apiKey` | provider = azure |
| `azure.resource` | `ANTHROPIC_FOUNDRY_RESOURCE` | `ai.azure.resource` | provider = azure |
| `vertex.projectId` | `ANTHROPIC_VERTEX_PROJECT_ID` | `ai.vertex.projectId` | provider = vertex |
| `vertex.region` | `CLOUD_ML_REGION` | `ai.vertex.region` | provider = vertex |

4. Validate that all required fields for the selected provider are present. If any required field is missing, throw an error with a clear message listing the env var name, config path, and `.env` option. Example:

```
Error: GITTER_AI_PROVIDER is not set. Configure via:
  - Environment variable: export GITTER_AI_PROVIDER=anthropic
  - Config file: set "ai.provider" in ~/.gitter/config.json
  - .env file: add GITTER_AI_PROVIDER=anthropic to .env in your project directory
```

5. Validate `provider` is one of `anthropic`, `azure`, `vertex`. If not, throw: `"Unknown AI provider: '<value>'. Must be one of: anthropic, azure, vertex"`.
6. Parse `maxTokens` from string to number if sourced from env var. If not a valid positive integer, throw.
7. Return the fully resolved `AIConfig` object.

#### Internal Helper: `resolve(envVar, configPath[]): string | undefined`

```typescript
function resolve(envVar: string, configPath: string[]): string | undefined {
  // Priority 1: Environment variable (includes .env values via dotenv)
  const envValue = process.env[envVar];
  if (envValue !== undefined && envValue !== '') return envValue;

  // Priority 2: Config file
  const config = loadConfigFile();
  if (config) {
    let value: unknown = config;
    for (const key of configPath) {
      value = (value as Record<string, unknown>)?.[key];
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }

  return undefined;
}
```

#### Internal Helper: `loadConfigFile(): Record<string, unknown> | null`

- Read `path.join(getRegistryDir(), 'config.json')`.
- If file does not exist, return `null`.
- If file exists, parse JSON. On parse error, throw: `"Config file is corrupted: ~/.gitter/config.json"`.
- Cache the parsed result for the duration of the process (read once, reuse).

#### No Fallback / No Default Rule

Per project rules, there must be NO fallback values for any configuration setting. Missing required config always throws. The only defaults are the CLI argument defaults for `--business-lines` (20) and `--technical-lines` (20), which are Commander option defaults, not configuration settings.

### A.3 Config File Schema: `~/.gitter/config.json`

This file is **not** auto-created. The user creates it manually if they prefer file-based config over environment variables.

```json
{
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 4096,
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "azure": {
      "apiKey": "...",
      "resource": "my-resource.azure.anthropic.com"
    },
    "vertex": {
      "projectId": "my-gcp-project",
      "region": "us-east5"
    }
  }
}
```

**Important corrections from investigation**:
- Azure uses `resource` (hostname only), NOT `endpoint` (full URL). The Foundry SDK does not use `apiVersion` or `deployment` fields.
- Vertex uses `projectId` and `region`. Authentication is via Google Application Default Credentials (ADC), not an API key.
- Vertex model names use `@` format (e.g., `claude-sonnet-4@20250514`), while Anthropic/Azure use `-` format (e.g., `claude-sonnet-4-20250514`). The user must configure the correct format for their provider.

---

## Phase B: AI Client Factory

### B.1 Create `src/ai-client.ts`

**File**: `src/ai-client.ts`
**Purpose**: Factory function that creates the appropriate Claude SDK client based on provider config, plus a wrapper for `messages.create()` with consistent error handling.

#### Imports

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AIConfig } from './ai-config.js';
```

All three SDK packages support ESM imports natively. The project uses `"type": "module"` and `module: "Node16"`.

#### Exported Type: `AIClient`

```typescript
type AIClient = Anthropic | AnthropicFoundry | AnthropicVertex;
```

All three client types share the identical `messages.create()` API surface.

#### Exported Function: `createAIClient(config: AIConfig): AIClient`

**Implementation**:

```typescript
export function createAIClient(config: AIConfig): AIClient {
  switch (config.provider) {
    case 'anthropic':
      return new Anthropic({
        apiKey: config.anthropic!.apiKey,
      });

    case 'azure':
      return new AnthropicFoundry({
        apiKey: config.azure!.apiKey,
        resource: config.azure!.resource,
      });

    case 'vertex':
      return new AnthropicVertex({
        projectId: config.vertex!.projectId,
        region: config.vertex!.region,
      });

    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}
```

The non-null assertions (`!`) are safe because `loadAIConfig()` validates that provider-specific fields are present before returning.

#### Exported Function: `generateDescription(client, config, systemPrompt, userMessage): Promise<string>`

**Purpose**: Wrap the `messages.create()` call with consistent error handling.

**Implementation Steps**:

1. Call `client.messages.create()`:
   ```typescript
   const response = await client.messages.create({
     model: config.model,
     max_tokens: config.maxTokens,
     system: systemPrompt,
     messages: [{ role: 'user', content: userMessage }],
   });
   ```

2. Extract text from response:
   ```typescript
   const textContent = response.content
     .filter((block: { type: string }) => block.type === 'text')
     .map((block: { type: string; text: string }) => block.text)
     .join('\n');
   ```

3. If `textContent` is empty, throw: `"Failed to parse AI response. Please try again."`

4. If `response.stop_reason === 'max_tokens'`, log a warning to stderr: `"Warning: AI response was truncated due to max_tokens limit. Consider increasing GITTER_AI_MAX_TOKENS."`

5. Return `textContent`.

**Error Handling** (wrap in try/catch):

| Error Pattern | User-Facing Message |
|---------------|---------------------|
| `status === 401` or `status === 403` | `"Authentication failed for Claude API. Check your API key/credentials."` |
| `status === 429` | `"Rate limited by Claude API. Please try again later."` |
| `status === 500` or `status === 503` | `"Claude API is temporarily unavailable. Please try again later."` |
| Network error (ECONNREFUSED, ETIMEDOUT) | `"Failed to connect to Claude API: <details>"` |
| Any other error | `"Claude API error: <error.message>"` |

The error detection should check for the `status` property on the thrown error object (the Anthropic SDK throws errors with HTTP status codes).

---

## Phase C: Repository Content Collector

### C.1 Create `src/repo-content.ts`

**File**: `src/repo-content.ts`
**Purpose**: Collect repository content for Claude analysis with token budget management.

#### Exported Interface: `RepoContent`

```typescript
export interface RepoContent {
  fileTree: string;          // git ls-tree output (truncated at 500 lines)
  readme: string | null;     // README content (first 200 lines) or null
  manifest: string | null;   // package.json / Cargo.toml / etc. or null
  projectDocs: string[];     // CLAUDE.md, .cursor/rules (first 100 lines each)
  sourceSnippets: string[];  // Key source file excerpts (first 100 lines each)
  ciConfigs: string[];       // CI/CD config excerpts (first 50 lines each, max 3)
}
```

#### Exported Function: `collectRepoContent(repoPath: string): RepoContent`

**Implementation Steps**:

1. **File Tree** (Priority 1 -- Required):
   - Call `git(['ls-tree', '-r', '--name-only', 'HEAD'], repoPath)` using the existing `git()` function from `src/git.ts`.
   - Truncate to first 500 lines. If truncated, append: `\n... ({remaining} more files)`.
   - If the git command fails (e.g., empty repo with no commits), set to `"(no commits yet)"`.

2. **README** (Priority 1 -- Required if exists):
   - Search for files in order: `README.md`, `README`, `README.rst`, `readme.md`.
   - Read first 200 lines of the first match found.
   - If none found, set to `null`.

3. **Manifest** (Priority 1 -- Required if exists):
   - Search for files in order: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`.
   - Read the full content of the first match found.
   - If none found, set to `null`.

4. **Project Docs** (Priority 2 -- Optional):
   - Check for: `CLAUDE.md`, `.cursor/rules`.
   - Read first 100 lines of each that exists.
   - Collect into `projectDocs` array (may be empty).

5. **Source Snippets** (Priority 2 -- Optional):
   - Use the file tree output to find entry point files matching patterns: `src/main.*`, `src/index.*`, `src/app.*`, `src/lib.*`, `main.*`, `index.*`, `app.*`.
   - Read first 100 lines of each match.
   - Collect into `sourceSnippets` array (may be empty).

6. **CI Configs** (Priority 3 -- Optional):
   - Check for `.github/workflows/` directory.
   - If it exists, list YAML files and read first 50 lines of up to 3 files.
   - Collect into `ciConfigs` array (may be empty).

**File Reading Helper** (internal):

```typescript
function readFileHead(repoPath: string, relativePath: string, maxLines: number): string | null {
  const fullPath = path.join(repoPath, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (truncated at ${maxLines} lines)`;
    }
    return content;
  } catch {
    return null; // Silently skip unreadable files (binary, permissions, etc.)
  }
}
```

#### Exported Function: `formatRepoContentForPrompt(content: RepoContent): string`

**Purpose**: Format collected content into a single string for inclusion in the Claude user message.

**Implementation**:

```typescript
export function formatRepoContentForPrompt(content: RepoContent): string {
  const sections: string[] = [];

  sections.push('--- FILE TREE ---');
  sections.push(content.fileTree);

  if (content.readme) {
    sections.push('\n--- README ---');
    sections.push(content.readme);
  }

  if (content.manifest) {
    sections.push('\n--- PROJECT MANIFEST ---');
    sections.push(content.manifest);
  }

  for (const doc of content.projectDocs) {
    sections.push('\n--- PROJECT DOCUMENTATION ---');
    sections.push(doc);
  }

  for (const snippet of content.sourceSnippets) {
    sections.push('\n--- SOURCE FILE ---');
    sections.push(snippet);
  }

  for (const ci of content.ciConfigs) {
    sections.push('\n--- CI/CD CONFIG ---');
    sections.push(ci);
  }

  return sections.join('\n');
}
```

#### Token Budget Management

**Target**: Total prompt content under ~30,000 tokens (~120KB of text, using the 4 chars/token approximation).

**Implementation**:

After collecting all content, calculate total byte size of the formatted output. If it exceeds 120,000 bytes:

1. Remove CI configs (Priority 3) until under budget.
2. Remove source snippets (Priority 2) until under budget.
3. Remove project docs (Priority 2) until under budget.
4. Truncate README to 100 lines (instead of 200).
5. Truncate file tree to 250 lines (instead of 500).

Log to stderr: `"Content size: ~{sizeKB}KB (~{estimatedTokens} tokens)"`.

If content was truncated to fit budget, log warning to stderr: `"Warning: Repository content was truncated to fit within the token budget."`.

---

## Phase D: Describe Command

### D.1 Create `src/commands/describe.ts`

**File**: `src/commands/describe.ts`
**Purpose**: The main `gitter describe` command handler.

#### Exported Function: `describeCommand(query: string | undefined, options: DescribeOptions): Promise<void>`

**Options Interface** (internal):

```typescript
interface DescribeOptions {
  show?: boolean;
  instructions?: string;
  businessLines?: string;  // Commander passes as string
  technicalLines?: string; // Commander passes as string
}
```

#### Implementation: `--show` Path

When `options.show` is true:

1. Resolve the target repository entry (see "Query Resolution" below).
2. If entry has `description` field:
   - Print `\n` + bold `"Business Description:"` + newline + `entry.description.businessDescription`.
   - Print bold `"Technical Description:"` + newline + `entry.description.technicalDescription`.
   - Print bold `"Description Generated:"` + ` ` + `entry.description.generatedAt`.
   - Print bold `"Generated By:"` + ` ` + `entry.description.generatedBy`.
   - If `entry.description.instructions`, print bold `"Instructions Used:"` + ` ` + `entry.description.instructions`.
3. If entry has NO `description` field:
   - Print: `"No description available for {repoName}. Run 'gitter describe' to generate one."`.
   - Exit(0) (this is informational, not an error).

#### Implementation: Generation Path

When `options.show` is NOT set:

1. **Resolve target repository** (see "Query Resolution" below).
2. **Validate repository path**:
   - If `!existsSync(entry.localPath)`, throw: `"Repository path no longer exists: {localPath}"`.
3. **Load AI configuration**:
   - Call `loadAIConfig()` from `ai-config.ts`.
   - This validates all required config fields and throws on missing values.
4. **Create AI client**:
   - Call `createAIClient(config)` from `ai-client.ts`.
5. **Collect repository content**:
   - Call `collectRepoContent(entry.localPath)` from `repo-content.ts`.
   - Call `formatRepoContentForPrompt(content)` to get the formatted string.
6. **Build system prompt**:
   - Parse `businessLines` and `technicalLines` from options (default string `'20'` from Commander).
   - Construct system prompt with interpolated line counts:
   ```
   You are a technical writer analyzing a software repository. Your task is to produce
   two descriptions of the repository:

   1. BUSINESS DESCRIPTION (~{businessLines} lines): Explain the purpose, use cases,
      target audience, and value proposition of the project. Write for a non-technical
      stakeholder or decision-maker. Focus on what problem the project solves and why
      it matters.

   2. TECHNICAL DESCRIPTION (~{technicalLines} lines): Explain the architecture,
      technology stack, design patterns, and technical approach. Write for a developer
      or technical lead evaluating the project. Focus on how the project works and what
      makes it technically interesting or sound.

   Output format: Use markdown. Start the business description with "## Business Description"
   and the technical description with "## Technical Description". Do not include any other
   top-level headings or preamble.
   ```

7. **Build user message**:
   ```
   Repository: {entry.repoName}
   Path: {entry.localPath}

   {if entry.description exists}
   === EXISTING DESCRIPTION (use as starting point, refine as instructed) ===
   ## Business Description
   {entry.description.businessDescription}

   ## Technical Description
   {entry.description.technicalDescription}
   === END EXISTING DESCRIPTION ===
   {endif}

   {if options.instructions}
   === ADDITIONAL INSTRUCTIONS ===
   {options.instructions}
   === END ADDITIONAL INSTRUCTIONS ===
   {endif}

   === REPOSITORY CONTENT ===
   {formattedRepoContent}
   === END REPOSITORY CONTENT ===
   ```

8. **Show progress indicator**:
   - Print to stderr: `"Generating description for {entry.repoName}..."`.
   - (V1 uses a simple text indicator; a spinner can be added later.)

9. **Call Claude API**:
   - Call `generateDescription(client, config, systemPrompt, userMessage)` from `ai-client.ts`.

10. **Parse response**:
    - Find the `## Technical Description` heading in the response text.
    - Split into business and technical sections.
    - Strip the `## Business Description` and `## Technical Description` headings from each section.
    - If the `## Technical Description` heading is not found, throw: `"Failed to parse AI response: missing '## Technical Description' heading"`.

    ```typescript
    function parseDescription(responseText: string): { business: string; technical: string } {
      const techIndex = responseText.indexOf('## Technical Description');
      if (techIndex === -1) {
        throw new Error('Failed to parse AI response: missing "## Technical Description" heading');
      }
      const businessSection = responseText.substring(0, techIndex).trim();
      const technicalSection = responseText.substring(techIndex).trim();
      const business = businessSection.replace(/^## Business Description\s*/i, '').trim();
      const technical = technicalSection.replace(/^## Technical Description\s*/i, '').trim();
      return { business, technical };
    }
    ```

11. **Store description in registry**:
    - Build a `RepoDescription` object:
      ```typescript
      const description: RepoDescription = {
        businessDescription: parsed.business,
        technicalDescription: parsed.technical,
        generatedAt: new Date().toISOString(),
        generatedBy: config.model,
        instructions: options.instructions,
      };
      ```
    - **Critical**: Do NOT use `addOrUpdate()` from registry.ts. That function replaces the entire `RegistryEntry`, which would wipe branch metadata. Instead:
      - Load the full registry: `const registry = loadRegistry()`.
      - Find the entry in `registry.repositories` by `localPath`.
      - Mutate the entry's `description` field in place: `foundEntry.description = description`.
      - Save the registry: `saveRegistry(registry)`.

12. **Display the generated description**:
    - Print the same formatted output as the `--show` path.

#### Query Resolution Logic

The describe command supports two modes:

**Mode A: Query provided** (`gitter describe myproject`):
1. Load registry.
2. Call `searchEntries(registry, query)`.
3. 0 matches: stderr `"No repositories match query: {query}"` + exit(1).
4. 1 match: use that entry.
5. N matches: interactive select via stderr (same pattern as `info`, `go`, `remove`).

**Mode B: No query** (`gitter describe` from within a registered repo):
1. Check `isInsideGitRepo()`. If false: stderr `"Not inside a git repository. Provide a repo name or run from within a registered git repository."` + exit(1).
2. Get `getRepoRoot()` to get the repo root path.
3. Load registry.
4. Call `findByPath(registry, repoRoot)`.
5. If no match: stderr `"Current repository is not registered. Run 'gitter scan' first."` + exit(1).
6. Use the found entry.

---

## Phase E: Integration with Existing Codebase

### E.1 Extend `src/types.ts`

**Action**: Add the `RepoDescription` interface and extend `RegistryEntry`.

**Changes**:

After the existing `RegistryEntry` interface, add:

```typescript
/**
 * AI-generated description of a repository.
 */
export interface RepoDescription {
  /** Business-oriented description in markdown */
  businessDescription: string;
  /** Technical description in markdown */
  technicalDescription: string;
  /** ISO 8601 timestamp of when this description was generated */
  generatedAt: string;
  /** The AI model used to generate this description */
  generatedBy: string;
  /** User instructions that were used (if any) */
  instructions?: string;
}
```

Add one field to `RegistryEntry`:

```typescript
export interface RegistryEntry {
  // ... existing fields unchanged ...

  /** AI-generated description of the repository (optional, populated by describe command) */
  description?: RepoDescription;
}
```

**Impact Assessment**:
- The field is optional, so existing registries with no `description` fields remain valid.
- No registry version bump needed (backward compatible).
- `loadRegistry()` and `saveRegistry()` require no changes (they serialize/deserialize the full object graph).
- `addOrUpdate()` in registry.ts replaces the full entry by `localPath`. Since `scan` calls `collectRepoMetadata()` which does not include a `description` field, re-scanning would **lose** the description. This is acceptable behavior since `scan` refreshes git metadata; the user can re-run `describe` after.
  - **Mitigation**: In `src/commands/scan.ts`, after calling `collectRepoMetadata()`, check if the registry already has an entry with the same `localPath` and if it has a `description` field. If so, carry over the `description` to the new entry before calling `addOrUpdate()`. This preserves descriptions across re-scans.

### E.2 Extend `src/commands/info.ts`

**Action**: Add a description section at the end of the info output.

**Location**: After line 90 (the `Last Updated` line), before the function's closing brace.

**Code to Add**:

```typescript
// Description section
if (entry.description) {
  console.log(pc.bold('--- Description ---'));
  console.log(`${pc.bold('Business Description:')}`);
  console.log(entry.description.businessDescription);
  console.log();
  console.log(`${pc.bold('Technical Description:')}`);
  console.log(entry.description.technicalDescription);
  console.log(`${pc.bold('Description Generated:')} ${entry.description.generatedAt}`);
  console.log(`${pc.bold('Generated By:')} ${entry.description.generatedBy}`);
  if (entry.description.instructions) {
    console.log(`${pc.bold('Instructions Used:')} ${entry.description.instructions}`);
  }
} else {
  console.log(`${pc.bold('Description:')} (none -- run 'gitter describe' to generate)`);
}
```

**No other changes to info.ts** are needed. The `RegistryEntry` type is already imported.

### E.3 Extend `src/commands/scan.ts`

**Action**: Preserve `description` field across re-scans.

**Change**: After calling `collectRepoMetadata()`, before calling `addOrUpdate()`, check if the existing entry has a description and carry it over.

```typescript
const entry = collectRepoMetadata();
const registry = loadRegistry();

// Preserve existing description across re-scans
const existingEntry = findByPath(registry, entry.localPath);
if (existingEntry?.description) {
  entry.description = existingEntry.description;
}

const updated = addOrUpdate(registry, entry);
saveRegistry(updated);
```

This requires importing `findByPath` from `registry.ts` (if not already imported in scan.ts).

### E.4 Wire Describe Command in `src/cli.ts`

**Action**: Import and register the describe command.

**Import to add** (after existing imports):

```typescript
import { describeCommand } from './commands/describe.js';
```

**Command registration** (add after the `init` command registration, before the default action):

```typescript
program
  .command('describe [query]')
  .description('Generate or show AI-powered repository description')
  .option('--instructions <text>', 'Additional instructions for the AI')
  .option('--show', 'Show stored description without regenerating')
  .option('--business-lines <n>', 'Target line count for business description', '20')
  .option('--technical-lines <n>', 'Target line count for technical description', '20')
  .action(describeCommand);
```

**Note**: Commander passes options as the last argument when positional args are optional (`[query]`). The `describeCommand` function signature must handle this: `(query: string | undefined, options: DescribeOptions)`.

---

## Phase F: Documentation

### F.1 Create Configuration Guide

**File**: `docs/design/configuration-guide.md`

**Contents** (must follow the configuration-guide template from CLAUDE.md):

1. **Configuration Options and Priority**: Explain the three sources (env vars, `.env` file, `~/.gitter/config.json`) and their priority order.

2. **Configuration Variables** -- for each variable:
   - Purpose and use
   - How to obtain the value
   - Recommended storage approach
   - Available options and what each means
   - Default value (none -- all are required, no defaults)

3. **Provider-Specific Setup Instructions**:
   - Anthropic direct: How to get an API key from console.anthropic.com
   - Azure AI Foundry: How to set up a Claude deployment and get the resource hostname + API key
   - Google Vertex AI: How to enable the Claude API, set up ADC, get project ID and region

4. **Vertex AI Model Name Format**: Document that Vertex uses `@` format (e.g., `claude-sonnet-4@20250514`) while Anthropic and Azure use `-` format (e.g., `claude-sonnet-4-20250514`).

5. **Expiration Tracking**: Propose adding a `GITTER_AI_KEY_EXPIRY` parameter (or `ai.keyExpiry` in config.json) to capture the API key expiration date, so the tool can warn users to renew before the key expires. This is an optional enhancement field.

6. **Example Configurations**:
   - Minimal `.env` file for each provider
   - Full `config.json` example
   - Mixed configuration (provider in config file, API key in env var)

### F.2 Update `docs/design/project-functions.md`

**Action**: Add FR-12 through FR-15 to the functional requirements document. See the companion update below.

### F.3 Update Project CLAUDE.md

**File**: `/Users/giorgosmarinos/aiwork/coding-platform/gitter/CLAUDE.md` (if it exists, or the parent project's CLAUDE.md)

**Action**: Add documentation for the `describe` command in the `<toolName>` format specified in the global CLAUDE.md instructions.

### F.4 Update `docs/design/project-design.md`

**Action**: Add the following sections:

1. **Component diagram**: Add `describe` to the subcommands list, add AI modules box.
2. **Data model**: Add `RepoDescription` interface to Section 2.
3. **Module design**: Add sections for `ai-config.ts`, `ai-client.ts`, `repo-content.ts`, and `commands/describe.ts`.
4. **Updated file structure**: Add new files.
5. **Updated technology stack**: Add new dependencies.

---

## Implementation Order and Dependencies

```
Phase A: Dependencies & Config System
  A.1: Install npm packages              (no deps)
  A.2: Create src/ai-config.ts           (depends on A.1, uses registry.ts getRegistryDir)
  A.3: Config file schema documentation  (no code deps)

Phase B: AI Client Factory
  B.1: Create src/ai-client.ts           (depends on A.2 for AIConfig type)

Phase C: Repository Content Collector
  C.1: Create src/repo-content.ts        (depends on git.ts for git() function)

Phase D: Describe Command
  D.1: Create src/commands/describe.ts   (depends on B.1, C.1, and E.1)

Phase E: Integration
  E.1: Extend src/types.ts               (no deps, should be done early)
  E.2: Extend src/commands/info.ts       (depends on E.1)
  E.3: Extend src/commands/scan.ts       (depends on E.1)
  E.4: Wire in src/cli.ts               (depends on D.1)

Phase F: Documentation
  F.1: Configuration guide               (depends on A.2)
  F.2: Update project-functions.md       (no code deps)
  F.3: Update CLAUDE.md                  (depends on D.1)
  F.4: Update project-design.md          (depends on all phases)
```

### Recommended Execution Sequence

```
1. E.1 (types.ts)           -- unlocks everything
2. A.1 (npm install)         -- unlocks B and dotenv usage
3. A.2 (ai-config.ts)        -- can be done in parallel with C.1
4. C.1 (repo-content.ts)     -- can be done in parallel with A.2
5. B.1 (ai-client.ts)        -- needs A.2 complete
6. D.1 (describe.ts)         -- needs B.1, C.1, E.1
7. E.2, E.3, E.4             -- can be done in parallel after D.1/E.1
8. F.1-F.4                   -- documentation, done last
9. Build + Test              -- npm run build, manual testing
```

---

## New Files Summary

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/ai-config.ts` | Configuration loading with priority resolution | ~120 |
| `src/ai-client.ts` | Client factory + messages.create wrapper | ~90 |
| `src/repo-content.ts` | Repository content collection and formatting | ~150 |
| `src/commands/describe.ts` | Describe command handler | ~180 |

## Modified Files Summary

| File | Change | Lines Changed (est.) |
|------|--------|---------------------|
| `src/types.ts` | Add `RepoDescription` interface + `description?` field | +15 |
| `src/commands/info.ts` | Add description display section | +15 |
| `src/commands/scan.ts` | Preserve description across re-scans | +5 |
| `src/cli.ts` | Import + register describe command | +8 |
| `package.json` | New dependencies (auto-updated by npm install) | auto |

## Unchanged Files

| File | Reason |
|------|--------|
| `src/registry.ts` | Handles arbitrary JSON; no changes needed |
| `src/git.ts` | Reused as-is; `git()` function called from `repo-content.ts` |
| `src/commands/go.ts` | No description interaction |
| `src/commands/search.ts` | No description interaction |
| `src/commands/list.ts` | No description interaction |
| `src/commands/remove.ts` | Removing entry removes description automatically |
| `src/commands/init.ts` | Shell function unchanged |

---

## Error Handling Summary

| Scenario | Message | Exit Code |
|----------|---------|:---------:|
| No AI provider configured | "GITTER_AI_PROVIDER is not set. Configure via: ..." | 1 |
| Missing API key for provider | "ANTHROPIC_API_KEY is not set. Configure via: ..." | 1 |
| AI model not configured | "GITTER_AI_MODEL is not set. Configure via: ..." | 1 |
| Unknown provider value | "Unknown AI provider: '<value>'. Must be one of: anthropic, azure, vertex" | 1 |
| Config file malformed JSON | "Config file is corrupted: ~/.gitter/config.json" | 1 |
| Claude API auth failure | "Authentication failed for Claude API. Check your API key/credentials." | 1 |
| Claude API rate limit | "Rate limited by Claude API. Please try again later." | 1 |
| Claude API network error | "Failed to connect to Claude API: <details>" | 1 |
| Response parsing failure | "Failed to parse AI response: missing '## Technical Description' heading" | 1 |
| Repo path does not exist | "Repository path no longer exists: <path>" | 1 |
| Not inside git repo (no query) | "Not inside a git repository. Provide a repo name or run from within a registered git repository." | 1 |
| Repo not registered (no query) | "Current repository is not registered. Run 'gitter scan' first." | 1 |
| `--show` with no description | "No description available for <name>. Run 'gitter describe' to generate one." | 0 |

---

## Testing Strategy

### Manual Test Cases

1. **Config from env vars**: Set `GITTER_AI_PROVIDER`, `GITTER_AI_MODEL`, `ANTHROPIC_API_KEY` in shell. Run `gitter describe`. Verify it uses the env values.
2. **Config from .env file**: Create `.env` in CWD with the three required vars. Run `gitter describe`. Verify it loads from `.env`.
3. **Config from config.json**: Create `~/.gitter/config.json` with full AI section. Run `gitter describe`. Verify it loads from config file.
4. **Priority override**: Set one var in env and a different value in config.json. Verify env wins.
5. **Missing config**: Unset all config. Run `gitter describe`. Verify clear error message.
6. **Generate description**: Run `gitter describe <registered-repo>`. Verify description is generated and stored.
7. **Show description**: Run `gitter describe <repo> --show`. Verify stored description is displayed.
8. **Refinement**: Run `gitter describe <repo> --instructions "focus on security"`. Verify existing description is included in prompt and refined output is stored.
9. **Info integration**: Run `gitter info <repo>` after generating a description. Verify description appears in output.
10. **Scan preservation**: Run `gitter scan` in a repo that has a description. Verify description is preserved after re-scan.
11. **Custom line counts**: Run `gitter describe <repo> --business-lines 5 --technical-lines 40`. Verify the prompt uses these values.
12. **CWD resolution**: `cd` into a registered repo and run `gitter describe` (no query). Verify it uses the current repo.
13. **Large repo**: Run on a repo with >500 files. Verify file tree is truncated and content size is logged.

### Test Script Location

Per project rules, test scripts go in `test_scripts/`. Create `test_scripts/test-describe.sh` for manual testing.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| SDK packages add significant node_modules size | Acceptable for a CLI tool; no mitigation needed |
| Vertex model name format confusion | Document clearly in configuration guide; the user must set the correct format |
| API costs from accidental repeated runs | No mitigation in v1; deferred (cost estimation, confirmation prompt) |
| Scan overwrites description | Mitigated by carrying over `description` field in scan.ts (Phase E.3) |
| Token budget exceeded for very large repos | Progressive truncation strategy in repo-content.ts |
| dotenv not loading .env | Standard behavior; well-tested library. Log config source to stderr for debugging |
