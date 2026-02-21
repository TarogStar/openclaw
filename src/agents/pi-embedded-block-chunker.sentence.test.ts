import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

describe("EmbeddedBlockChunker sentence preference", () => {
  // Reproduces actual Teams email summary output where the chunker broke
  // between "**Zoom" and "Access**" instead of at a nearby sentence boundary.
  const EMAIL_CONTENT = [
    "Here's a concise summary of your top 5 unread emails:",
    "",
    "**LinkedIn Update**",
    "From: updates-noreply@linkedin.com",
    "Subject: Steve Johnson posted: I was very impressed with Dr. West's story...",
    "Summary: Insightful comment on a story shared at GIS-Pro event.",
    "**Job Alert**",
    "From: jobs-noreply@linkedin.com",
    "Subject: New Principal Software Architect jobs matching your profile",
    "Summary: Opportunities for senior tech roles.",
    "**Zoom Access**",
    "From: michael.moosman@gmail.com",
    "Subject: New Zoom Account for Riverview Ward",
    "Summary: Credentials provided for ward meetings; requires forwarding to relevant parties.",
    "**FamilySearch Notice**",
    "From: reply@e.familysearch.org",
    "Subject: Temple ordinance available in your family tree",
    "Summary: Available for a relative in your family records.",
    "**TechCon Reminder**",
    "From: events@techcon365.com",
    "Subject: LAST CHANCE for Super Early Bird registration",
    "Summary: Workshops underway with limited early-bird benefits.",
    "Would you like details or actions on any of these?",
  ].join("\n");

  it("bulk append: sentence mode finds sentence breaks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "sentence",
    });

    chunker.append(EMAIL_CONTENT);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    console.log("=== BULK APPEND CHUNKS ===");
    for (let i = 0; i < chunks.length; i++) {
      console.log(`--- Chunk ${i} (${chunks[i].length} chars) ---`);
      console.log(chunks[i]);
    }

    // No chunk should split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*\w+$/); // ends mid-bold
      expect(chunk).not.toMatch(/^\w+\*\*/); // starts mid-bold
    }
  });

  it("token-by-token streaming: sentence mode finds sentence breaks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "sentence",
    });

    // Simulate streaming: append one character at a time, drain after each
    const chunks: string[] = [];
    for (const char of EMAIL_CONTENT) {
      chunker.append(char);
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    }
    // Force flush remaining
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    console.log("\n=== TOKEN-BY-TOKEN CHUNKS ===");
    for (let i = 0; i < chunks.length; i++) {
      console.log(`--- Chunk ${i} (${chunks[i].length} chars) ---`);
      console.log(chunks[i]);
    }

    // No chunk should split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*Zoom$/);
      expect(chunk).not.toMatch(/^Access\*\*/);
      expect(chunk).not.toMatch(/\*\*\w+$/);
      expect(chunk).not.toMatch(/^\w+\*\*/);
    }
  });

  it("token-by-token: paragraph mode for comparison", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "paragraph",
    });

    const chunks: string[] = [];
    for (const char of EMAIL_CONTENT) {
      chunker.append(char);
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    }
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    console.log("\n=== PARAGRAPH MODE CHUNKS ===");
    for (let i = 0; i < chunks.length; i++) {
      console.log(`--- Chunk ${i} (${chunks[i].length} chars) ---`);
      console.log(chunks[i]);
    }

    // Should never split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*\w+$/);
      expect(chunk).not.toMatch(/^\w+\*\*/);
    }
  });
});
