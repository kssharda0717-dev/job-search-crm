import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CaptureContactRequest,
  MAX_PROFILE_TEXT_CHARS,
  capProfileText,
  condenseProfile,
  dedupeAdjacent,
} from "@crm/shared";

/**
 * The recipient's profile is the input that decides which resume bullet a draft
 * is built from, so the shape it arrives in is not cosmetic. These are the three
 * things that can go wrong before it reaches retrieval: LinkedIn's duplication,
 * an unbounded blob, and a profile that had nothing readable on it.
 */

describe("dedupeAdjacent", () => {
  it("collapses LinkedIn's screen-reader duplication", () => {
    // Every visible string on a profile is rendered twice — once aria-hidden,
    // once in a visually-hidden span clipped by CSS rather than display:none —
    // so innerText returns both copies.
    assert.deepEqual(
      dedupeAdjacent(["Senior Recruiter", "Senior Recruiter", "Verdant", "Verdant"]),
      ["Senior Recruiter", "Verdant"],
    );
  });

  it("keeps a repeat that is not adjacent, because a career repeats employers", () => {
    // Three roles at one company is the progression that makes the text worth
    // having; dropping every later occurrence would erase it.
    assert.deepEqual(
      dedupeAdjacent(["Director — Verdant", "Manager — Verdant", "Analyst — Verdant"]),
      ["Director — Verdant", "Manager — Verdant", "Analyst — Verdant"],
    );
  });

  it("normalises whitespace and drops blank lines", () => {
    assert.deepEqual(dedupeAdjacent(["  HR   Lead \n", "", "   ", "HR Lead"]), ["HR Lead"]);
  });
});

describe("capProfileText", () => {
  it("leaves a profile under the ceiling alone", () => {
    assert.equal(capProfileText("About: payroll"), "About: payroll");
  });

  it("cuts on a line boundary rather than mid-sentence", () => {
    // A half-sentence about the recipient is exactly the kind of thing that
    // gets confidently completed into something the profile never said.
    const text = ["aaaa", "bbbb", "cccc"].join("\n");
    assert.equal(capProfileText(text, 11), "aaaa\nbbbb");
  });

  it("hard-slices a single line longer than the whole budget", () => {
    // The one case with no boundary to cut on. Returning nothing would be worse.
    assert.equal(capProfileText("abcdefghij", 4), "abcd");
  });
});

describe("condenseProfile", () => {
  it("labels the sections so a self-description is not read as a job history", () => {
    const text = condenseProfile({
      about: "I run payroll for 4,000 people.",
      experience: ["HR Manager — Verdant", "HR Analyst — Verdant"],
      skills: ["Oracle HCM", "Payroll"],
    });

    assert.equal(
      text,
      "About: I run payroll for 4,000 people.\n" +
        "Experience: HR Manager — Verdant; HR Analyst — Verdant\n" +
        "Skills: Oracle HCM, Payroll",
    );
  });

  it("omits a section that was not on the page rather than emitting an empty label", () => {
    assert.equal(
      condenseProfile({ about: null, experience: ["Recruiter — Acme"], skills: [] }),
      "Experience: Recruiter — Acme",
    );
  });

  it("returns null when nothing was readable, not an empty string", () => {
    // "" and "we never looked" must not be the same value in the database: the
    // panel prompts the user to open the profile on one and not the other.
    assert.equal(condenseProfile({ about: "   ", experience: [], skills: [] }), null);
  });

  it("caps its own output, so no single profile can blow the prompt budget", () => {
    const text = condenseProfile({
      about: null,
      experience: Array.from({ length: 500 }, (_, i) => `Role ${i} — Company ${i}`),
      skills: [],
    });
    assert.ok(text);
    assert.ok(text.length <= MAX_PROFILE_TEXT_CHARS);
  });
});

describe("CaptureContactRequest.profileText", () => {
  const base = { name: "Mira", linkedinUrl: "https://www.linkedin.com/in/mira/" };

  it("accepts a profile at the ceiling", () => {
    const body = { ...base, profileText: "a".repeat(MAX_PROFILE_TEXT_CHARS) };
    assert.doesNotThrow(() => CaptureContactRequest.parse(body));
  });

  it("rejects one character past it", () => {
    // The content script is not a trusted writer; the ceiling is a contract,
    // not a formatting preference.
    const body = { ...base, profileText: "a".repeat(MAX_PROFILE_TEXT_CHARS + 1) };
    assert.throws(() => CaptureContactRequest.parse(body));
  });

  it("stays optional, because a people card has no profile to read", () => {
    assert.equal(CaptureContactRequest.parse(base).profileText, undefined);
  });
});
