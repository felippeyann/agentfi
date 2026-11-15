-- Migration: 0028_x402_resource_truncated
-- Purpose: delivery evidence (PR #198 review): "resourceTruncated" = the paid body
--   exceeded the read limit and only a prefix arrived (transfer aborted). With
--   0028 "resourceSha256" / "resourceBytes" describe the received BYTES, before
--   UTF-8 decoding. NULL on rows written before it.

ALTER TABLE "ResourcePayment" ADD COLUMN "resourceTruncated" BOOLEAN;
