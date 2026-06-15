// Per-request account resolution for the OpenAI/Anthropic proxy.
// Ports cmd/JoyCodeProxy/serve.go:125-171 (the resolver closure), adapted for
// the Cloudflare Pages serverless model.
//
// Differences from the Go resolver (deliberate):
//   - NO round-robin / transport pooling: serverless has no long-lived process
//     to hold a shared http.Transport, so the sharedTransport + MaxConnsPerHost
//     tuning (serve.go:101-123, 167) is dropped entirely.
//   - NO system-client fallback: the Go resolver returned `systemClient`
//     (constructed from auth.LoadFromSystem / CLI flags) when no DB account was
//     found (serve.go:126-131, 170). A Pages Function has no equivalent
//     system-credential source, so resolveAccount returns null instead and the
//     _middleware surfaces a 403/503.
//   - NO anthropic-pt-key injection: serve.go:146-148 copied the system client's
//     PtKey as AnthropicPtKey when userIDs matched. That cross-machine override
//     is handled at account configuration time in this port; the resolver only
//     selects which stored account to use.
//   - Timeout is applied by createJoyClient (DEFAULT_TIMEOUT setting), not here.

import type { Env, Account } from '../types';
import { createStore } from '../store/d1';

/**
 * Resolve the JoyCode account for an inbound proxy request.
 *
 * Resolution order (serve.go:132-169):
 *   1. Read `x-api-key` header; fall back to `Authorization: Bearer <token>`.
 *   2. If a key is present, try store.getAccountByToken(key) (api_token match),
 *      then store.getAccount(key as userId) (user_id match).
 *   3. Otherwise (and as a final fallback), use the default account.
 *   4. If nothing resolves, return null — the caller turns this into an error.
 *
 * Returns the decrypted Account (ptKey ready for createJoyClient) or null.
 */
export async function resolveAccount(request: Request, env: Env): Promise<Account | null> {
  const store = createStore(env.DB, env.PTKEY_ENC_KEY);

  // Step 1: extract the API key (serve.go:132-138).
  let key = request.headers.get('x-api-key') ?? '';
  if (!key) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      key = auth.slice(7).trim();
    }
  }

  // Step 2: token / userId lookup (serve.go:143-159).
  if (key) {
    const byToken = await store.getAccountByToken(key);
    if (byToken) return byToken;
    const byUserId = await store.getAccount(key);
    if (byUserId) return byUserId;
  }

  // Step 3: default account (serve.go:160-169).
  return store.getDefaultAccount();
}
