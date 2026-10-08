import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELIVERY_WINDOW_MS,
  type DeliveryTarget,
  NOTHING_DELIVERED,
  UploadResumeRequest,
  acceptsDelivery,
  documentRank,
} from "@crm/shared";

/**
 * Which application an uploaded file is filed against.
 *
 * On 2026-10-01 three consecutive applications each received the *following*
 * one's tailored CV and the last received none, because a tracked job went on
 * claiming freshly picked files for two hours with nothing marking it as
 * already satisfied. The replay below is the shape of that incident, measured
 * from the real timestamps.
 */

const NOW = 1_759_000_000_000;
const untouched = (jobId: string, at: number): DeliveryTarget => ({
  jobId,
  at,
  deliveredRank: NOTHING_DELIVERED,
});

describe("documentRank", () => {
  it("prefers an explicit resume over an explicit cover letter", () => {
    assert.ok(documentRank("Arjun_Resume.pdf") > documentRank("Arjun_Cover_Letter.pdf"));
  });

  it("keeps an unrecognised name usable, between the two", () => {
    const plain = documentRank("Arjun_Nair.pdf");
    assert.ok(plain > documentRank("cover-letter.pdf"));
    assert.ok(plain < documentRank("Arjun_CV.pdf"));
  });

  /**
   * `\b` treats `_` as a word character, so the underscore-separated names that
   * every exported CV actually uses — including the vault's own
   * `<Name>_<Company>_<Role>.pdf` — all scored as unrecognised, and a cover
   * letter attached second could still displace the resume.
   */
  it("reads underscore-separated names, not just spaced ones", () => {
    const resume = documentRank("Arjun_Resume.pdf");
    assert.equal(documentRank("Arjun_Nair_Resume_ClearwaterLabs.pdf"), resume);
    assert.equal(documentRank("Arjun_CV.pdf"), resume);
    assert.equal(documentRank("Arjun Nair Resume.pdf"), resume);
    assert.ok(resume > documentRank("Arjun_Nair_Cover_Letter.pdf"));
  });

  it("does not see a resume inside an ordinary word", () => {
    assert.equal(documentRank("precvetkov.pdf"), documentRank("Arjun_Nair.pdf"));
  });
});

describe("acceptsDelivery", () => {
  it("files the first resume against the application just tracked", () => {
    assert.equal(acceptsDelivery(untouched("job-a", NOW), "CV.pdf", NOW + 6_000), true);
  });

  it("refuses when there is no tracked application at all", () => {
    assert.equal(acceptsDelivery(undefined, "CV.pdf", NOW), false);
  });

  /**
   * The exact failure. Trellis Digital was tracked at 02:52 and the Cedar Union CRM CV
   * was picked at 03:13, 21 minutes later and one second before Cedar Union itself
   * was tracked. The old rule accepted it because the window was two hours.
   */
  it("refuses a file picked long after the previous application was tracked", () => {
    const tm = untouched("tech-mahindra", NOW);
    assert.equal(acceptsDelivery(tm, "Arjun_CV.pdf", NOW + 21 * 60_000), false);
  });

  it("refuses a second resume for an application that already has one", () => {
    const filled: DeliveryTarget = { jobId: "job-a", at: NOW, deliveredRank: documentRank("CV.pdf") };
    assert.equal(acceptsDelivery(filled, "Arjun_Resume.pdf", NOW + 30_000), false);
  });

  /**
   * The one case a flat "once only" rule would break: an ATS that asks for the
   * cover letter first still has to end up holding the CV.
   */
  it("still accepts a resume after a cover letter was filed", () => {
    const withCoverLetter: DeliveryTarget = {
      jobId: "job-a",
      at: NOW,
      deliveredRank: documentRank("Cover_Letter.pdf"),
    };
    assert.equal(acceptsDelivery(withCoverLetter, "Arjun_CV.pdf", NOW + 30_000), true);
  });

  it("accepts right up to the window and not past it", () => {
    const target = untouched("job-a", NOW);
    assert.equal(acceptsDelivery(target, "CV.pdf", NOW + DELIVERY_WINDOW_MS), true);
    assert.equal(acceptsDelivery(target, "CV.pdf", NOW + DELIVERY_WINDOW_MS + 1), false);
  });
});

describe("UploadResumeRequest.replace", () => {
  const base = {
    jobId: "11111111-1111-4111-8111-111111111111",
    fileName: "CV.pdf",
    fileBase64: "QQ==",
  };

  it("defaults to absent, so the server refuses to overwrite", () => {
    assert.equal(UploadResumeRequest.parse(base).replace, undefined);
  });

  it("carries an explicit replacement through", () => {
    assert.equal(UploadResumeRequest.parse({ ...base, replace: true }).replace, true);
  });
});
