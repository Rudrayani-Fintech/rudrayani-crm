import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import { env } from "../config/env";
import { HttpError } from "./error-handler";
import { capabilitiesOf, type UserRow } from "../types/user";
import { capabilitiesHavePermission } from "../services/permission-service";
import { asyncHandler } from "./async-handler";

/**
 * Verifies the Bearer access token and loads the user fresh from the DB so
 * deactivation / capability changes take effect immediately, not at token expiry.
 */
export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Missing access token");

    let payload: jwt.JwtPayload;
    try {
      // Pin the algorithm explicitly -- without this, jsonwebtoken accepts
      // whatever alg the token header claims, which (depending on library
      // version/config) can include unsigned "none" tokens or let an
      // attacker who knows the JWT_SECRET is HMAC swap in an RS256 token
      // verified against the secret-as-public-key. Tokens are always
      // signed HS256 by signAccessToken() in auth-service.ts.
      payload = jwt.verify(header.slice("Bearer ".length), env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, "Invalid or expired access token");
    }

    const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub]);
    const user = rows[0];
    if (!user || !user.is_active) throw new HttpError(401, "Account not found or deactivated");

    req.user = user;
    next();
  },
);

/**
 * Permission guard on top of authenticate. Permissions come from the
 * capability_permissions table (data, not code — build brief Section 3).
 */
export function requirePermission(permissionKey: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) throw new HttpError(401, "Not authenticated");

    const allowed = await capabilitiesHavePermission(capabilitiesOf(user), permissionKey);
    if (!allowed) {
      throw new HttpError(403, `Missing permission: ${permissionKey}`);
    }
    next();
  });
}

/** Passes when the user holds ANY of the given permissions (e.g. full vs self-scoped reports). */
export function requireAnyPermission(...permissionKeys: string[]) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) throw new HttpError(401, "Not authenticated");

    for (const key of permissionKeys) {
      if (await capabilitiesHavePermission(capabilitiesOf(user), key)) return next();
    }
    throw new HttpError(403, `Missing permission: ${permissionKeys.join(" or ")}`);
  });
}
