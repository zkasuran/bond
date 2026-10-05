import { test } from "node:test";
import assert from "node:assert/strict";
import { makeThinkStripper } from "./loop.js";

test("strips a full think block and keeps the answer", () => {
  const s = makeThinkStripper();
  const out = s.feed("<think>reasoning here</think>\n\nThe balance is 0.") + s.flush();
  assert.equal(out, "\n\nThe balance is 0.");
});

test("strips a think block split across many deltas", () => {
  const s = makeThinkStripper();
  const chunks = ["<th", "ink>plan", " the call", "</th", "ink>", "Answer", ": 5"];
  let out = "";
  for (const c of chunks) out += s.feed(c);
  out += s.flush();
  assert.equal(out, "Answer: 5");
});

test("passes through text with no think block", () => {
  const s = makeThinkStripper();
  const out = s.feed("just a plain answer") + s.flush();
  assert.equal(out, "just a plain answer");
});

test("emits nothing while inside an unterminated think block", () => {
  const s = makeThinkStripper();
  assert.equal(s.feed("<think>still thinking and never closed"), "");
  assert.equal(s.flush(), "");
});

test("holds back a split open tag until the next delta decides it", () => {
  const s = makeThinkStripper();
  assert.equal(s.feed("answer <thin"), "answer ");
  assert.equal(s.feed("k>hidden</think> done"), " done");
  assert.equal(s.flush(), "");
});
