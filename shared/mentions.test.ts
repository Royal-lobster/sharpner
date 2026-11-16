import { describe, expect, it } from "vitest";
import { insertMention, MAX_MENTIONS, mentionQuery, mentionSegments, mentionSuggestions, mentionsIn } from "./mentions";

const ada = { id: "ada", name: "Ada Lovelace", avatar: null };
const al = { id: "al", name: "Al", avatar: null };
const grace = { id: "grace", name: "Grace", avatar: null, login: "ghopper" };

describe("mentionsIn", () => {
  it("finds whole tags only, including names with spaces", () => {
    expect(mentionsIn("@Ada Lovelace can you check this?", [ada, al, grace])).toEqual([ada]);
    expect(mentionsIn("ping @Al, and (@Grace)", [ada, al, grace])).toEqual([al, grace]);
    expect(mentionsIn("email al@Grace.com or @Alfred", [ada, al, grace])).toEqual([]);
  });

  it("caps the number of tagged members", () => {
    const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, avatar: null }));
    expect(mentionsIn(many.map((m) => `@${m.name}`).join(" "), many)).toHaveLength(MAX_MENTIONS);
  });
});

describe("mentionSegments", () => {
  it("highlights each tag and keeps the surrounding text", () => {
    expect(mentionSegments("Hi @Al and @Ada Lovelace!", [al, ada])).toEqual([
      { text: "Hi " }, { text: "@Al", mention: al }, { text: " and " }, { text: "@Ada Lovelace", mention: ada }, { text: "!" },
    ]);
  });

  it("leaves bodies without mentions untouched", () => {
    expect(mentionSegments("@Al is not tagged here", undefined)).toEqual([{ text: "@Al is not tagged here" }]);
    expect(mentionSegments("no tags", [al])).toEqual([{ text: "no tags" }]);
  });
});

describe("typing a mention", () => {
  it("reads the query at the caret", () => {
    expect(mentionQuery("Thanks @Ad", 10)).toEqual({ start: 7, query: "Ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("Thanks @Ada Lo", 14)).toEqual({ start: 7, query: "Ada Lo" });
    expect(mentionQuery("mail me@host", 12)).toBeNull();
    expect(mentionQuery("@Ada\nnext", 9)).toBeNull();
  });

  it("ranks name prefixes, then logins, then later words", () => {
    expect(mentionSuggestions([ada, al, grace], "a")).toEqual([ada, al]);
    expect(mentionSuggestions([ada, al, grace], "gh")).toEqual([grace]);
    expect(mentionSuggestions([ada, al, grace], "love")).toEqual([ada]);
    expect(mentionSuggestions([ada, al, grace], "zz")).toEqual([]);
  });

  it("replaces the partial tag with the full name", () => {
    expect(insertMention("Hi @Ad, look", 6, 3, "Ada Lovelace")).toEqual({ text: "Hi @Ada Lovelace, look", caret: 16 });
    expect(insertMention("Hi @Ad look", 6, 3, "Ada Lovelace")).toEqual({ text: "Hi @Ada Lovelace look", caret: 17 });
    expect(insertMention("Hi @A", 5, 3, "Al")).toEqual({ text: "Hi @Al ", caret: 7 });
  });
});
