# Copilot Studio Setup Guide for Tool Calling

This guide explains what you need to configure manually in Microsoft Copilot Studio
to make the web search, email, and calendar tool providers work with OpenClaw.

## Overview

Copilot Studio acts as a middleware that connects to Microsoft 365 services (Graph API,
Outlook, Calendar) via its built-in connectors. OpenClaw sends natural language prompts
to CS, which then orchestrates the actual API calls internally.

The AI cannot intercept or auto-configure CS topics and responses. You must set these
up manually in the Copilot Studio portal.

## Prerequisites

1. A Microsoft 365 tenant with Copilot Studio access
2. An Azure AD app registration (for MSAL device code auth)
3. The Copilot Studio Direct Connect URL for your agent

## How OpenClaw Communicates with Copilot Studio

### Direct Connect API Protocol

OpenClaw uses the Copilot Studio Direct Connect API (same protocol as the
`@microsoft/agents-copilotstudio-client` SDK). All communication happens over
HTTPS with Bearer token authentication (MSAL device code flow).

**Base URL:** Derived from your `directConnectUrl` config. The client strips any
existing `/conversations` path suffix and reconstructs it.

#### Step 1: Start Conversation

```
POST {baseUrl}/conversations
Content-Type: application/json
Authorization: Bearer {msal-token}
Accept: text/event-stream

{ "emitStartConversationEvent": true }
```

Response: SSE stream (drained). The conversation ID comes from the
`x-ms-conversationid` response header.

#### Step 2: Send Message Activity

```
POST {baseUrl}/conversations/{conversationId}
Content-Type: application/json
Authorization: Bearer {msal-token}
Accept: text/event-stream

{
  "activity": {
    "type": "message",
    "text": "<natural language prompt>",
    "conversation": { "id": "{conversationId}" }
  }
}
```

Response: SSE stream containing one or more activity JSON objects.

#### Step 3: Continue Conversation (follow-up messages)

Same as Step 2, using the same `conversationId`. Conversations are reused for
30 minutes (TTL). After 30 minutes of inactivity, a new conversation is started.

### SSE Response Format

The response body is a Server-Sent Events stream. Each event line is:

```
data: { ...activity JSON... }
```

The stream ends with:

```
data: end
```

#### Activity Object Structure

Each activity in the SSE stream has this shape:

```json
{
  "type": "message" | "typing" | "event",
  "text": "The response text content",
  "conversation": { "id": "conv-id-abc123" },
  "channelData": {
    "streamType": "streaming" | "informative" | null,
    "streamId": "stream-id-xyz"
  },
  "entities": [
    { "type": "streaminfo", "streamType": "final" }
  ],
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": { /* Adaptive Card JSON */ },
      "name": "optional-card-name"
    }
  ],
  "name": "event-name",
  "value": { /* event payload */ }
}
```

#### How OpenClaw Processes Activities

OpenClaw collects all activities and builds the response text:

1. **Streaming messages** (`type: "typing"` or `type: "message"` with
   `channelData.streamType: "streaming"`): Accumulated by `streamId`. Each new
   chunk replaces the previous one for that stream (CS sends the full text so far,
   not deltas).

2. **Final messages** (`type: "message"` with `entities` containing
   `{ type: "streaminfo", streamType: "final" }`): The definitive response text
   for that stream.

3. **Standalone messages** (`type: "message"` without streaming metadata):
   Appended as separate paragraphs.

4. **Adaptive cards** (`attachments` with
   `contentType: "application/vnd.microsoft.card.adaptive"`): Extracted and forwarded
   to the messaging channel (e.g. Teams) for display. Common for connector consent
   flows.

5. **Event activities** (`type: "event"` with `name` and `value`): Logged for
   debugging. Citation events (`name: "citation"`) have their `value` extracted
   and returned as citation URLs.

**What OpenClaw returns to the AI agent:** A JSON object with:

```json
{
  "action": "read",
  "provider": "copilot-studio",
  "content": "The collected text response from CS",
  "citations": ["https://example.com/source1"],
  "structured": null
}
```

