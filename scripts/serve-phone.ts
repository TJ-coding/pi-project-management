/**
 * Serve the read-only project view until stopped (G13).
 *
 * Run detached so it outlives the pi session:
 *   node --experimental-strip-types scripts/serve-phone.ts
 * Prints the address to open on a phone. Ctrl+C (or SIGTERM) to stop.
 */
import { startPhoneServer, lanAddresses } from "../src/phone.ts";

const port = Number(process.env.PHONE_PORT ?? 0);
const handle = await startPhoneServer({ host: "0.0.0.0", port });
const addrs = await lanAddresses();

console.log(`Serving the read-only project view on port ${handle.port}.`);
console.log("");
console.log("Open this on your phone (same wifi):");
for (const address of addrs) console.log(`  http://${address}:${handle.port}/`);
console.log("");
console.log(`On this machine:  http://localhost:${handle.port}/`);
console.log("");
console.log("Read-only. Endpoints: / (page), /status (json), /text (plain).");
console.log("Press Ctrl+C to stop.");

const stop = (): void => {
  void handle.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Keep the process alive: the server holds the loop open, but this makes the
// intent explicit so the script never exits while the listener is up.
setInterval(() => {}, 1 << 30);
