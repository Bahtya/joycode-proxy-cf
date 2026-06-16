// GET /api/availability — last 60 minutes of upstream availability samples
// (written by the keepalive cron's 1-min probe) for the dashboard availability card.
// JWT-gated by functions/api/_middleware.ts. The frontend computes the
// availability rate = green frames / 60 from `samples`.
import type { Env } from '../../src/types';
import { createStore } from '../../src/store/d1';

const FRAMES = 60;

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);
  const samples = await store.getAvailabilitySamples();
  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const chatSamples = samples.filter((s) => s.chat_ms > 0);
  const pingSamples = samples.filter((s) => s.ping_ms > 0);
  return Response.json({
    samples,
    avg_chat_ms: avg(chatSamples.map((s) => s.chat_ms)),
    avg_ping_ms: avg(pingSamples.map((s) => s.ping_ms)),
    last: samples.length ? samples[samples.length - 1] : null,
    green: samples.filter((s) => s.ok === 1).length, // convenience; rate = green/FRAMES on the client
    frames: FRAMES,
  });
};
