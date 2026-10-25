// Local append-only workflow; private encrypted key is NEVER part of archive exports.
import { open, mkdir, lstat, readFile, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  canonical,
  envelopeBytes,
  sha256,
  hex,
} from "../../services/publication/profile.mjs";
import { openssl, hasNonce } from "../../services/publication/verify.mjs";
import {
  syntheticSigningSettings,
  syntheticSigningCaptureValid,
  acknowledgeSynthetic,
  syntheticAcknowledgementValid,
  requireSyntheticArchive,
} from "./synthetic-signing.mjs";
import {
  MODE,
  fail,
  newKey,
  identity,
  observe,
  captureOnlyValid,
  captureSettings,
  acknowledge,
  acknowledgementValid,
  submitTimestamp,
  checkBundle,
  settings,
} from "./core.mjs";
export const EXPORTS = [
  "capture.json",
  "envelope.json",
  "acknowledgement.json",
  "timestamp.tsq",
  "timestamp.tsr",
  "publication-evidence.json",
  "context.json",
];
export class WitnessStore {
  constructor(
    root,
    configuration,
    { protect, unprotect, fetch: fetcher = globalThis.fetch, operational } = {},
  ) {
    this.root = resolve(root);
    this.config = configuration;
    this.protect = protect;
    this.unprotect = unprotect;
    this.fetch = fetcher;
    this.operational = operational;
  }
  async before(action, record) {
    hex(record, 32); // Never retain arbitrary caller strings in the audit.
    if (
      this.config.trust.evidence_class === "EXTERNAL" &&
      (typeof this.operational?.before !== "function" ||
        typeof this.operational?.verification !== "function")
    )
      fail();
    await this.operational?.before(
      action,
      record,
      sha256(Buffer.from(canonical(this.config))),
    );
  }
  async verificationEvidence() {
    if (
      this.config.trust.evidence_class === "EXTERNAL" &&
      typeof this.operational?.verification !== "function"
    )
      fail();
    return (await this.operational?.verification()) ?? {};
  }
  async safe(path) {
    path = resolve(path);
    if (
      path !== this.root &&
      !path.startsWith(this.root + "/") &&
      !path.startsWith(this.root + "\\")
    )
      fail();
    for (let p = path; ; p = dirname(p)) {
      try {
        if ((await lstat(p)).isSymbolicLink()) fail();
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (dirname(p) === p) break;
    }
    return path;
  }
  async bytes(path, limit = 1048576) {
    await this.safe(path);
    const s = await lstat(path);
    if (!s.isFile() || s.size < 1 || s.size > limit) fail();
    return readFile(path);
  }
  async json(path) {
    const b = await this.bytes(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(b),
      v = JSON.parse(text);
    if (canonical(v) !== text) fail();
    return v;
  }
  async exists(path) {
    try {
      await this.safe(path);
      await lstat(path);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
  async save(path, bytes) {
    await this.safe(path);
    const h = await open(path, "wx", 0o600);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
  }
  async saveJson(path, v) {
    return this.save(path, Buffer.from(canonical(v)));
  }
  async locked(work) {
    await this.safe(this.root);
    const lock = join(this.root, "operation.lock"),
      token = randomBytes(24).toString("hex");
    await this.save(lock, Buffer.from(token));
    try {
      return await work();
    } finally {
      if ((await this.bytes(lock)).toString() !== token) fail();
      await unlink(lock);
    }
  }
  key() {
    return this.json(join(this.root, "keys", "witness-key.json"));
  }
  record(id) {
    hex(id, 32);
    return join(this.root, "archive", id);
  }
  async initKey() {
    return this.locked(async () => {
      const path = join(this.root, "keys", "witness-key.json");
      if (await this.exists(path)) return this.publicIdentity();
      const key = await newKey(this.protect);
      await this.saveJson(path, key);
      return this.publicIdentity();
    });
  }
  async publicIdentity() {
    const key = await this.key();
    return {
      mode: MODE,
      witness_id: identity(key),
      witness_spki: key.public_spki,
      financial_authorization: false,
    };
  }
  async capture(request) {
    return this.locked(async () => {
      const key = await this.key(),
        c = captureSettings(this.config, request),
        id = sha256(Buffer.from(request.envelope.market_id)),
        path = this.record(id);
      await this.before("CAPTURE", id);
      if (await this.exists(path)) {
        const old = (await this.loadCapture(id)).capture;
        captureOnlyValid(c, key, old);
        if (
          canonical(old.request) !== canonical(request) ||
          !(await this.bytes(join(path, "envelope.json"))).equals(
            envelopeBytes(old.request.envelope),
          )
        )
          fail();
        return {
          record: id,
          archive_url: old.archive_url,
          mode: MODE,
          retry: true,
          financial_authorization: false,
        };
      }
      const captured = await observe(c, key, request, { fetch: this.fetch });
      await this.safe(path);
      await mkdir(path);
      await this.saveJson(join(path, "capture.json"), captured);
      await this.save(
        join(path, "envelope.json"),
        envelopeBytes(captured.request.envelope),
      );
      await this.saveJson(join(path, "context.json"), {
        mode: MODE,
        third_party_independence: "NO",
        repository_id: c.destination.repository_id,
        branch: c.destination.branch,
        witness_id: captured.witness_id,
        financial_authorization: "NOT_AUTHORIZED",
      });
      return {
        record: id,
        archive_url: captured.archive_url,
        mode: MODE,
        retry: false,
        financial_authorization: false,
      };
    });
  }
  async load(id) {
    settings(this.config); // Never load unavailable-trust observations for signing/receipts.
    return this.loadCapture(id);
  }
  async loadCapture(id) {
    const path = this.record(id),
      key = await this.key(),
      capture = await this.json(join(path, "capture.json"));
    captureOnlyValid(this.config, key, capture);
    const context = await this.json(join(path, "context.json"));
    if (
      canonical(context) !==
      canonical({
        mode: MODE,
        third_party_independence: "NO",
        repository_id: this.config.destination.repository_id,
        branch: this.config.destination.branch,
        witness_id: capture.witness_id,
        financial_authorization: "NOT_AUTHORIZED",
      })
    )
      fail();
    if (
      sha256(Buffer.from(capture.request.envelope.market_id)) !== id ||
      !(await this.bytes(join(path, "envelope.json"))).equals(
        envelopeBytes(capture.request.envelope),
      )
    )
      fail();
    return { path, key, capture };
  }
  async sign(id) {
    const synthetic = this.config.trust.status === "UNAVAILABLE";
    if (synthetic) syntheticSigningSettings(this.config, id);
    return this.locked(async () => {
      const { path, key, capture } = synthetic
          ? await this.loadCapture(id)
          : await this.load(id),
        file = join(path, "acknowledgement.json");
      if (synthetic)
        syntheticSigningCaptureValid(this.config, key, capture, id);
      await this.before("SIGN", id);
      if (await this.exists(file)) {
        const ack = await this.json(file); // Partial/noncanonical files are preserved.
        if (synthetic) {
          syntheticAcknowledgementValid(this.config, key, capture, id, ack);
          await requireSyntheticArchive(
            this.config,
            key,
            capture,
            id,
            this.fetch,
          );
          await this.before("SIGN", id);
        } else acknowledgementValid(this.config, key, capture, ack);
      } else
        await this.saveJson(
          file,
          synthetic
            ? await acknowledgeSynthetic(
                this.config,
                key,
                capture,
                id,
                this.unprotect,
                {
                  fetch: this.fetch,
                  beforeSign: () => this.before("SIGN", id),
                },
              )
            : await acknowledge(this.config, key, capture, this.unprotect, {
                fetch: this.fetch,
              }),
        );
      return {
        record: id,
        mode: MODE,
        status: synthetic
          ? "SYNTHETIC_ACKNOWLEDGEMENT_RETAINED"
          : "ACKNOWLEDGEMENT_RETAINED",
        ...(synthetic
          ? {
              scope: "SYNTHETIC_TEST_ONLY",
              third_party_independence: false,
              authorization_status: "NOT_GRANTED",
            }
          : {}),
        financial_authorization: false,
      };
    });
  }
  async query(id) {
    return this.locked(async () => {
      const { path, key, capture } = await this.load(id),
        ack = await this.json(join(path, "acknowledgement.json"));
      acknowledgementValid(this.config, key, capture, ack);
      await this.before("QUERY", id);
      const file = join(path, "timestamp.tsq");
      if (!(await this.exists(file))) {
        // Reserve before invoking OpenSSL: crashes/partial files fail closed, never regenerate silently.
        await this.save(file, Buffer.alloc(0));
        await openssl(this.config.openssl, [
          "ts",
          "-query",
          "-data",
          join(path, "acknowledgement.json"),
          "-sha256",
          "-cert",
          "-tspolicy",
          this.config.trust.tsa_policy_oid,
          "-out",
          file,
        ]);
      }
      const text = await openssl(this.config.openssl, [
        "ts",
        "-query",
        "-in",
        file,
        "-text",
      ]);
      if (!hasNonce(text) || !/^Hash Algorithm: sha256$/m.test(text)) fail();
      // OpenSSL closes its output, but durable ordering needs an explicit flush
      // before retaining the query binding or allowing any submission.
      const retainedQuery = await open(file, "r+");
      try {
        await retainedQuery.sync();
      } finally {
        await retainedQuery.close();
      }
      const binding = {
        query_sha256: sha256(await this.bytes(file, 65536)),
        acknowledgement_sha256: sha256(Buffer.from(canonical(ack))),
      };
      const retained = join(path, "timestamp-query.json");
      if (await this.exists(retained)) {
        if (canonical(await this.json(retained)) !== canonical(binding)) fail();
      } else await this.saveJson(retained, binding);
      return {
        record: id,
        status: "ORIGINAL_QUERY_RETAINED",
        mode: MODE,
        financial_authorization: false,
      };
    });
  }
  async finish(id) {
    const { path, key, capture } = await this.load(id),
      ack = await this.json(join(path, "acknowledgement.json"));
    acknowledgementValid(this.config, key, capture, ack);
    const bundle = {
      envelope: (await this.bytes(join(path, "envelope.json"))).toString(
        "base64",
      ),
      ...ack,
      tsq: (await this.bytes(join(path, "timestamp.tsq"))).toString("base64"),
      tsr: (await this.bytes(join(path, "timestamp.tsr"))).toString("base64"),
    };
    const q = await this.json(join(path, "timestamp-query.json"));
    if (
      q.query_sha256 !== sha256(Buffer.from(bundle.tsq, "base64")) ||
      q.acknowledgement_sha256 !== sha256(Buffer.from(canonical(ack)))
    )
      fail();
    await checkBundle(this.config, capture, bundle, {
      fetch: this.fetch,
      ...(await this.verificationEvidence()),
    });
    const file = join(path, "publication-evidence.json");
    if (await this.exists(file)) {
      if (canonical(await this.json(file)) !== canonical(bundle)) fail();
    } else await this.saveJson(file, bundle);
    return {
      record: id,
      status: "BUNDLE_CRYPTOGRAPHICALLY_VERIFIED",
      mode: MODE,
      third_party_independence: false,
      financial_authorization: false,
    };
  }
  async timestamp(id, approved = false) {
    return this.locked(async () => {
      const { path } = await this.load(id),
        reply = join(path, "timestamp.tsr");
      await this.before("TIMESTAMP", id);
      if (await this.exists(reply)) return this.finish(id);
      if (!approved) fail();
      // Both time reports and the audit sink must be available BEFORE a POST.
      await this.verificationEvidence();
      const attempt = join(path, "timestamp-attempt.json");
      if (await this.exists(attempt))
        throw new Error("WITNESS_TSA_RECONCILIATION_REQUIRED");
      const query = await this.bytes(join(path, "timestamp.tsq"), 65536);
      const ack = await this.json(join(path, "acknowledgement.json"));
      const loaded = await this.load(id);
      acknowledgementValid(this.config, loaded.key, loaded.capture, ack);
      if (
        Date.now() >
        Date.parse(loaded.capture.observed_at) +
          this.config.trust.max_witness_lag_seconds * 1000
      )
        fail();
      const q = await this.json(join(path, "timestamp-query.json"));
      if (
        q.query_sha256 !== sha256(query) ||
        q.acknowledgement_sha256 !== sha256(Buffer.from(canonical(ack)))
      )
        fail();
      await this.saveJson(attempt, {
        tsq_sha256: sha256(query),
        endpoint: "https://freetsa.org/tsr",
        started_at: new Date().toISOString(),
      });
      const bytes = await submitTimestamp(query, { fetch: this.fetch });
      await this.save(reply, bytes);
      return this.finish(id);
    });
  }
  async verify(id) {
    return this.locked(async () => {
      await this.before("VERIFY", id);
      return this.finish(id);
    });
  }
  async export(id) {
    return this.locked(async () => {
      await this.before("EXPORT", id);
      await this.finish(id);
      const from = this.record(id),
        to = join(this.root, "exports", id);
      if (await this.exists(to)) fail();
      await this.safe(to);
      await mkdir(to);
      for (const name of EXPORTS) {
        const bytes = await this.bytes(join(from, name));
        await this.save(join(to, name), bytes);
      }
      return {
        record: id,
        status: "PUBLIC_EVIDENCE_EXPORTED",
        mode: MODE,
        financial_authorization: false,
      };
    });
  }
}