## What Prompts OpenClaw Sends (Exact Text)

OpenClaw's core tools construct natural language prompts from structured parameters
and send them to CS as the `text` field of a message activity. Your CS topics must
be able to match and respond to these prompt patterns.

### Web Search Prompts

The web search tool sends the user's query directly as the prompt text. Examples:

- `"latest TypeScript 5.0 features"`
- `"OpenClaw documentation site"`
- `"Node.js performance benchmarks 2026"`

The raw search query string is passed through. No wrapper text is added.

### Email Prompts

The email tool (`action` parameter determines the prompt):

**action: "read"** (check recent emails)

```
Check my recent emails. Filter: {query}. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.
```

Without a filter query:

```
Check my recent emails. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.
```

**action: "search"** (find specific emails)

```
Search my emails for: {query}. List up to 5 matches with sender, subject, date, and a brief summary. Do not include full email bodies.
```

**action: "send"** (compose and send)

```
Send an email to {to} with subject "{subject}" and body:

{body}

Confirm when sent.
```

### Calendar Prompts

The calendar tool (`action` parameter determines the prompt):

**action: "check"** (upcoming events)

```
Check my calendar for {query}. List each event with time, title, and attendees. Be concise.
```

Default query if none provided: `"next 24 hours"`

**action: "search"** (find events)

```
Search my calendar for events matching: {query}. List matching events with date, time, title, and attendees.
```

**action: "create"** (new event)

Without attendees:

```
Create a calendar event: "{title}" at {datetime}, duration {duration}. Confirm when created.
```

With attendees:

```
Create a calendar event: "{title}" at {datetime}, duration {duration}, with attendees: {attendees}. Confirm when created.
```

Default duration if none provided: `"30 minutes"`

### Agent Mode Prompts (agentMode: true)

When CS is used as a full model provider (not just tools), the first message in a
conversation includes the OpenClaw system prompt prepended:

```
{system prompt}

{user message}
```

Subsequent messages in the same conversation (within 30-min TTL) send only the
user message text. CS maintains its own conversation history internally.

## Expected CS Response Format

CS topics should return plain text responses. OpenClaw extracts the text from
`type: "message"` activities in the SSE stream. The response requirements:

### For Web Search

Return the search results as plain text with source URLs inline. Example:

```
TypeScript 5.0 introduced decorators, const type parameters, and
improved enum support. Key features include...

Sources:
- https://devblogs.microsoft.com/typescript/...
- https://www.typescriptlang.org/docs/...
```

If your agent supports citation events, emit `type: "event"` activities with
`name: "citation"` and the URL as `value`. OpenClaw collects these into a
`citations` array.

### For Email

**Read/Search responses:** Return a plain text list of emails:

```
Here are your recent emails:

1. From: john@example.com
   Subject: Weekly Report
   Summary: Q4 numbers are looking strong...

2. From: jane@example.com
   Subject: Meeting Tomorrow
   Summary: Can we move the standup to 10am?
```

**Send responses:** Confirm the send action:

```
Email sent successfully to john@example.com with subject "Project Update".
```

### For Calendar

**Check/Search responses:** Return a plain text list of events:

```
Your calendar for today:

1. 9:00 AM - 9:30 AM: Daily Standup
   Attendees: team@example.com

2. 2:00 PM - 3:00 PM: Sprint Review
   Attendees: john@example.com, jane@example.com
```

**Create responses:** Confirm the creation:

```
Calendar event created: "Team Meeting" on February 24, 2026 at 2:00 PM, duration 1 hour, with attendees: john@example.com.
```

### Consent / Adaptive Cards

