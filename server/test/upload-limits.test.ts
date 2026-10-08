import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UploadResumeRequest } from "@crm/shared";
import { MAX_RESUME_BASE64_CHARS, MAX_RESUME_BYTES } from "@crm/shared/constants";

/**
 * The upload had no ceiling at all. A scanned CV arrives base64-encoded inside
 * a JSON body, is decoded into a Buffer, and is then walked page by page by
 * pdf.js — all of it in the proxy's heap at once, on the same process that
 * serves the side panel. One large file took everything down.
 */
describe("UploadResumeRequest.fileBase64", () => {
  const base = {
    jobId: "00000000-0000-4000-8000-000000000000",
    fileName: "cv.pdf",
  };

  it("accepts a resume of a realistic size", () => {
    // Typical resumes are well under 1MB; this is an order of magnitude more.
    const body = { ...base, fileBase64: "A".repeat(1_000_000) };
    assert.equal(UploadResumeRequest.parse(body).fileBase64.length, 1_000_000);
  });

  it("accepts a file exactly at the ceiling", () => {
    const body = { ...base, fileBase64: "A".repeat(MAX_RESUME_BASE64_CHARS) };
    assert.doesNotThrow(() => UploadResumeRequest.parse(body));
  });

  it("rejects one character past it", () => {
    const body = { ...base, fileBase64: "A".repeat(MAX_RESUME_BASE64_CHARS + 1) };
    assert.throws(() => UploadResumeRequest.parse(body), /under 10MB/);
  });

  it("still rejects an empty body, which is a failed read rather than a file", () => {
    assert.throws(() => UploadResumeRequest.parse({ ...base, fileBase64: "" }));
  });

  it("states the character ceiling as base64's 4-per-3 expansion of the byte one", () => {
    // The extension checks `file.size` in bytes before encoding; the contract
    // checks the encoded string. They have to describe the same limit, or a
    // file passes one and fails the other with no explanation.
    assert.equal(MAX_RESUME_BASE64_CHARS, Math.ceil(MAX_RESUME_BYTES / 3) * 4);
    assert.ok(MAX_RESUME_BASE64_CHARS > MAX_RESUME_BYTES);
  });
});
