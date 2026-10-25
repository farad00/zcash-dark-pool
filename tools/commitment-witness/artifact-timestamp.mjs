// Separate artifact-only workflow. Never signs, decrypts, publishes or calls a DB.
import { readFile, lstat, mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  canonical,
  exact,
  sha256,
} from "../../services/publication/profile.mjs";
import { WitnessStore } from "./store.mjs";
import { submitTimestamp } from "./core.mjs";
import { syntheticRecord } from "./synthetic.mjs";
import {
  requireSyntheticSigningFile,
  syntheticSigningCaptureValid,
  syntheticAcknowledgementValid,
} from "./synthetic-signing.mjs";
import { noLinks, durableWrite, clockPair } from "./operational.mjs";
import {
  artifactQueryBinding,
  generateArtifactQuery,
} from "./artifact-query.mjs";
import {
  ARTIFACT_LABELS,
  artifactTrust,
  checkArtifactTrust,
  verifyArtifactRfc3161,
} from "./artifact-rfc3161.mjs";

export const ARTIFACT_ACK_SHA256 =
  "cdcd869f517a516761607abe6000d72a54b406ca9915741a94bad84a70526c0a";
export const ARTIFACT_SUBMISSION_APPROVAL =
  "SUBMIT_SYNTHETIC_ARTIFACT_TSA_ONCE";