When a CS connector (Outlook, Calendar) requires user consent, CS returns an
adaptive card attachment in the SSE activity:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "content": {
        "type": "AdaptiveCard",
        "body": [{ "type": "TextBlock", "text": "Allow access to Outlook?" }],
        "actions": [{ "type": "Action.Submit", "title": "Allow" }]
      }
    }
  ]
}
```

OpenClaw extracts these cards and forwards them to the messaging channel (e.g.
Teams). The user clicks "Allow" in the channel UI, and subsequent tool calls
proceed without consent prompts.

## Step 1: Create a Copilot Studio Agent

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. Create a new agent (or use an existing one)
3. Note the **Direct Connect URL** from the agent's settings (Channels > Direct Line)

## Step 2: Configure Topics for Each Tool Domain

### Web Search Topic

CS has built-in web search capability. You need to ensure it is enabled:

1. In your agent, go to **Topics**
2. Verify the system "Conversational boosting" topic is enabled (this provides web search)
3. Alternatively, create a custom topic:
   - **Trigger phrases**: Match raw search queries (CS generative orchestration
     handles varied formats if enabled)
   - **Actions**: Add a "Search with Bing" action node
   - **Response**: Return the search results as plain text with source URLs

### Email Topic

To enable email capabilities, you need to connect the Outlook connector:

1. Go to **Topics** > Create new topic
2. **Name**: "Email Operations"
3. **Trigger phrases** (must match the prompts OpenClaw sends):
   - "Check my recent emails"
   - "Search my emails for"
   - "Send an email to"
   - "List up to 5 with sender"
   - "Do not include full email bodies"
4. Add a **Plugin action** node:
   - Select the **Microsoft 365 Outlook** connector
   - For read/search: use "Get emails (V3)" or "Search email (V2)"
   - For send: use "Send an email (V2)"
5. Configure the response to format results as plain text (sender, subject, summary)
6. **Important**: The first time a user triggers email, CS will return a consent
   adaptive card. OpenClaw forwards this to the channel — the user must approve.

### Calendar Topic

1. Go to **Topics** > Create new topic
2. **Name**: "Calendar Operations"
3. **Trigger phrases** (must match the prompts OpenClaw sends):
   - "Check my calendar for"
   - "Search my calendar for events matching"
   - "Create a calendar event"
   - "List each event with time, title, and attendees"
4. Add a **Plugin action** node:
   - Select the **Microsoft 365 Calendar** connector (Office 365 Outlook)
   - For check/search: use "Get events (V4)" or "Find meeting times (V2)"
   - For create: use "Create event (V4)"
5. Configure the response to format events as plain text (time, title, attendees)

## Step 3: Enable Generative AI Features

For best results with natural language prompts:

1. Go to **Settings** > **AI capabilities**
2. Enable **Generative answers** (allows CS to synthesize answers from search results)
3. Enable **Generative actions** (allows CS to dynamically select connectors)
4. Under "Generative orchestration", enable auto-selection of plugins

This is critical — generative orchestration allows CS to handle the varied prompt
formats that OpenClaw sends without requiring exact topic trigger phrase matches.
Without it, prompts like "Search my emails for: quarterly report" may fail to
match any topic.

## Step 4: Configure Authentication

1. In your agent, go to **Settings** > **Security** > **Authentication**
2. Select "Authenticate with Microsoft"
3. Ensure the token exchange URL and service provider are configured

### Azure AD App Registration

1. Go to Azure Portal > Azure Active Directory > App registrations
2. Create a new registration:
   - **Name**: "OpenClaw Copilot Studio"
   - **Supported account types**: Accounts in this organizational directory only
   - **Redirect URI**: Leave blank (device code flow)
3. Under **Authentication**:
   - Enable "Allow public client flows" (required for device code flow)
4. Under **API permissions**, add:
   - `https://api.powerplatform.com/CopilotStudio.Copilots.Invoke`
5. Note the **Application (client) ID** and **Directory (tenant) ID**

### How Authentication Works at Runtime

1. OpenClaw uses MSAL device code flow to get a Bearer token
2. On first use, an adaptive card with the device code and verification URL is
   sent to the user's channel (e.g. Teams)
3. The user visits `microsoft.com/devicelogin`, enters the code, and authenticates
4. Subsequent requests use the cached/refreshed token (no re-auth needed)
5. The Bearer token is sent in the `Authorization` header on every Direct Connect
   API call

## Step 5: Configure OpenClaw

