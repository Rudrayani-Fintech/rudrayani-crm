import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/async-handler";
import { authenticate } from "../middleware/authenticate";
import { loginRateLimiter, otpRequestRateLimiter } from "../middleware/rate-limit";
import * as authService from "../services/auth-service";
import { permissionsFor } from "../services/permission-service";
import { capabilitiesOf, publicUser } from "../types/user";

const router = Router();

const phoneSchema = z.string().min(8).max(15).regex(/^\d+$/, "Phone must be digits only");
const passwordSchema = z.string().min(8, "Password must be at least 8 characters");

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1),
  device_id: z.string().min(1).max(200).optional(),
});

router.post(
  "/login",
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json(await authService.login(body.phone, body.password, body.device_id));
  }),
);

const refreshSchema = z.object({ refresh_token: z.string().min(1) });

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const body = refreshSchema.parse(req.body);
    res.json(await authService.refresh(body.refresh_token));
  }),
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const body = refreshSchema.parse(req.body);
    await authService.logout(body.refresh_token);
    res.json({ ok: true });
  }),
);

const otpRequestSchema = z.object({ phone: phoneSchema });

router.post(
  "/otp/request",
  otpRequestRateLimiter,
  asyncHandler(async (req, res) => {
    const body = otpRequestSchema.parse(req.body);
    const result = await authService.requestPasswordOtp(body.phone);
    // Deliberately identical response whether or not the phone exists.
    res.json({ ok: true, message: "If the number is registered, an OTP has been sent.", ...result });
  }),
);

const otpVerifySchema = z.object({
  phone: phoneSchema,
  otp: z.string().length(6),
  new_password: passwordSchema,
});

router.post(
  "/otp/verify",
  asyncHandler(async (req, res) => {
    const body = otpVerifySchema.parse(req.body);
    await authService.resetPasswordWithOtp(body.phone, body.otp, body.new_password);
    res.json({ ok: true, message: "Password reset. Log in with your new password." });
  }),
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const permissions = await permissionsFor(capabilitiesOf(user));
    res.json({ user: publicUser(user), permissions });
  }),
);

export default router;
