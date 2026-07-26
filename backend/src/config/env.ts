import "dotenv/config";
import { z } from "zod";

// All configuration enters the app through this single validated object.
// A missing/invalid variable fails fast at boot instead of surfacing later
// as an undefined somewhere deep in a request handler.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("8h"),
  SMS_PROVIDER_API_KEY: z.string().default(""),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().int().positive().default(15),
  OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  UPLOAD_DIR: z.string().default("uploads"),

  // Comma-separated list of allowed origins for the web portal (e.g.
  // "https://app.rudrayanifintechs.com"). Unset = every origin is allowed,
  // which is what this API ran with for a long time -- kept as the default
  // so deploying this change can't itself lock out the live portal, but a
  // startup warning nudges the operator to set this in production.
  CORS_ORIGIN: z.string().optional(),

  // Returns the password-reset OTP in the /auth/otp/request response body
  // (for local testing without a real SMS provider). Previously gated on
  // `NODE_ENV !== "production"` -- one misconfigured/misspelled NODE_ENV
  // value (e.g. "staging") silently turned this on. Explicit opt-in,
  // defaulting to off regardless of NODE_ENV.
  ALLOW_OTP_ECHO: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Optional S3-compatible storage (e.g. Cloudflare R2). When all four are
  // set, getStorage() uses it instead of local disk -- needed on hosts that
  // don't persist local disk across deploys/restarts (Render, Fly, Vercel).
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
