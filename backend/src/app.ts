import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import allocationRoutes from "./routes/allocations";
import attachmentRoutes from "./routes/attachments";
import attendanceRoutes from "./routes/attendance";
import attendanceRecordRoutes from "./routes/attendance-records";
import authRoutes from "./routes/auth";
import branchRoutes from "./routes/branches";
import bucketRoutes from "./routes/buckets";
import callLogRoutes from "./routes/call-logs";
import catalogRoutes from "./routes/catalog";
import companyRoutes from "./routes/companies";
import correctionRequestRoutes from "./routes/correction-requests";
import passwordResetRequestRoutes from "./routes/password-reset-requests";
import customerRoutes from "./routes/customers";
import dashboardPreferencesRoutes from "./routes/dashboard-preferences";
import dayPlanRoutes from "./routes/day-plan";
import dispositionRoutes from "./routes/dispositions";
import employeeRoutes from "./routes/employees";
import fieldConfigRoutes from "./routes/field-config";
import fieldVisitRoutes from "./routes/field-visits";
import healthRoutes from "./routes/health";
import importReviewRoutes from "./routes/import-reviews";
import importTemplateRoutes from "./routes/import-templates";
import importRoutes from "./routes/imports";
import locationRoutes from "./routes/location";
import paymentRoutes from "./routes/payments";
import ptpRoutes from "./routes/ptps";
import reallocationRequestRoutes from "./routes/reallocation-requests";
import reminderRoutes from "./routes/reminders";
import reportRoutes from "./routes/reports";
import setupStatusRoutes from "./routes/setup-status";
import targetRoutes from "./routes/targets";
import teamRoutes from "./routes/teams";
import trackingRoutes from "./routes/tracking";
import worklistRoutes from "./routes/worklist";

export function createApp() {
  const app = express();

  app.use(helmet());

  const allowedOrigins = env.CORS_ORIGIN?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins?.length) {
    app.use(cors({ origin: allowedOrigins }));
  } else {
    if (env.NODE_ENV === "production") {
      logger.warn(
        "CORS_ORIGIN is not set -- allowing requests from any origin. " +
          "Set CORS_ORIGIN to the web portal's URL(s) to restrict this.",
      );
    }
    app.use(cors());
  }

  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      // Access/refresh tokens (and, via req.body on error, login/employee
      // passwords) would otherwise flow into every request log line as-is.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.new_password',
          'req.body.otp',
          'req.body.refresh_token',
        ],
        censor: "[redacted]",
      },
    }),
  );

  app.use("/api", healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/branches", branchRoutes);
  app.use("/api/teams", teamRoutes);
  app.use("/api/companies", companyRoutes);
  app.use("/api/employees", employeeRoutes);
  app.use("/api/imports", importRoutes);
  app.use("/api/import-templates", importTemplateRoutes);
  app.use("/api/import-reviews", importReviewRoutes);
  app.use("/api/dispositions", dispositionRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/allocations", allocationRoutes);
  app.use("/api/call-logs", callLogRoutes);
  app.use("/api/worklist", worklistRoutes);
  app.use("/api/ptps", ptpRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/attendance", attendanceRoutes);
  app.use("/api/attendance-records", attendanceRecordRoutes);
  app.use("/api/location", locationRoutes);
  app.use("/api/tracking", trackingRoutes);
  app.use("/api/day-plan", dayPlanRoutes);
  app.use("/api/field-visits", fieldVisitRoutes);
  app.use("/api/attachments", attachmentRoutes);
  app.use("/api/reallocation-requests", reallocationRequestRoutes);
  app.use("/api/correction-requests", correctionRequestRoutes);
  app.use("/api/password-reset-requests", passwordResetRequestRoutes);
  app.use("/api/reminders", reminderRoutes);
  app.use("/api/buckets", bucketRoutes);
  app.use("/api/field-config", fieldConfigRoutes);
  app.use("/api/targets", targetRoutes);
  app.use("/api/reports", reportRoutes);
  app.use("/api/setup-status", setupStatusRoutes);
  app.use("/api/dashboard-preferences", dashboardPreferencesRoutes);
  app.use("/api", catalogRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
