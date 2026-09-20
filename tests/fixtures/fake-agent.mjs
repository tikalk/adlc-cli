// Fake agent for runTask tests: emits real opencode event shapes, exits 7.
process.stdout.write(JSON.stringify({ type: "step_start", part: { type: "step-start" } }) + "\n");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "hello from fake agent" } }) + "\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }) + "\n");
process.exit(7);
