import type { Env } from '../src/types';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  let db = 'unknown';
  try {
    await env.DB.prepare('SELECT 1').first();
    db = 'ok';
  } catch (e) {
    db = (e as Error).message;
  }
  return Response.json({ status: 'ok', db, time: new Date().toISOString() });
};
