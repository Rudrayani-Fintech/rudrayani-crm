import { env } from "../../config/env";
import { logger } from "../../config/logger";

/**
 * SMS gateway abstraction (build brief Section 10). The real provider
 * (MSG91 / Twilio / ...) is decided closer to production; swapping it in
 * means adding one class here and changing getSmsProvider() — nothing else.
 *
 * getSmsProvider() currently always returns ConsoleSmsProvider, including in
 * production -- no real provider is wired up yet. That means in production
 * today: OTP-based password reset never reaches anyone, and a new
 * employee's initial password sent via employees.ts is never delivered
 * either. This needs a real SmsProvider implementation (choose a vendor,
 * add credentials, add a class here, branch on it in getSmsProvider()
 * below) before either flow works end to end in production.
 */
export interface SmsProvider {
  sendSms(phone: string, message: string): Promise<void>;
}

/** Dev stub: "sends" the SMS by logging it. */
export class ConsoleSmsProvider implements SmsProvider {
  async sendSms(phone: string, message: string): Promise<void> {
    if (env.NODE_ENV === "production") {
      // No real provider is configured, so this message was never actually
      // delivered. Logging the body here previously put OTPs and initial
      // employee passwords in plaintext into production logs -- log only
      // that a send was attempted (still visible as an operational gap)
      // and never the message content.
      logger.error(
        { phone },
        "[ConsoleSmsProvider] No real SMS provider configured — message NOT sent. " +
          "OTP/password delivery is broken in production until a real SmsProvider is wired up.",
      );
      return;
    }
    logger.info({ phone, message }, "[ConsoleSmsProvider] SMS (dev stub — not actually sent)");
  }
}

let provider: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (!provider) {
    provider = new ConsoleSmsProvider();
  }
  return provider;
}