const PROFILE = "DARKPOOL_SYNTHETIC_ARTIFACT_TSA_V1";
const fail = () => {
  throw Error("ARTIFACT_OPERATION_REJECTED");
};
async function bytes(path, limit = 1048576) {
  await noLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > limit) fail();
  const b = await readFile(path);
  if (b.length > limit) fail();
  return b;
}
async function json(path) {
  const b = await bytes(path),
    text = new TextDecoder("utf-8", { fatal: true }).decode(b),
    value = JSON.parse(text);
  if (canonical(value) !== text) fail();
  return value;
}
async function exists(path) {
  await noLinks(path);
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export class ArtifactTimestamp {
  constructor(
    root,
    configFile,
    {
      trustFile,
      trustHash,
      clockA,
      clockB,
      fetch: fetcher = globalThis.fetch,
      now = Date.now,
    } = {},
  ) {
    this.root = resolve(root);
    this.configFile = resolve(configFile);
    this.trustFile = trustFile;
    this.trustHash =
      typeof trustHash === "string" ? trustHash.toLowerCase() : trustHash;
    this.clockA = clockA;
    this.clockB = clockB;
    this.fetch = fetcher;
    this.now = now;
    this.record = syntheticRecord();
    this.directory = join(
      this.root,
      "artifact-timestamps",
      this.record,
      ARTIFACT_ACK_SHA256,
    );
  }
  async original() {
    const configBytes = await bytes(this.configFile);
    requireSyntheticSigningFile(configBytes);
    const config = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(configBytes),
    );
    const store = new WitnessStore(this.root, config);
    const loaded = await store.loadCapture(this.record);
    syntheticSigningCaptureValid(
      config,
      loaded.key,
      loaded.capture,
      this.record,
    );
    const ackBytes = await store.bytes(
      join(loaded.path, "acknowledgement.json"),
      65536,
    );
    if (sha256(ackBytes) !== ARTIFACT_ACK_SHA256) fail();
    const ack = await store.json(join(loaded.path, "acknowledgement.json"));
    syntheticAcknowledgementValid(
      config,
      loaded.key,
      loaded.capture,
      this.record,
      ack,
    );
    const original_sha256 = { approved_configuration: sha256(configBytes) };
    for (const name of [
      "capture.json",
      "context.json",
      "envelope.json",
      "acknowledgement.json",
    ])
      original_sha256[name] = sha256(
        await store.bytes(join(loaded.path, name)),
      );
    for (const name of [
      "synthetic-sign-" + this.record + ".attempt.json",
      "synthetic-capture-90e83e50bcc9bdf54f1f2963d988be18a94262e4.attempt.json",
    ])
      if (await exists(join(this.root, name)))
        original_sha256[name] = sha256(await bytes(join(this.root, name)));
    return { config, capture: loaded.capture, ackBytes, original_sha256 };
  }
  async unchanged(original) {
    const fresh = await this.original();
    if (
      canonical(fresh.original_sha256) !== canonical(original.original_sha256)
    )
      fail();
  }
  async trust() {
    if (
      typeof this.trustHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(this.trustHash) ||
      !this.trustFile ||
      resolve(this.trustFile) === this.configFile
    )
      fail();
    const b = await bytes(resolve(this.trustFile));
    if (sha256(b) !== this.trustHash) fail();
    return artifactTrust(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)),
    );
  }
  async prerequisites(original) {
    const trust = await this.trust(),
      clocks = await clockPair(this.clockA, this.clockB, this.now());
    await checkArtifactTrust(
      trust,
      original.config.openssl,
      clocks,
      this.now(),
    );
    await this.unchanged(original);
    return { trust, clocks };
  }
  async locked(work) {
    await noLinks(this.root);
    if (await exists(join(this.root, "operation.lock"))) fail();
    const path = join(this.root, "artifact-timestamp.lock"),
      token = randomBytes(24).toString("hex");
    await durableWrite(path, Buffer.from(token));
    try {
      return await work();
    } finally {
      if ((await bytes(path)).toString() !== token) fail();
      await unlink(path); // Only our own normal-completion lock; never an attempt.
    }
  }
  async check() {
    await this.original();
    return {
      stage: "READ_ONLY_ARTIFACT_INPUTS",
      status: "PASS",
      ...ARTIFACT_LABELS,
    };
  }
  async prepared(original) {
    const plan = await json(join(this.directory, "preparation.json"));
    exact(plan, [
      "profile",
      "labels",
      "record",
      "binding",
      "original_sha256",
      "original_observed_at",
      "trust_sha256",
      "prepared_at",
    ]);
    const retained = await bytes(
        join(this.directory, "acknowledgement.bin"),
        65536,
      ),
      query = await bytes(join(this.directory, "request.tsq"), 65536);
    const binding = artifactQueryBinding(query, retained);
    if (
      !retained.equals(original.ackBytes) ||
      plan.profile !== PROFILE ||
      canonical(plan.labels) !== canonical(ARTIFACT_LABELS) ||
      plan.record !== this.record ||
      canonical(plan.binding) !== canonical(binding) ||
      plan.trust_sha256 !== this.trustHash ||
      canonical(plan.original_sha256) !== canonical(original.original_sha256) ||
      plan.original_observed_at !== original.capture.observed_at ||
      !Number.isFinite(Date.parse(plan.prepared_at))
    )
      fail();
    return { plan, query, binding };
  }
  async prepare() {
    return this.locked(async () => {
      const original = await this.original();
      await this.prerequisites(original);
      if (await exists(this.directory)) {
        const { binding } = await this.prepared(original);
        return {
          status: "ARTIFACT_REQUEST_RETAINED",
          ...binding,
          ...ARTIFACT_LABELS,
        };
      }
      await noLinks(this.directory);
      await mkdir(this.directory, { recursive: true });
      await durableWrite(
        join(this.directory, "acknowledgement.bin"),
        original.ackBytes,
      );
      const queryPath = join(this.directory, "request.tsq");
      await durableWrite(
        join(this.directory, "request-generation-attempt.json"),
        Buffer.from(
          canonical({
            profile: PROFILE,
            labels: ARTIFACT_LABELS,
            acknowledgement_sha256: ARTIFACT_ACK_SHA256,
          }),
        ),
      );
      // OpenSSL returns raw DER on an anonymous pipe. The file is written once,
      // with wx/fsync; partial preparation never regenerates a nonce on retry.
      const generated = await generateArtifactQuery(
        original.config.openssl,
        join(this.directory, "acknowledgement.bin"),
      );
      await durableWrite(queryPath, generated);
      const binding = artifactQueryBinding(
        await bytes(queryPath, 65536),
        original.ackBytes,
      );
      await this.unchanged(original);
      await durableWrite(
        join(this.directory, "preparation.json"),
        Buffer.from(
          canonical({
            profile: PROFILE,
            labels: ARTIFACT_LABELS,
            record: this.record,
            binding,
            original_sha256: original.original_sha256,
            original_observed_at: original.capture.observed_at,
            trust_sha256: this.trustHash,
            prepared_at: new Date(this.now()).toISOString(),
          }),
        ),
      );
      return {
        status: "ARTIFACT_REQUEST_PREPARED",
        ...binding,
        ...ARTIFACT_LABELS,
      };
    });
  }
  async submit(approval) {
    if (approval !== ARTIFACT_SUBMISSION_APPROVAL) fail();
    return this.locked(async () => {
      const original = await this.original(),
        { trust, clocks } = await this.prerequisites(original);
      const { query, binding } = await this.prepared(original);
      const marker = join(this.directory, "submission-attempt.json"),
        response = join(this.directory, "response.tsr");
      if ((await exists(marker)) || (await exists(response)))
        throw Error("ARTIFACT_SUBMISSION_RECONCILIATION_REQUIRED");
      // Recheck both fresh clock reports immediately before the irreversible POST.
      await clockPair(this.clockA, this.clockB, this.now());
      await this.unchanged(original);
      await durableWrite(
        marker,
        Buffer.from(
          canonical({
            profile: PROFILE,
            labels: ARTIFACT_LABELS,
            binding,
            trust_sha256: this.trustHash,
            clock_checks: clocks,
            endpoint: trust.endpoint,
            started_at: new Date(this.now()).toISOString(),
          }),
        ),
      );
      const reply = await submitTimestamp(query, { fetch: this.fetch }); // Exactly one call; never retry here.
      await durableWrite(response, reply);
      await this.unchanged(original);
      return {
        status: "ARTIFACT_RESPONSE_RETAINED_UNVERIFIED",
        reply_sha256: sha256(reply),
        ...ARTIFACT_LABELS,
      };
    });
  }
  async verify() {
    return this.locked(async () => {
      const original = await this.original(),
        { trust, clocks } = await this.prerequisites(original);
      const { query, binding, plan } = await this.prepared(original);
      const marker = await json(
        join(this.directory, "submission-attempt.json"),
      );
      exact(marker, [
        "profile",
        "labels",
        "binding",
        "trust_sha256",
        "clock_checks",
        "endpoint",
        "started_at",
      ]);
      if (
        marker.profile !== PROFILE ||
        canonical(marker.labels) !== canonical(ARTIFACT_LABELS) ||
        canonical(marker.binding) !== canonical(binding) ||
        marker.trust_sha256 !== this.trustHash ||
        marker.endpoint !== trust.endpoint
      )
        fail();
      const reply = await bytes(join(this.directory, "response.tsr"), 262144);
      const proof = await verifyArtifactRfc3161({
        query,
        reply,
        data: original.ackBytes,
        trust,
        executable: original.config.openssl,
        clock_checks: clocks,
        now: this.now(),
      });
      await this.unchanged(original);
      const evidence = {
        profile: PROFILE,
        ...ARTIFACT_LABELS,
        record: this.record,
        original_observed_at: original.capture.observed_at,
        original_sha256: original.original_sha256,
        trust_sha256: this.trustHash,
        preparation: plan,
        proof,
      };
      const target = join(this.directory, "artifact-evidence.json");
      if (await exists(target)) {
        const old = await json(target);
        exact(old, Object.keys(evidence));
        if (canonical(old) !== canonical(evidence)) fail();
      } else await durableWrite(target, Buffer.from(canonical(evidence)));
      return {
        status: "ARTIFACT_EXISTENCE_VERIFIED",
        evidence_sha256: sha256(await bytes(target)),
        ...ARTIFACT_LABELS,
      };
    });
  }
}