Add the following to your OpenClaw config:

```yaml
plugins:
  copilot-studio:
    directConnectUrl: "https://your-region.api.powerplatform.com/copilotstudio/..."
    tenantId: "your-tenant-id"
    clientId: "your-client-id"
    agentMode: true # routes through Pi SDK pipeline

tools:
  web:
    search:
      provider: "copilot-studio"
  email:
    enabled: true
    provider: "copilot-studio"
  calendar:
    enabled: true
    provider: "copilot-studio"
```

## Step 6: Test the Integration

1. Start the OpenClaw gateway
2. Send a message — on first use, you will be prompted to authenticate via device code
3. After authenticating, test each tool:
   - Web search: "search the web for latest TypeScript features"
   - Email: send a `/copilot check my emails` message
   - Calendar: "what meetings do I have today?"

### Verifying CS Receives the Right Activities

Enable OpenClaw debug logging to see the exact activities being sent and received.
Look for log lines prefixed with `[copilot-studio]`:

```
[copilot-studio] query: Check my recent emails. List up to 5 with sender, subject...
[copilot-studio] startConversation: 200, conversationId=abc123...
[copilot-studio] sendMessage: 200, collecting response...
[copilot-studio] SSE: type=typing name=none stream=streaming text=Here are your recent...
[copilot-studio] SSE: type=message name=none stream=none text=Here are your recent emails...
[copilot-studio] result (342 chars, 2 activities, 0 cards): Here are your recent emails...
```

If you see `0 chars, 0 activities` in the result, the CS topic did not match or
returned empty. Check the CS analytics dashboard and verify trigger phrases.

## Troubleshooting

### Topic Not Matching (Empty Responses)

The most common issue. OpenClaw sends specific natural language prompts (see
"What Prompts OpenClaw Sends" above). If none of your CS topics match, CS
returns empty.

**Fix:**

- Enable "Generative orchestration" in CS settings (Step 3)
- Add the exact prompt prefixes as trigger phrases in your topics
- Check the CS **Analytics** > **Sessions** dashboard to see what prompts arrived
  and which topic (if any) was selected

### Consent Cards Keep Appearing

- CS returns adaptive card attachments when a connector needs user consent
- OpenClaw forwards these to the messaging channel
- The user must click "Allow" on the card in the channel UI
- After allowing, subsequent tool calls proceed without consent
- If consent keeps reappearing: verify the Outlook/Calendar connectors are
  configured with "Authenticate with Microsoft" in CS security settings

### Streaming vs Standalone Responses

CS may return responses in two modes:

- **Streaming**: Multiple `type: "typing"` activities followed by a final
  `type: "message"` with `entities: [{ type: "streaminfo", streamType: "final" }]`
- **Standalone**: A single `type: "message"` activity with no streaming metadata

Both work. OpenClaw handles both modes automatically.

### Authentication Errors

- Ensure "Allow public client flows" is enabled in the Azure AD app registration
- Verify the `scopes` in config match what is configured in Azure AD
  (default: `https://api.powerplatform.com/CopilotStudio.Copilots.Invoke`)
- Check that the tenant ID and client ID are correct
- If the device code card never appears, check that the adaptive card queue is
  working (look for `[copilot-studio] DeviceCodeRequiredError` in logs)

### Conversation Session Expired

Conversations expire after 30 minutes of inactivity. When expired, OpenClaw
starts a new conversation automatically (the system prompt is re-sent on the
first message of the new conversation). If you see `continueConversation failed,
starting new` in logs, this is normal behavior.

## Client Tool Calling (Agent Mode)

When CS runs in agent mode (`agentMode: true`), it acts as the AI model and needs
to execute tools on the local machine (read files, edit code, run commands). CS
cannot access the local filesystem directly, so it sends tool call requests as
**event activities** and OpenClaw executes them through its standard tool pipeline.

Event activities bypass CS's content safety filters, which block formatted text
that looks like shell commands or code. The tool definitions (names, parameters,
descriptions) are included in the system prompt that CS receives on the first
message of each conversation — the CS agent learns what tools exist from that prompt.

