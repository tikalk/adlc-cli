// Run lease — strict single-writer guard for state-writing sessions (ADR-395).
// Local fast-path: runs/<run_id>/lease.json with TTL heartbeat semantics.
// A lease is valid while heartbeat_ts + ttl_seconds > now; a fresh lease held
// by another session blocks acquisition; an expired lease is taken over.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

const DEFAULT_TTL = Number(process.env.ADLC_WORKFLOW_LEASE_TTL || 900);

export class LeaseHeldError extends Error {
  constructor(runId, lease) {
    super(
      `Run '${runId}' is locked by ${lease.holder} (lease valid until ` +
      `${new Date(lease.heartbeat_ts + lease.ttl_seconds * 1000).toISOString()}). ` +
      `Halting to prevent dual-write. Retry after the holder exits or the lease expires.`,
    );
    this.name = "LeaseHeldError";
    this.lease = lease;
  }
}

export class Lease {
  constructor(runDir, { runId = "", ttlSeconds = DEFAULT_TTL } = {}) {
    this.runDir = runDir;
    this.runId = runId;
    this.ttlSeconds = ttlSeconds;
    this.path = join(runDir, "lease.json");
    // Session identity (ADR-395): when ADLC_WORKFLOW_SESSION is set (the
    // in-session LLM executor exports it once), the holder is that session
    // id and the lease persists across sequential CLI invocations. Without
    // it, each invocation is its own session — helpers take a command-scoped
    // lock (acquire → write → release), which still blocks concurrent
    // writers while letting sequential commands through.
    this.sessionScoped = Boolean((process.env.ADLC_WORKFLOW_SESSION || "").trim());
    this.holder = this.sessionScoped
      ? `session:${(process.env.ADLC_WORKFLOW_SESSION || "").trim()}`
      : `${hostname()}:${process.pid}`;
  }

  // Command-scoped (non-session) helpers release at the end of each command.
  get persistent() {
    return this.sessionScoped;
  }

  read() {
    if (!existsSync(this.path)) return null;
    try {
      const lease = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof lease === "object" && lease !== null && typeof lease.holder === "string") {
        return lease;
      }
    } catch {
      // Corrupt lease file: treat as absent (crash mid-write).
    }
    return null;
  }

  isValid(lease = this.read()) {
    if (lease === null) return false;
    return lease.heartbeat_ts + lease.ttl_seconds * 1000 > Date.now();
  }

  heldByOther(lease = this.read()) {
    return lease !== null && lease.holder !== this.holder && this.isValid(lease);
  }

  // Acquire the lease. Throws LeaseHeldError when a fresh lease is held by
  // another session; renews our own; takes over an expired one.
  acquire() {
    const existing = this.read();
    if (this.heldByOther(existing)) {
      throw new LeaseHeldError(this.runId, existing);
    }
    this._write();
    return this.holder;
  }

  renew() {
    const existing = this.read();
    if (existing !== null && existing.holder !== this.holder && this.isValid(existing)) {
      throw new LeaseHeldError(this.runId, existing);
    }
    this._write();
  }

  // Release only our own lease (a fresh foreign lease is never clobbered).
  release() {
    const existing = this.read();
    if (existing === null || existing.holder !== this.holder) return false;
    try {
      unlinkSync(this.path);
    } catch {}
    return true;
  }

  _write() {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({
      run_id: this.runId,
      holder: this.holder,
      heartbeat_ts: Date.now(),
      ttl_seconds: this.ttlSeconds,
      pid: process.pid,
      hostname: hostname(),
    }, null, 2));
  }
}
