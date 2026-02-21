import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

describe("EmbeddedBlockChunker", () => {
  it("breaks at paragraph boundary right after fence close", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 40,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro",
      "```js",
      "console.log('x')",
      "```",
      "",
      "After first line",
      "After second line",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toMatch(/```\n?$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("flushes paragraph boundaries before minChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n\nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("treats blank lines with whitespace as paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n \nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("falls back to maxChars when flushOnParagraph is set and no paragraph break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijKLMNOP");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["abcdefghij"]);
    expect(chunker.bufferedText).toBe("KLMNOP");
  });

  it("clamps long paragraphs to maxChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijk\n\nRest");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks).toEqual(["abcdefghij", "k"]);
    expect(chunker.bufferedText).toBe("Rest");
  });

  describe("sentence preference fallback chain", () => {
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

    it("sentence mode: never splits within bold headers or mid-phrase", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 300,
        maxChars: 800,
        breakPreference: "sentence",
      });

      chunker.append(EMAIL_CONTENT);

      const chunks: string[] = [];
      chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

      // Every chunk should end at a sentence boundary, not mid-word
      for (const chunk of chunks) {
        expect(chunk).not.toMatch(/\*\*\w+$/); // should not end mid-bold-header
        expect(chunk).not.toMatch(/^\w+\*\*/); // chunks should not start with partial bold
      }

      // Reassemble should produce original content (minus whitespace trimming)
      const reassembled = chunks.join("\n");
      expect(reassembled.replace(/\s+/g, " ")).toBe(EMAIL_CONTENT.replace(/\s+/g, " "));
    });

    it("sentence mode: breaks at sentence boundaries when available", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 300,
        maxChars: 800,
        breakPreference: "sentence",
      });

      chunker.append(EMAIL_CONTENT);

      const chunks: string[] = [];
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

      // Should find sentence breaks (periods) rather than arbitrary whitespace
      for (let i = 0; i < chunks.length; i++) {
        const trimmed = chunks[i].trimEnd();
        // Non-final chunks should end with sentence punctuation
        if (i < chunks.length - 1) {
          expect(trimmed).toMatch(/[.!?]$/);
        }
      }
    });

    it("sentence mode with token-by-token streaming finds sentence breaks", () => {
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

      // No chunk should break inside "**Zoom Access**"
      for (const chunk of chunks) {
        expect(chunk).not.toMatch(/\*\*Zoom$/);
        expect(chunk).not.toMatch(/^Access\*\*/);
      }
    });

    it("paragraph mode with same content breaks at paragraph boundaries", () => {
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

      // Should never split inside bold headers
      for (const chunk of chunks) {
        expect(chunk).not.toMatch(/\*\*\w+$/);
        expect(chunk).not.toMatch(/^\w+\*\*/);
      }
    });
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    const text = [
      "Intro",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After fence",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(chunker.bufferedText).toBe("After fence");
  });
});