### Round-Trip Flow

```
1. User sends message to OpenClaw
2. OpenClaw forwards message to CS (system prompt included on first message)
3. CS agent decides to call a tool
4. CS redirects to "Client Tool" topic → topic sends event activity
5. OpenClaw receives the event, executes the tool (with approval, logging, sandbox)
6. OpenClaw sends result back to CS as an event activity
7. CS agent processes the result → more tool calls (back to step 4) or final text
```

### Event Names

All tool calls use a **single event name** (like `dataverse-operation-proposal`
in the PCF pattern). The tool name and arguments go inside the `value` object.

| Direction     | Event Name    | Purpose                                    |
| ------------- | ------------- | ------------------------------------------ |
| CS → OpenClaw | `tool-call`   | CS wants OpenClaw to execute a tool        |
| OpenClaw → CS | `tool-result` | OpenClaw returns the tool execution result |

### Event Format: `tool-call` (CS sends TO OpenClaw)

The Send activity node produces this on the wire:

```json
{
  "type": "event",
  "name": "tool-call",
  "replyToId": "<auto-set by CS>",
  "value": {
    "tool_name": "read",
    "arguments": {
      "path": "src/index.ts"
    }
  }
}
```

You only control `name` and `value` in the topic. CS auto-sets `type`,
`replyToId`, `conversation`, and `from`.

| Value Field | Required | Description                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| `tool_name` | Yes      | The tool name from the system prompt (e.g. `exec`, `read`, `edit`)                                  |
| `arguments` | Yes      | JSON object with the tool's parameters. Keys must match the parameter names from the system prompt. |

### Event Format: `tool-result` (OpenClaw sends BACK to CS)

After executing the tool, OpenClaw sends this back to the same conversation:

```json
{
  "type": "event",
  "name": "tool-result",
  "replyToId": "<auto-set replyToId from the tool-call>",
  "value": {
    "tool_name": "read",
    "result": "console.log('hello world');",
    "isError": false
  }
}
```

| Value Field | Description                                                           |
| ----------- | --------------------------------------------------------------------- |
| `tool_name` | Which tool produced this result                                       |
| `result`    | The text output (file contents, command output, search results, etc.) |
| `isError`   | `true` if the tool execution failed, `false` on success               |

### CS Topic Design: "Client Tool"

Create a single generic topic that handles all tool calls. The CS agent's
orchestration decides which tool to call and provides the inputs.

**Topic inputs** (set by the agent when it redirects to this topic):

| Input Variable   | Type   | Description                                            |
| ---------------- | ------ | ------------------------------------------------------ |
| `tool_name`      | String | Tool name from the system prompt (e.g. `read`, `exec`) |
| `tool_arguments` | String | JSON string of the tool's parameters                   |

#### Send Activity Node Configuration

- **Name** (string): `tool-call`
- **Value** (Power Fx): see below

The Send activity node gives you two fields: **Name** and **Value**. Name is
just the literal string `tool-call`. Value is where you build the JSON body
using Power Fx.

#### Power Fx for the Value Field

The `tool_arguments` input arrives as a JSON string from the agent (e.g.
`'{"path": "src/index.ts"}'`). You need to embed it as a parsed object inside
the value so it serializes as a proper JSON object on the wire, not as an
escaped string.

```powerfx
{
    tool_name: Topic.tool_name,
    arguments: ParseJSON(Topic.tool_arguments)
}
```

`ParseJSON()` turns the string into an untyped object. When the activity
serializes, `arguments` becomes a real JSON object:

```json
{ "tool_name": "read", "arguments": { "path": "src/index.ts" } }
```

Without `ParseJSON`, it would serialize as a string:

```json
{ "tool_name": "read", "arguments": "{\"path\": \"src/index.ts\"}" }
```

If `ParseJSON` is not available in your Power Fx context or causes issues,
an alternative is to build the entire value as a single JSON string and parse
the whole thing:

```powerfx
ParseJSON(
    "{""tool_name"": """ & Topic.tool_name & """, ""arguments"": " & Topic.tool_arguments & "}"
)
```

