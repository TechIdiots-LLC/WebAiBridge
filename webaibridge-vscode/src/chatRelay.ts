import * as vscode from "vscode";
import * as crypto from "crypto";

// Relays VS Code chat requests to an AI chat site open in the browser. The
// Chrome extension types the prompt into the page, reads the reply as it
// renders, and sends it back over the bridge WebSocket.
//
// Messages to the browser:
//   CHAT_REQUEST { requestId, site, conversationKey, newConversation, text }
//   CHAT_CANCEL  { requestId }
// Messages from the browser:
//   CHAT_STARTED { requestId }
//   CHAT_CHUNK   { requestId, text }   full reply text so far
//   CHAT_DONE    { requestId, text }   full final reply text
//   CHAT_ERROR   { requestId, message }

export const CHAT_VENDOR = "webaibridge";

// Give up if the browser never acknowledges a request, or goes quiet midway.
const START_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 120000;

export interface RelayTransport {
  hasClients(): boolean;
  send(message: unknown): void;
}

interface WebChatModel extends vscode.LanguageModelChatInformation {
  readonly site: string;
}

const MODELS: WebChatModel[] = [
  {
    id: "gemini-web",
    name: "Gemini (web)",
    family: "gemini",
    version: "1.0",
    detail: "via browser",
    tooltip:
      "Sends the conversation to gemini.google.com in Chrome through the WebAiBridge extension.",
    maxInputTokens: 900000,
    maxOutputTokens: 60000,
    capabilities: { toolCalling: false },
    site: "gemini",
  },
  {
    id: "claude-web",
    name: "Claude (web, experimental)",
    family: "claude",
    version: "1.0",
    detail: "via browser",
    tooltip:
      "Sends the conversation to claude.ai in Chrome through the WebAiBridge extension.",
    maxInputTokens: 180000,
    maxOutputTokens: 32000,
    capabilities: { toolCalling: false },
    site: "claude",
  },
];

interface PendingRequest {
  onText(fullText: string): void;
  finish(fullText: string): void;
  fail(error: Error): void;
  started: boolean;
  touch(): void;
}

function partsToText(content: ReadonlyArray<unknown>): string {
  return content
    .map((part) =>
      part instanceof vscode.LanguageModelTextPart ? part.value : "",
    )
    .join("");
}

export class WebChatProvider implements vscode.LanguageModelChatProvider<WebChatModel> {
  private pending = new Map<string, PendingRequest>();

  constructor(private transport: RelayTransport) {}

  provideLanguageModelChatInformation(): WebChatModel[] {
    return MODELS;
  }

  provideTokenCount(
    _model: WebChatModel,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const s = typeof text === "string" ? text : partsToText(text.content);
    return Promise.resolve(Math.ceil(s.length / 4));
  }

  async provideLanguageModelChatResponse(
    model: WebChatModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (!this.transport.hasClients()) {
      throw new Error(
        "No browser is connected to WebAiBridge. Install the Chrome extension and open " +
          `${model.site === "gemini" ? "gemini.google.com" : "claude.ai"}.`,
      );
    }

    const turns = messages
      .map((m) => ({
        role: m.role,
        text: partsToText(m.content).trim(),
      }))
      .filter((m) => m.text.length > 0);
    const userTurns = turns.filter(
      (t) => t.role === vscode.LanguageModelChatMessageRole.User,
    );
    if (userTurns.length === 0) {
      throw new Error("The request has no user message to send.");
    }

    // The web chat keeps its own history, so the first turn sends the whole
    // request and later turns send only the newest message. A conversation is
    // identified by its first user message.
    const newConversation = userTurns.length === 1;
    const text = newConversation
      ? turns
          .map((t) =>
            t.role === vscode.LanguageModelChatMessageRole.User
              ? t.text
              : `Assistant: ${t.text}`,
          )
          .join("\n\n")
      : userTurns[userTurns.length - 1].text;
    const conversationKey = crypto
      .createHash("sha1")
      .update(model.site + "\n" + userTurns[0].text)
      .digest("hex");

    const requestId = crypto.randomUUID();
    let emitted = "";

    await new Promise<void>((resolve, reject) => {
      let startTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (startTimer) clearTimeout(startTimer);
        if (idleTimer) clearTimeout(idleTimer);
        this.pending.delete(requestId);
        cancelSub.dispose();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => fail(new Error("The browser stopped responding.")),
          IDLE_TIMEOUT_MS,
        );
      };
      // Reply text is read from the page, which can re-render earlier text
      // while streaming. Only ever append to what was already shown.
      const emitUpTo = (fullText: string, final: boolean) => {
        if (fullText.startsWith(emitted)) {
          const delta = fullText.slice(emitted.length);
          if (delta) {
            progress.report(new vscode.LanguageModelTextPart(delta));
            emitted = fullText;
          }
        } else if (final) {
          let p = 0;
          while (p < emitted.length && emitted[p] === fullText[p]) p++;
          const delta = fullText.slice(p);
          if (delta) {
            progress.report(new vscode.LanguageModelTextPart(delta));
          }
          emitted = fullText;
        }
      };

      const cancelSub = token.onCancellationRequested(() => {
        this.transport.send({ type: "CHAT_CANCEL", requestId });
        cleanup();
        resolve();
      });

      this.pending.set(requestId, {
        started: false,
        touch: armIdle,
        onText: (fullText) => {
          armIdle();
          emitUpTo(fullText, false);
        },
        finish: (fullText) => {
          emitUpTo(fullText, true);
          cleanup();
          resolve();
        },
        fail,
      });

      startTimer = setTimeout(() => {
        if (!this.pending.get(requestId)?.started) {
          fail(
            new Error(
              `No ${model.site} tab answered. Open the site in Chrome with the WebAiBridge extension enabled, and reload the tab if it was open before installing.`,
            ),
          );
        }
      }, START_TIMEOUT_MS);
      armIdle();

      this.transport.send({
        type: "CHAT_REQUEST",
        requestId,
        site: model.site,
        conversationKey,
        newConversation,
        text,
      });
    });
  }

  // Called for every CHAT_* message the browser sends.
  handleMessage(data: {
    type: string;
    requestId?: string;
    text?: string;
    message?: string;
  }) {
    const req = data.requestId ? this.pending.get(data.requestId) : undefined;
    if (!req) return;
    switch (data.type) {
      case "CHAT_STARTED":
        req.started = true;
        req.touch();
        break;
      case "CHAT_CHUNK":
        req.started = true;
        req.onText(data.text ?? "");
        break;
      case "CHAT_DONE":
        req.finish(data.text ?? "");
        break;
      case "CHAT_ERROR":
        req.fail(new Error(data.message || "The browser reported an error."));
        break;
    }
  }
}
