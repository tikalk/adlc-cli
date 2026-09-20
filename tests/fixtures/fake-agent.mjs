// Fake agent for runTask tests: prints two JSONL lines, exits 7.
process.stdout.write(JSON.stringify({ type: "message", content: "hello from fake agent" }) + "\n");
process.stdout.write(JSON.stringify({ type: "complete" }) + "\n");
process.exit(7);