This concatenates the tool name and the already-valid JSON arguments string
into one JSON string, then parses it. The result is the same object.

**Full topic flow:**

1. **Trigger**: Agent orchestration redirects here with `tool_name` + `tool_arguments`
2. **Send activity** — Name: `tool-call`, Value: Power Fx above
3. **End topic** — The SSE response for this turn closes

OpenClaw receives the `tool-call` event, executes the tool, and sends the
`tool-result` event back. CS's orchestration agent sees the result on the
next turn and can call another tool or produce a final text response.

**Optional — explicit result handling (keeps the turn alive):**

If you want the topic to wait for the result and return it explicitly:

3. **Wait for event activity** — Event name = `tool-result`
4. **Parse value** — Parse `Activity.Value` to extract `result` and `isError`
5. **Set variable** — Store `Activity.Value.result` as topic output
6. **End topic** — Return the output variable to the orchestration agent

The "Wait for event" approach keeps the conversation turn alive until OpenClaw
sends the result back. Test both approaches (fire-and-forget vs wait) to see
which works better with your CS configuration.

### CS Agent System Message

Add this to your CS agent's **system message** (Settings > AI capabilities > How
should your copilot interact with people):

```
You are a coding agent connected to a local development environment through OpenClaw.
You can execute tools on the user's machine by redirecting to the "Client Tool" topic.

TOOL CALLING PROTOCOL:
- The first message in each conversation contains a system prompt listing all
  available tools with their names, descriptions, and parameter schemas.
- When you need to use a tool, redirect to the "Client Tool" topic with:
  - tool_name: the exact tool name from the system prompt (e.g. "read", "exec",
    "edit", "write", "find", "grep", "ls", "web_search")
  - tool_arguments: a JSON string with the parameters for that tool, using the
    parameter names from the system prompt
- The tool result will be returned to you as a "tool-result" event activity with:
  - value.tool_name: which tool produced the result
  - value.result: the text output from the tool
  - value.isError: true if the tool failed
- You may chain multiple tool calls. After receiving a result, you can redirect
  to "Client Tool" again for the next tool call.
- When you have completed the task, respond with a final text message summarizing
  what you did.

TOOL CALL EXAMPLES:
- To read a file: tool_name="read", tool_arguments='{"path": "src/index.ts"}'
- To run a command: tool_name="exec", tool_arguments='{"command": "npm test"}'
- To search for files: tool_name="find", tool_arguments='{"pattern": "*.ts"}'
- To edit a file: tool_name="edit", tool_arguments='{"path": "src/app.ts", "oldText": "bug", "newText": "fix"}'
- To search file contents: tool_name="grep", tool_arguments='{"pattern": "TODO", "path": "src/"}'

IMPORTANT:
- Always read a file before editing it.
- For exec, the command runs in a shell. Prefer short, focused commands.
- Tool parameter names and types are defined in the system prompt — refer to it
  for the full list and exact parameter schemas.
```

### Safety Limits

OpenClaw enforces a maximum of 20 tool round trips per conversation turn. If CS
enters an infinite tool call loop, the stream function stops and returns an error
message. This counter resets on each new user message.

### Debugging Tool Calls

Enable OpenClaw debug logging to trace the tool call flow. Look for these log
lines prefixed with `[copilot-studio]`:

```
[copilot-studio] tool event: tool-call value={"tool_name":"read","arguments":{"path":"src/index.ts"}}
[copilot-studio] sending tool result: read (1542 chars, isError=false)
[copilot-studio] tool event (continuation): tool-call value={"tool_name":"edit",...}
```

If you see `tool event:` but no `sending tool result:`, the tool execution is
pending approval (check exec approval prompts) or failed before producing output.

If you see no `tool event:` lines at all, CS is not sending event activities.
Check that:

- The "Client Tool" topic exists and the Send activity node uses the Power Fx above
- The CS agent system message instructs the agent to use the topic
- Generative orchestration is enabled so the agent can redirect to topics
