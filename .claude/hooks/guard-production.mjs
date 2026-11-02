#!/usr/bin/env node
// PreToolUse hook: stop commands that act on the production deployment unless the agent
// confirms that the person it works for asked for that action in this session.
// It is a guard against accidents, not a security boundary.
import { readFileSync } from "node:fs";

const CONFIRM = "SHARPNER_PRODUCTION=confirmed";
const PRODUCTION = [
  [/\bwrangler\s+(deploy|rollback|publish)\b/, "deploys or rolls back the Worker"],
  [/\bwrangler\s+versions\s+(deploy|upload)\b/, "changes the deployed Worker versions"],
  [/\bwrangler\s+secret\b/, "changes production secrets"],
  [/\bwrangler\b[^;&|]*\s--remote\b/, "acts on remote D1, R2 or KV data"],
  [/\b(pnpm|npm|yarn|bun)\s+(run\s+)?deploy\b/, "applies remote D1 migrations and deploys the Worker"],
];

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const command = input?.tool_input?.command;
if (typeof command !== "string") process.exit(0);

// Quoted text is usually a search pattern or a message, not a command to run.
const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
const hit = PRODUCTION.find(([pattern]) => pattern.test(unquoted));
if (!hit || unquoted.includes(CONFIRM)) process.exit(0);

process.stderr.write(
  `Blocked: this command ${hit[1]} on production Sharpner.\n` +
    `Run it only if the person you work for asked for this action in this session.\n` +
    `If they did, run it again with "${CONFIRM}" before the production command,\n` +
    `for example: ${CONFIRM} pnpm deploy\n` +
    `Otherwise, use local state: omit --remote, or use the verify-sharpner skill.\n`,
);
process.exit(2);
