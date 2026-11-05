import type { Logger } from "../../log/index.ts";
import type { TdClient } from "./client.ts";
import { TdClosedError, TdError } from "./errors.ts";
import type { TdObject } from "./ffi.ts";

// Answers for an interactive user login. Values are passed straight to TDLib and never logged
export interface AuthPrompter {
  phoneNumber(): Promise<string>;
  code(info: { phoneNumber: string; codeType: string }): Promise<string>;
  password(hint: string): Promise<string>;
  emailAddress(): Promise<string>;
  emailCode(): Promise<string>;
  // A rejected answer (wrong code, bad number); the prompt for the same step comes next
  rejected(error: TdError): void;
}

export type Credentials =
  | { kind: "bot"; token: string }
  // Without a prompter, only an existing session can authorize
  | { kind: "user"; prompter?: AuthPrompter };

// The user account has no session and nobody to ask
export class AuthorizationRequiredError extends Error {
  override readonly name = "AuthorizationRequiredError";
}

// Errors on these codes come from the answer itself, so asking again makes sense
const RETRYABLE_ANSWER_CODES = new Set([400]);

// Drives the authorization state machine until authorizationStateReady
export async function authorize(
  client: TdClient,
  parameters: TdObject,
  credentials: Credentials,
  log: Logger,
): Promise<void> {
  const prompter = credentials.kind === "user" ? credentials.prompter : undefined;
  let lastLogged: string | undefined;

  for (;;) {
    const version = client.authorizationVersion;
    const state = client.authorizationState;
    if (!client.isOpen) throw new TdClosedError("Client closed during authorization");
    if (!state) {
      await client.waitForAuthorizationChange(version);
      continue;
    }

    const type = state["@type"];
    if (type !== lastLogged) {
      log.debug("Authorization state {state}", { state: type });
      lastLogged = type;
    }

    // Each case either returns, throws, or produces the request that answers the state
    let request: TdObject;
    // Whether a 400 means "ask again" rather than a configuration error
    let fromPrompt = false;
    switch (type) {
      case "authorizationStateReady":
        return;
      case "authorizationStateWaitTdlibParameters":
        request = parameters;
        break;
      case "authorizationStateWaitPhoneNumber":
        if (credentials.kind === "bot") {
          request = { "@type": "checkAuthenticationBotToken", token: credentials.token };
          break;
        }
        request = {
          "@type": "setAuthenticationPhoneNumber",
          phone_number: (await requirePrompter(prompter).phoneNumber()).trim(),
        };
        fromPrompt = true;
        break;
      case "authorizationStateWaitCode": {
        const info = state.code_info as TdObject;
        const code = await requirePrompter(prompter).code({
          phoneNumber: String(info.phone_number ?? ""),
          codeType: String((info.type as TdObject | undefined)?.["@type"] ?? "unknown"),
        });
        request = { "@type": "checkAuthenticationCode", code: code.trim() };
        fromPrompt = true;
        break;
      }
      case "authorizationStateWaitPassword":
        request = {
          "@type": "checkAuthenticationPassword",
          password: await requirePrompter(prompter).password(String(state.password_hint ?? "")),
        };
        fromPrompt = true;
        break;
      case "authorizationStateWaitEmailAddress":
        request = {
          "@type": "setAuthenticationEmailAddress",
          email_address: (await requirePrompter(prompter).emailAddress()).trim(),
        };
        fromPrompt = true;
        break;
      case "authorizationStateWaitEmailCode":
        request = {
          "@type": "checkAuthenticationEmailCode",
          code: {
            "@type": "emailAddressAuthenticationCode",
            code: (await requirePrompter(prompter).emailCode()).trim(),
          },
        };
        fromPrompt = true;
        break;
      case "authorizationStateWaitRegistration":
        throw new Error("This phone number has no Telegram account; sign up in an official app first");
      case "authorizationStateWaitOtherDeviceConfirmation":
      case "authorizationStateWaitPremiumPurchase":
        throw new Error(`Unsupported authorization step: ${type}`);
      case "authorizationStateLoggingOut":
      case "authorizationStateClosing":
      case "authorizationStateClosed":
        throw new TdClosedError(`Client is ${type} during authorization`);
      default:
        throw new Error(`Unknown authorization state: ${type}`);
    }

    try {
      await client.invoke(request);
    } catch (error) {
      if (fromPrompt && prompter && error instanceof TdError && RETRYABLE_ANSWER_CODES.has(error.code)) {
        prompter.rejected(error);
        continue;
      }
      throw error;
    }
    await client.waitForAuthorizationChange(version);
  }
}

function requirePrompter(prompter: AuthPrompter | undefined): AuthPrompter {
  if (!prompter) {
    throw new AuthorizationRequiredError("The user account is not logged in; run `bun run login` first");
  }
  return prompter;
}
